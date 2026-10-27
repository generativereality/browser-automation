// `launch` on the pipe, next to a browser of the same account still on the port.
//
// ⛔ The regression this pins: `launch --restart` used to quit ANY browser of
// this account on the debugging port. Driven from a test HOME, it found the
// operator's real automation Chrome on :9223 — a different profile entirely —
// and quit it, closing every tab in it (2026-10-14). A port browser is this
// launch's business only when it holds the profile this launch opens.
//
// The "browser on the port" here is a sleeping node process carrying the two
// flags `launch` reads off the process list; nothing listens anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'dist', 'index.js')
const FAKE = join(here, 'fake-chrome-pipe.mjs')
// A port nothing real uses, so this can never meet a real browser either.
const PORT = String(40000 + (process.pid % 20000))

function setup() {
  const home = mkdtempSync('/tmp/ba-launch-')
  const env = { ...process.env, HOME: home, NO_COLOR: '1', BROWSER_AUTOMATION_PORT: PORT, BROWSER_AUTOMATION_CHROME: FAKE }
  delete env.BROWSER_AUTOMATION_CDP
  delete env.BROWSER_AUTOMATION_PROFILE
  return { home, env, profile: join(home, '.browser-automation', 'chrome-profile') }
}

function portBrowser(profile) {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], { stdio: 'ignore' })
}

function cli(env, ...argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

function stopBroker(home) {
  try {
    const st = JSON.parse(readFileSync(join(home, '.browser-automation', 'broker.json'), 'utf8'))
    process.kill(st.brokerPid, 'SIGTERM')
  } catch { /* none started */ }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

test('launch --restart leaves a port browser on ANOTHER profile alone, and says it is there', async () => {
  const { home, env } = setup()
  const other = portBrowser('/somewhere/else')
  try {
    const r = await cli(env, 'launch', '--restart')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /also has a browser listening on port/)
    assert.ok(alive(other.pid), 'launch --restart killed a browser that was not its own')
  } finally {
    other.kill('SIGKILL')
    stopBroker(home)
    rmSync(home, { recursive: true, force: true })
  }
})

test('without --restart, a port browser on THIS profile stops the launch with the way out', async () => {
  const { home, env, profile } = setup()
  const same = portBrowser(profile)
  try {
    const r = await cli(env, 'launch')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /launch --restart/)
    assert.ok(alive(same.pid))
  } finally {
    same.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})

// Login contexts moved onto the pipe too (each was its own Chrome on a TCP port
// of its own until 0.7.0, reachable by anything on the computer).
const ctxState = (home, name) => join(home, '.browser-automation', 'contexts', name, 'broker.json')
const readState = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const stopAt = (f) => { const st = readState(f); if (st && alive(st.brokerPid)) process.kill(st.brokerPid, 'SIGTERM') }

test('launch --context starts the context\'s own broker, beside the person\'s, on a socket of its own', async () => {
  const { home, env } = setup()
  try {
    const c = await cli(env, 'launch', '--context', 'work')
    assert.equal(c.code, 0, c.out)
    assert.match(c.out, /launched on the pipe/)
    assert.match(c.out, /No debugging port is open/)
    const work = readState(ctxState(home, 'work'))
    assert.ok(work, 'the context\'s broker wrote its state in the context\'s folder')
    assert.equal(work.socket, join(home, '.browser-automation', 'contexts', 'work', 'cdp.sock'))
    assert.equal(readState(join(home, '.browser-automation', 'broker.json')), null, 'and did not start the person\'s')

    const own = await cli(env, 'launch')
    assert.equal(own.code, 0, own.out)
    const mine = readState(join(home, '.browser-automation', 'broker.json'))
    assert.ok(mine, 'the person\'s broker is separate')
    assert.notEqual(mine.socket, work.socket)
    assert.notEqual(mine.chromePid, work.chromePid, 'two Chromes, not one')

    const list = await cli(env, 'context')
    assert.match(list.out, /\(your automation Chrome\)\s+\[running\]/)
    assert.match(list.out, /work\s+\[running\]/)
    assert.equal((await cli(env, 'launch', '--context', 'work', '--status')).code, 0)
  } finally {
    stopAt(ctxState(home, 'work'))
    stopBroker(home)
    rmSync(home, { recursive: true, force: true })
  }
})

test('a context whose socket path would be too long for a Unix socket gets a short one', async () => {
  const { home, env } = setup()
  const name = 'a-context-name-long-enough-to-push-the-path-past-the-limit-0123'
  try {
    const c = await cli(env, 'launch', '--context', name)
    assert.equal(c.code, 0, c.out)
    const st = readState(ctxState(home, name))
    assert.ok(st, c.out)
    assert.ok(st.socket.startsWith(join(home, '.browser-automation', 'sockets') + '/'), st.socket)
    assert.ok(Buffer.byteLength(st.socket) <= 100, st.socket)
  } finally {
    stopAt(ctxState(home, name))
    rmSync(home, { recursive: true, force: true })
  }
})
