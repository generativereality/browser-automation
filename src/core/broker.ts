// The pipe broker: owns Chrome's DevTools pipe and serves it to this OS user only.
//
// # Why there is a process at all
//
// Chrome's `--remote-debugging-port` has no authentication: anything on the
// machine that can open a TCP connection to localhost can drive the browser,
// with every login in its profile. `--remote-debugging-pipe` opens no port —
// Chrome talks over file descriptors 3 and 4, to the process that started it and
// nobody else. But the CLI is daemonless: every command is a new process, and a
// new process cannot inherit a pipe from one that has already exited. So
// something has to hold the pipe for as long as Chrome runs. This is that
// something, and it does as little as possible:
//
//   * it starts Chrome, as its own child, with the pipe;
//   * it listens on a Unix socket in a 0700 directory under ~, itself 0600, so
//     the filesystem decides who may connect: this OS user, nobody else;
//   * each connection names one target (or the browser) in its first line; the
//     broker attaches a CDP session to that target and relays the connection's
//     messages to it and that session's messages back, and detaches when the
//     connection closes.
//
// That last point is what keeps the CLI's model intact: one short connection per
// command, bound to one tab, exactly as with a per-tab WebSocket. Ids are
// rewritten on the way in, so concurrent connections cannot collide; events are
// routed by session, so they cannot cross.
//
// Chrome exits when its pipe closes (measured on Chrome 155: ~1.8s, exit code
// 0, profile flushed), so the broker going away takes the browser with it
// cleanly rather than leaving one nobody can reach.

import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export interface BrokerOptions {
  chrome: string
  profile: string
  socket: string
  /** Chrome's stdout/stderr — renderer-health reads it for the reason a renderer died. */
  log: string
  /** Extra Chrome flags, after ours. */
  extraArgs?: string[]
}

export interface BrokerState {
  brokerPid: number
  chromePid: number
  profile: string
  socket: string
  startedAt: string
}

export function statePath(socket: string): string {
  return join(dirname(socket), 'broker.json')
}

/** The flags Chrome is started with. The profile flag is also how `ps` finds it. */
export function chromeArgs(profile: string, extra: string[] = []): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...extra,
    'about:blank',
  ]
}

/** Does something answer on this socket? Connect-and-close; no CDP. */
export function socketAnswers(socket: string, timeout = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(socket)
    const t = setTimeout(() => { s.destroy(); resolve(false) }, timeout)
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true) })
    s.on('error', () => { clearTimeout(t); resolve(false) })
  })
}

type Client = { sock: Socket; sessionId: string | null; browser: boolean }

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Become the one broker for this directory, or learn that another one is. Two
 * `launch` runs at once (two tabs both finding no browser) each start a broker,
 * and before either listens, the socket check below passes for both: both then
 * spawn Chrome on the same profile, one Chrome hands off to the other through
 * the profile lock and exits, and one broker's listen fails. An O_EXCL pid file
 * taken before Chrome is spawned leaves exactly one. A lock whose pid is gone
 * was left by a broker that died, and is taken over.
 */
function takeLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      writeFileSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return true
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number.parseInt(readFileSync(lock, 'utf8'), 10)
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return false
      rmSync(lock, { force: true })
    }
  }
  return false
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runBroker(o: BrokerOptions): Promise<void> {
  // Everything this creates is for this user only, whatever the umask says.
  process.umask(0o077)
  const dir = dirname(o.socket)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const lock = join(dir, 'broker.lock')
  if (!takeLock(lock)) {
    // Another broker is starting or running here. Wait until it serves, then
    // leave the browser to it: the launch that started us finds it on the socket.
    for (let i = 0; i < 240; i++) {
      if (await socketAnswers(o.socket)) return
      await sleep(250)
    }
    throw new Error(`another broker holds ${lock}, but nothing answered on ${o.socket} within 60s`)
  }
  const releaseLock = () => {
    try { if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock, { force: true }) } catch {}
  }
  try {
    await serve(o, releaseLock)
  } finally {
    releaseLock()
  }
}

