// Daemonless, per-target Chrome DevTools Protocol client.
//
// Two transports, one shape. By default Chrome is started with
// `--remote-debugging-pipe` by a small broker (core/broker.ts) that owns the pipe
// and serves it to this OS user only: on a Unix socket in a 0700 directory
// (macOS, Linux), or on a named pipe with a random name that only this user's
// state file records (Windows). Chrome then listens on no port at all. That holds
// for login contexts too, each behind its own broker. Only with
// `BROWSER_AUTOMATION_CDP` set is it the old TCP port. Either way each command still opens its own short connection to ONE
// target and closes it — over the socket, that connection is a CDP session the
// broker attaches for it and detaches when it goes.
//
// Every operation opens a short-lived WebSocket to ONE target (a single tab's
// `webSocketDebuggerUrl`, or the browser endpoint for tab create/close), runs
// its commands, and closes. There is no long-lived process and no
// whole-browser `connectOverCDP` enumeration — so a stuck iframe/worker can't
// wedge us, and parallel sessions never share a connection (no id collisions,
// no event cross-talk). Isolation comes from each session only ever touching
// its own targetId; we never call Target.activateTarget / Page.bringToFront,
// so we never steal focus from the user or from sibling sessions.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activeContext, contextsDir } from './context-store.js'

// The debugging port is PER-USER, and that is not a nicety.
//
// `127.0.0.1` is machine-wide, not per-account, and Chrome's DevTools protocol
// has no authentication — so with one hardcoded port, the first macOS account
// to `launch` owns it and **every other account's automation silently drives
// that account's browser**. Reported 2026-08-08: an app running as a second
// user drove the first user's Chrome all day, reporting page loads it had
// genuinely performed, in somebody else's session. Nothing errors; the tab just
// opens in the wrong place, and on a real task that place is signed into
// somebody's bank.
//
// So the port is derived from the uid. The first human account on the platform
// keeps 9223 — the overwhelmingly common single-user case is unchanged, and an
// upgrade does not orphan a Chrome that is already running — and everybody else
// gets 9224, 9225, and so on.
const BASE_PORT = 9223
// The uid the platform hands its first human account. Everything below it is
/// a system account, which will not be running a headed Chrome.
const FIRST_HUMAN_UID = process.platform === 'darwin' ? 501 : 1000

/**
 * The CDP port for THIS user.
 *
 * `BROWSER_AUTOMATION_PORT` overrides it, for the cases a formula cannot know
 * about: a shared CI box, a container, or somebody who simply wants two.
 *
 * **This is the only place the number is decided.** It was copied into
 * `scripts/launch-chrome.sh` within an hour of being written, each copy with a
 * comment promising to keep it in step — which is the tell, not the plan. The
 * script asks `browser-automation port` instead, and the `port` command exists
 * for exactly that.
 */
export function cdpPort(): number {
  // A login context is its own Chrome on its own port (core/context-store.ts).
  // It wins over everything below: the entry point set it because THIS
  // command is for that Chrome.
  const ctx = activeContext()
  if (ctx) return ctx.port
  const explicit = Number(process.env.BROWSER_AUTOMATION_PORT)
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) return explicit
  const uid = typeof process.getuid === 'function' ? process.getuid() : FIRST_HUMAN_UID
  const offset = uid - FIRST_HUMAN_UID
  // A uid outside the ordinary human range (a system account, or a directory
  // service handing out five-digit ids) still gets its own port rather than
  // sharing one. Deterministic, and `BROWSER_AUTOMATION_PORT` is the way out if
  // two of them ever land on the same number.
  if (offset < 0 || offset > 499) return BASE_PORT + 500 + (uid % 500)
  return BASE_PORT + offset
}

export function cdpHost(): string {
  // A context's Chrome is always local, on the port it was given, whatever
  // BROWSER_AUTOMATION_CDP says about the user's own Chrome.
  if (activeContext()) return `http://localhost:${cdpPort()}`
  return process.env.BROWSER_AUTOMATION_CDP || `http://localhost:${cdpPort()}`
}

/**
 * Pipe or port.
 *
 * The port is reachable by every process on the machine and has no
 * authentication, so anything local could drive this user's signed-in browser.
 * The pipe is not reachable at all except through the broker's socket, which
 * lives in a 0700 directory under ~ and is itself 0600.
 *
 * Port stays only where somebody asked for it: `BROWSER_AUTOMATION_CDP` names one
 * explicitly (a browser somebody else started, the test fakes). It does not
 * apply to a login context, which is always this CLI's own Chrome, on its own
 * broker. Windows and contexts were on the port until 0.7.0.
 */
export function usesPipe(): boolean {
  if (activeContext()) return true
  return !process.env.BROWSER_AUTOMATION_CDP
}

function baseDir(): string {
  return process.env.BROWSER_AUTOMATION_HOME || join(homedir(), '.browser-automation')
}

/**
 * The broker's directory: state file, lock, broker and Chrome logs, and (macOS,
 * Linux) the socket. 0700. A login context's is its own folder, beside its profile.
 */
export function brokerDir(): string {
  const ctx = activeContext()
  return ctx ? join(contextsDir(), ctx.name) : baseDir()
}

/** The state file a broker writes once it serves: pids, profile, and where it listens. */
export function brokerStatePath(dir = brokerDir()): string {
  return join(dir, 'broker.json')
}

/**
 * Where the broker for the active Chrome listens.
 *
 * macOS and Linux: a Unix socket in the broker's 0700 directory. Its path is
 * capped at 104 bytes on macOS, and a context's folder can be longer than that
 * allows (a 64-character name), so a long one gets a short socket in a 0700
 * folder of its own, named after the directory it stands for.
 *
 * Windows: a named pipe. Named pipes have no directory to protect them, so the
 * broker picks a random name when it starts and records it in its state file,
 * which only this user can read. Nobody else can guess the name, so nobody can
 * create it first and wait for us to connect, and the pipe's default ACL keeps
 * other accounts from opening it for writing. Measured on Windows 11 ARM64
 * (Node 22, 2026-10-27): full control for this user, SYSTEM and Administrators;
 * Read only for Everyone and Anonymous, which drives nothing: a read-only
 * connection cannot send the line that attaches it, and each connection is its
 * own pipe instance. Before a broker has written its state, this is a name that
 * answers nothing.
 */
export function socketPath(): string {
  if (process.env.BROWSER_AUTOMATION_SOCKET && !activeContext()) return process.env.BROWSER_AUTOMATION_SOCKET
  const dir = brokerDir()
  if (process.platform === 'win32') {
    try {
      const st = JSON.parse(readFileSync(brokerStatePath(dir), 'utf8')) as { socket?: unknown }
      if (typeof st.socket === 'string' && st.socket.startsWith('\\\\.\\pipe\\')) return st.socket
    } catch { /* no broker yet */ }
    return '\\\\.\\pipe\\browser-automation-not-running'
  }
  const p = join(dir, 'cdp.sock')
  if (Buffer.byteLength(p) <= 100) return p
  return join(baseDir(), 'sockets', `${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.sock`)
}

/** What to call the browser we are driving, in messages. */
export function endpointLabel(): string {
  return usesPipe() ? `the browser behind ${socketPath()}` : cdpHost()
}

/** Endpoints handed around in place of webSocketDebuggerUrl when on the pipe. */
const PIPE_BROWSER = 'pipe:browser'
const pipePage = (targetId: string) => `pipe:target:${targetId}`

/**
 * Ports for login contexts, decided here like every other port. A block well
 * above the per-user range (BASE_PORT … BASE_PORT+999), so a context can never
 * land on another account's Chrome. The first free one not already given to a
 * context is taken, once, and kept in the context's record.
 */