async function serve(o: BrokerOptions, releaseLock: () => void): Promise<void> {
  if (existsSync(o.socket)) {
    if (await socketAnswers(o.socket)) throw new Error(`a broker is already serving ${o.socket}`)
    rmSync(o.socket, { force: true }) // left behind by one that died
  }

  const logFd = openSync(o.log, 'a', 0o600)
  const chrome = spawn(o.chrome, chromeArgs(o.profile, o.extraArgs), {
    stdio: ['ignore', logFd, logFd, 'pipe', 'pipe'],
  })
  closeSync(logFd)
  const toChrome = chrome.stdio[3] as Writable
  const fromChrome = chrome.stdio[4] as Readable

  // ── Ids and routing ──────────────────────────────────────────────────────
  let nextId = 1
  // A command from a client, by the id we gave it: whose it was and its own id.
  const relayed = new Map<number, { client: Client; id: number }>()
  // A command of our own (attach/detach), by id.
  const own = new Map<number, (msg: any) => void>()
  const bySession = new Map<string, Client>()
  const clients = new Set<Client>()
  // Every open connection, attached yet or not: cleanup hangs up on all of them.
  const socks = new Set<Socket>()

  const toPipe = (msg: object) => toChrome.write(JSON.stringify(msg) + '\0')
  const ask = (method: string, params: object): Promise<any> =>
    new Promise((resolve) => {
      const id = nextId++
      own.set(id, resolve)
      toPipe({ id, method, params })
    })
  const tell = (c: Client, msg: object) => {
    if (!c.sock.destroyed) c.sock.write(JSON.stringify(msg) + '\n')
  }

  let buf = ''
  fromChrome.setEncoding('utf8')
  fromChrome.on('data', (chunk: string) => {
    buf += chunk
    let end: number
    while ((end = buf.indexOf('\0')) >= 0) {
      const raw = buf.slice(0, end)
      buf = buf.slice(end + 1)
      let msg: any
      try { msg = JSON.parse(raw) } catch { continue }
      if (typeof msg.id === 'number') {
        const mine = own.get(msg.id)
        if (mine) { own.delete(msg.id); mine(msg); continue }
        const r = relayed.get(msg.id)
        if (!r) continue
        relayed.delete(msg.id)
        const { sessionId: _drop, ...rest } = msg
        tell(r.client, { ...rest, id: r.id })
        continue
      }
      if (msg.sessionId) {
        const c = bySession.get(msg.sessionId)
        if (c) tell(c, { method: msg.method, params: msg.params })
        continue
      }
      // Browser-level event. A session ending means its tab is gone: hang up on
      // the connection that held it, as Chrome closes a closed tab's WebSocket.
      if (msg.method === 'Target.detachedFromTarget') {
        const c = bySession.get(msg.params?.sessionId)
        if (c) { bySession.delete(msg.params.sessionId); c.sessionId = null; c.sock.end() }
      }
      for (const c of clients) if (c.browser) tell(c, { method: msg.method, params: msg.params })
    }
  })

  // ── The socket ───────────────────────────────────────────────────────────
  const server = createServer((sock) => {
    socks.add(sock)
    sock.on('close', () => socks.delete(sock))
    const c: Client = { sock, sessionId: null, browser: false }
    let attached = false
    let pending = ''
    sock.setEncoding('utf8')
    sock.on('data', async (chunk: string) => {
      pending += chunk
      let nl: number
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        let msg: any
        try { msg = JSON.parse(line) } catch { sock.destroy(); return }
        if (!attached) {
          attached = true
          sock.pause()
          if (msg.attach === 'browser') {
            c.browser = true
          } else if (msg.attach === 'target' && typeof msg.targetId === 'string') {
            const r = await ask('Target.attachToTarget', { targetId: msg.targetId, flatten: true })
            // The connection can close while the attach is in flight (a CLI connect
            // timeout against a slow Chrome). `gone()` has then already run and found
            // nothing to undo, so registering it now would leak the session.
            if (sock.destroyed) {
              if (!r.error) toPipe({ id: nextId++, method: 'Target.detachFromTarget', params: { sessionId: r.result.sessionId } })
              return
            }
            if (r.error) {
              tell(c, { error: `target ${msg.targetId}: ${r.error.message}` })
              sock.end()
              return
            }
            c.sessionId = r.result.sessionId
            bySession.set(c.sessionId!, c)
          } else {
            tell(c, { error: 'first line must be {"attach":"browser"} or {"attach":"target","targetId":…}' })
            sock.end()
            return
          }
          clients.add(c)
          tell(c, { attached: true })
          sock.resume()
          continue
        }
        if (typeof msg.id !== 'number' || typeof msg.method !== 'string') continue
        const id = nextId++
        relayed.set(id, { client: c, id: msg.id })
        toPipe({ id, method: msg.method, params: msg.params ?? {}, ...(c.sessionId ? { sessionId: c.sessionId } : {}) })
      }
    })
    const gone = () => {
      if (!clients.delete(c)) return
      for (const [id, r] of relayed) if (r.client === c) relayed.delete(id)
      if (c.sessionId) {
        bySession.delete(c.sessionId)
        toPipe({ id: nextId++, method: 'Target.detachFromTarget', params: { sessionId: c.sessionId } })
      }
    }
    sock.on('close', gone)
    sock.on('error', gone)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.socket, () => resolve())
  })
  chmodSync(o.socket, 0o600)

  const state: BrokerState = {
    brokerPid: process.pid,
    chromePid: chrome.pid ?? -1,
    profile: o.profile,
    socket: o.socket,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(statePath(o.socket), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })

  const cleanup = () => {
    server.close()
    // Hang up on every connection now, so a command mid-request fails as "connection
    // closed" at once instead of waiting out its own send timeout, and so open
    // sockets don't keep this process alive.
    for (const s of socks) s.destroy()
    rmSync(o.socket, { force: true })
    rmSync(statePath(o.socket), { force: true })
    releaseLock()
  }

  // Asked to stop: quit Chrome the way its menu does, so it flushes the profile.
  // Its exit then ends us. If it will not go, close the pipe — it exits on that.
  const stop = () => {
    toPipe({ id: nextId++, method: 'Browser.close', params: {} })
    setTimeout(() => toChrome.end(), 10_000).unref()
    setTimeout(() => chrome.kill('SIGKILL'), 20_000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  await new Promise<void>((resolve) => {
    chrome.on('exit', () => resolve())
    chrome.on('error', (e) => {
      appendFileSync(o.log, `browser-automation broker: could not start ${o.chrome}: ${e.message}\n`)
      resolve()
    })
  })
  cleanup()
}