const CONTEXT_PORTS = { first: BASE_PORT + 1100, count: 800 }

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

export async function allocateContextPort(taken: number[]): Promise<number> {
  for (let p = CONTEXT_PORTS.first; p < CONTEXT_PORTS.first + CONTEXT_PORTS.count; p++) {
    if (taken.includes(p)) continue
    if (await portIsFree(p)) return p
  }
  throw new Error(`no free port for a new context in ${CONTEXT_PORTS.first}-${CONTEXT_PORTS.first + CONTEXT_PORTS.count - 1}`)
}

/** A target has gone away (tab closed, or Chrome restarted -> new targetIds). */
export class TargetGoneError extends Error {
  constructor(public targetId: string) {
    super(`target ${targetId} not found on ${endpointLabel()} (tab closed or Chrome restarted)`)
    this.name = 'TargetGoneError'
  }
}

export interface CdpTarget {
  id: string
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

async function httpJson<T>(path: string): Promise<T> {
  const res = await fetch(`${cdpHost()}${path}`)
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${path} — is Chrome running with --remote-debugging-port? (${cdpHost()})`)
  return (await res.json()) as T
}

export async function browserWsUrl(): Promise<string> {
  if (usesPipe()) return PIPE_BROWSER
  const v = await httpJson<{ webSocketDebuggerUrl: string }>('/json/version')
  return v.webSocketDebuggerUrl
}

/** `Browser.getVersion`, from either transport. Throws when nothing answers. */
export async function browserVersion(timeout = 5000): Promise<{ product: string }> {
  if (!usesPipe()) {
    const v = await httpJson<{ Browser: string }>('/json/version')
    return { product: v.Browser }
  }
  return withBrowser((s) => s.send('Browser.getVersion', {}, timeout), timeout)
}

export async function listTargets(): Promise<CdpTarget[]> {
  if (!usesPipe()) return httpJson<CdpTarget[]>('/json/list')
  // The same list /json/list gives, from the protocol: Chrome's HTTP handler is
  // Target.getTargets with a URL per target. `browser_ui` targets are Chrome's
  // own UI, which /json/list leaves out.
  const r = await withBrowser((s) => s.send('Target.getTargets'))
  return (r.targetInfos as Array<{ targetId: string; type: string; title?: string; url?: string }>)
    .filter((t) => t.type !== 'browser_ui' && t.type !== 'browser')
    .map((t) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url, webSocketDebuggerUrl: pipePage(t.targetId) }))
}

export async function listPageTargets(): Promise<CdpTarget[]> {
  return (await listTargets()).filter((t) => t.type === 'page')
}

/** webSocketDebuggerUrl for a targetId, or null if it no longer exists. */
export async function targetWsUrl(targetId: string): Promise<string | null> {
  const t = (await listTargets()).find((t) => t.id === targetId)
  return t?.webSocketDebuggerUrl ?? null
}

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>
  on(method: string, cb: (params: any) => void): void
  close(): void
}

/** Open a CDP session to an arbitrary webSocketDebuggerUrl (page or browser), or
 *  to a `pipe:` endpoint from this module, which goes through the broker. */
export function connect(wsUrl: string, { timeout = 15000 } = {}): Promise<CdpSession> {
  if (wsUrl.startsWith('pipe:')) return connectPipe(wsUrl, timeout)
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>()
    const listeners = new Map<string, Array<(p: any) => void>>()

    const openTimer = setTimeout(() => {
      try { ws.close() } catch { /* ignore */ }
      reject(new Error(`CDP connect timeout ${timeout}ms to ${wsUrl}`))
    }, timeout)

    ws.addEventListener('open', () => {
      clearTimeout(openTimer)
      resolve({
        send(method, params = {}, timeoutMs = 30000) {
          return new Promise((res, rej) => {
            const id = nextId++
            const t = setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            pending.set(id, {
              resolve: (v: any) => { clearTimeout(t); res(v) },
              reject: (e: Error) => { clearTimeout(t); rej(e) },
              method,
            })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        on(method, cb) {
          const arr = listeners.get(method) ?? []
          arr.push(cb)
          listeners.set(method, arr)
        },
        close() {
          try { ws.close() } catch { /* ignore */ }
        },
      })
    })

    ws.addEventListener('message', (ev: any) => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const cb of listeners.get(msg.method) ?? []) cb(msg.params)
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(openTimer)
      reject(new Error(`WebSocket error connecting to ${wsUrl}`))
    })
  })
}

/**
 * One connection to the broker, bound to one target (or to the browser).
 *
 * The broker speaks CDP's own JSON, one message per line, after a one-line
 * handshake naming what to attach to. It answers the handshake once the session
 * exists, so a tab that has gone fails here, as a closed tab's WebSocket would.
 */
function connectPipe(endpoint: string, timeout: number): Promise<CdpSession> {
  const attach = endpoint === PIPE_BROWSER
    ? { attach: 'browser' }
    : { attach: 'target', targetId: endpoint.slice('pipe:target:'.length) }
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath())
    let nextId = 1
    let ready = false
    let buf = ''
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>()
    const listeners = new Map<string, Array<(p: any) => void>>()
    const fail = (e: Error) => {
      for (const p of pending.values()) p.reject(e)
      pending.clear()
    }

    const openTimer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`CDP connect timeout ${timeout}ms to ${socketPath()}`))
    }, timeout)

    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(attach) + '\n'))
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: any
        try { msg = JSON.parse(line) } catch { continue }
        if (!ready) {
          clearTimeout(openTimer)
          if (msg.error) {
            sock.destroy()
            reject(new Error(String(msg.error)))
            return
          }
          ready = true
          resolve(session)
          continue
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
          else p.resolve(msg.result)
        } else if (msg.method) {
          for (const cb of listeners.get(msg.method) ?? []) cb(msg.params)
        }
      }
    })
    sock.on('error', (e: any) => {
      clearTimeout(openTimer)
      const err = e?.code === 'ENOENT' || e?.code === 'ECONNREFUSED'
        ? new Error(`no browser on ${socketPath()} — run: browser-automation launch`)
        : new Error(`socket error on ${socketPath()}: ${e?.message ?? e}`)
      if (!ready) reject(err)
      fail(err)
    })
    sock.on('close', () => fail(new Error('the browser connection closed (tab closed or Chrome quit)')))

    const session: CdpSession = {
      send(method, params = {}, timeoutMs = 30000) {
        return new Promise((res, rej) => {
          const id = nextId++
          const t = setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          pending.set(id, {
            resolve: (v: any) => { clearTimeout(t); res(v) },
            reject: (e: Error) => { clearTimeout(t); rej(e) },
            method,
          })
          sock.write(JSON.stringify({ id, method, params }) + '\n')
        })
      },
      on(method, cb) {
        const arr = listeners.get(method) ?? []
        arr.push(cb)
        listeners.set(method, arr)
      },
      close() {
        sock.end()
      },
    }
  })
}

/** Run `fn` against a session bound to a single page target, then close it. */
export async function withPage<T>(targetId: string, fn: (s: CdpSession) => Promise<T>): Promise<T> {
  const wsUrl = await targetWsUrl(targetId)
  if (!wsUrl) throw new TargetGoneError(targetId)
  const s = await connect(wsUrl)
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

/** Make a page target behave as the foreground tab for trusted CDP input,
 *  WITHOUT stealing OS focus from the user's other apps.
 *
 *  CDP `Input.*` events (and the user-activation they grant) are dropped by the
 *  renderer when the tab's `visibilityState` is `hidden` — which it is whenever
 *  the automation Chrome window isn't the frontmost OS window (the normal case:
 *  the user is in their terminal). `Emulation.setFocusEmulationEnabled` forces
 *  the renderer to treat itself as focused+visible regardless of the real window
 *  state (this is how Playwright drives backgrounded/headless pages), and
 *  `Page.setWebLifecycleState: active` un-throttles a frozen tab. Together they
 *  flip `document.hasFocus()`+`visibilityState:visible` on, so a trusted click /
 *  drag actually lands and grants user activation — which activation-gated flows
 *  (e.g. drop-zone uploaders that only start work inside a user gesture) require.
 *
 *  Both are best-effort: older Chrome builds may not expose every command.
 *
 *  ⛔ **No `Page.bringToFront` here, and do not add it back.** It used to be the
 *  first call, and it makes this tab the SELECTED tab of its Chrome window: the
 *  tab the person had showing goes `hidden`, and the next time they bring Chrome
 *  forward and type, the keys land in the automated tab. That happened for real
 *  (issue #28, 2026-10-14): an agent's quiet `focus` left its Outlook calendar
 *  selected, and the person's typing created events named "A", "d", "w", "a",
 *  "cti" in their real calendar. It bought nothing: measured the same day on
 *  Chrome 155 / macOS 27, a background tab with ONLY the two commands below
 *  reports `visible` + `hasFocus()`, takes a CDP mouse click as
 *  `isTrusted: true` and a CDP key, and the person's tab stays the visible one
 *  throughout and after the probe tab is closed. */
export async function forceForeground(s: CdpSession): Promise<void> {
  await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await s.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
}

/** Run `fn` against the browser-level endpoint (Target.* commands), then close. */
async function withBrowser<T>(fn: (s: CdpSession) => Promise<T>, timeout?: number): Promise<T> {
  const s = await connect(await browserWsUrl(), timeout === undefined ? undefined : { timeout })
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

/**
 * Create a new tab in the BACKGROUND (never steals focus) -> returns targetId.
 *
 * `timeout` exists for the health probe. On a browser that has lost the ability
 * to make renderers, `Target.createTarget` itself can hang rather than fail, so
 * a caller that means to spend ~100ms deciding whether the browser works would
 * otherwise sit on the default 30s — measured 2026-09-07, when this put a 30s
 * stall in front of every `launch` on a wedged Chrome. Ordinary callers pass
 * nothing and keep the generous default, which is right for them: a real tab
 * opening slowly should still open.
 */
export async function createTab(url = 'about:blank', { timeout }: { timeout?: number } = {}): Promise<string> {
  return withBrowser(async (s) => {
    const r = await s.send('Target.createTarget', { url, background: true }, timeout)
    return r.targetId as string
  }, timeout)
}

/**
 * Bring a target to the front of its window.
 *
 * **This raises the Chrome window over whatever the operator is using** —
 * measured on macOS 2026-09-11, with the terminal deliberately frontmost:
 * Target.activateTarget, GET /json/activate/<id>, Page.bringToFront and
 * createTarget(background:false) all moved the frontmost app from the terminal
 * to Google Chrome. There is no quiet variant.
 *
 * It is here because a backgrounded target's renderer can take 12+ seconds to
 * answer while an activated one answers in ~19ms (see core/renderer-wake.ts),
 * and a brief flicker beats refusing to work. Nothing calls it casually:
 * `ensureRenderer` spends it only after a grace period has expired, and hands
 * the window straight back.
 */
export async function activateTab(targetId: string): Promise<void> {
  return withBrowser(async (s) => {
    await s.send('Target.activateTarget', { targetId })
  })
}

/**
 * Ask Chrome to quit, the way its own menu does.
 *
 * `launch --restart` used to rely on SIGTERM, and on macOS 27 / Chrome 153 the
 * browser process never exits on it: the DevTools port and helpers go, the
 * process stays asleep. Measured 2026-09-23, every restart of every Chrome,
 * however launched. The script then escalates to SIGKILL, which skips the
 * profile flush that keeps the logins — so quit it properly first and leave the
 * signals as the fallback. Resolves once the request is sent; the connection
 * dropping as Chrome goes is the expected outcome, not an error.
 */
export async function closeBrowser(): Promise<void> {
  await withBrowser(async (s) => {
    await s.send('Browser.close', {}, 3000).catch(() => {})
  }, 3000)
}

export async function closeTab(targetId: string): Promise<boolean> {
  return withBrowser(async (s) => {
    const r = await s.send('Target.closeTarget', { targetId })
    return !!r.success
  })
}

/** Evaluate a JS expression in a page target and return its value by-value.
 *  Set userGesture for actions that require user activation (e.g. downloads). */
export async function evaluate<T = any>(
  targetId: string,
  expression: string,
  { userGesture = false }: { userGesture?: boolean } = {},
): Promise<T> {
  return withPage(targetId, async (s) => {
    const res = await s.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    })
    if (res.exceptionDetails) {
      const e = res.exceptionDetails
      throw new Error('page JS exception: ' + (e.exception?.description || e.text || 'unknown'))
    }
    return res.result?.value as T
  })
}

/** Re-evaluate until `ready(value)` is true or the timeout elapses (Playwright-
 * style auto-wait for SPA content that renders after load). Returns the last
 * value regardless, so callers can still handle a genuinely-empty page. */
export async function evaluateUntil<T = any>(
  targetId: string,
  expression: string,
  ready: (v: T) => boolean,
  { timeout = 5000, interval = 250 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout
  let last = await evaluate<T>(targetId, expression)
  while (!ready(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    last = await evaluate<T>(targetId, expression)
  }
  return last
}

/** Capture a PNG screenshot of a page target (optionally the full page). */
export async function captureScreenshot(targetId: string, { fullPage = false }: { fullPage?: boolean } = {}): Promise<Buffer> {
  return withPage(targetId, async (s) => {
    const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage })
    return Buffer.from(r.data, 'base64')
  })
}

/** Navigate a page target and wait for load (or timeout). */
/**
 * How long to wait for a page's load event before giving up on confirming it.
 *
 * Read from the environment so the suite can exercise the give-up path without
 * spending 30 real seconds on it. Deliberately NOT used by the test that checks
 * a prompt exit: shrinking the timeout there would shrink the leak it exists to
 * catch, and it would pass against the bug.
 */
function navTimeout(): number {
  const v = Number(process.env.BROWSER_AUTOMATION_NAV_TIMEOUT)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30000
}

export async function navigate(
  targetId: string,
  url: string,
  { timeout = navTimeout() } = {},
): Promise<{ loaded: boolean }> {
  return withPage(targetId, async (s) => {
    await s.send('Page.enable')
    let seen = false
    const loaded = new Promise<void>((resolve) => s.on('Page.loadEventFired', () => { seen = true; resolve() }))
    const r = await s.send('Page.navigate', { url })
    if (r.errorText) throw new Error(`navigate failed: ${r.errorText}`)

    // ⛔ The loser of this race MUST be cleared, and for four months it was not.
    //
    // `Promise.race` settles the moment the load event lands — in ~0.19s against
    // a real Chrome — but an un-cleared `setTimeout` keeps Node's event loop
    // alive until it fires. So the CLI printed its success line immediately and
    // then sat there doing nothing for the remaining 30 seconds before exiting.
    // Measured 2026-09-14: `goto` took 31s wall-clock on five consecutive runs,
    // new tab and existing tab alike, with the ✔ appearing in the first second.
    //
    // It read as "the browser is slow" rather than as a bug in this file, which
    // is why it survived the whole renderer-health investigation sitting one
    // line below the thing being investigated. Nothing was wrong with Chrome.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([loaded, new Promise<void>((res) => { timer = setTimeout(res, timeout) })])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    // A page can legitimately never fire a load event, so a miss is not an
    // error — but the caller must be able to tell "loaded" from "gave up
    // waiting", rather than being handed the same silence for both.
    return { loaded: seen }
  })
}
