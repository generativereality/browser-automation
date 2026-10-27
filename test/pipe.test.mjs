// The DevTools pipe, end to end through the real CLI and broker, against a fake
// Chrome (fake-chrome-pipe.mjs) that answers `eval` with the id of the tab the
// command reached.
//
// What has to hold after the move off the port:
//   * nothing listens on TCP; the socket and its directory are this user's only;
//   * every command is still its own process, bound to its own tab, and
//     concurrent commands on different tabs never see each other's answers;
//   * a tab that has gone fails as a gone tab, not as a hang;
//   * the broker going away takes Chrome with it, and cleans up after itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'dist', 'index.js')
const FAKE = join(here, 'fake-chrome-pipe.mjs')

// Under /tmp, not os.tmpdir(): a Unix socket path is capped at ~104 bytes on
// macOS, and $TMPDIR there is long.
const home = mkdtempSync('/tmp/ba-pipe-')
const env = {
  ...process.env,
  HOME: home,
  NO_COLOR: '1',
  BROWSER_AUTOMATION_CDP: '',
  BROWSER_AUTOMATION_RENDERER_GRACE: '200',
  BROWSER_AUTOMATION_RENDERER_BUDGET: '400',
}
delete env.BROWSER_AUTOMATION_CDP
const sock = join(home, '.browser-automation', 'cdp.sock')

function cli(...argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

const wait = async (cond, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

let broker
test.before(async () => {
  broker = spawn(process.execPath, [CLI, 'broker', '--chrome', FAKE, '--profile', join(home, 'profile'), '--log', join(home, 'chrome.log')], { env, stdio: 'ignore' })
  // The state file, not just the socket: the broker writes it a moment after it
  // starts listening, and a busy machine ran the first test in between.
  assert.ok(await wait(() => existsSync(sock) && existsSync(join(dirname(sock), 'broker.json'))), 'the broker never opened its socket')
})
test.after(() => {
  broker?.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
})

test('the socket is this user\'s only, and the broker records the Chrome it started', () => {
  assert.equal(statSync(sock).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(sock)).mode & 0o777, 0o700)
  const st = JSON.parse(readFileSync(join(dirname(sock), 'broker.json'), 'utf8'))
  assert.equal(st.brokerPid, broker.pid)
  assert.ok(st.chromePid > 0)
})

test('each command reaches the tab its session names, also when they run at once', async () => {
  const a = await cli('new', '-s', 'a')
  const b = await cli('new', '-s', 'b')
  assert.equal(a.code, 0, a.out)
  assert.equal(b.code, 0, b.out)
  const runs = await Promise.all(
    Array.from({ length: 10 }, (_, i) => cli('eval', '-s', i % 2 ? 'b' : 'a', `x${i}`)),
  )
  const ids = new Set()
  runs.forEach((r, i) => {
    assert.equal(r.code, 0, r.out)
    const m = /(T\d+):x(\d+)/.exec(r.out)
    assert.ok(m, r.out)
    assert.equal(Number(m[2]), i, 'an answer came back to the wrong command')
    ids.add(`${i % 2}:${m[1]}`)
  })
  // Two sessions, two tabs, never crossed.
  assert.equal(ids.size, 2, [...ids].join(' '))
})

test('list shows the tabs, and not Chrome\'s own UI', async () => {
  const r = await cli('list')
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /\bUI\b/)
})

test('a closed tab fails as a closed tab', async () => {
  const c = await cli('new', '-s', 'c')
  assert.equal(c.code, 0, c.out)
  assert.equal((await cli('close', '-s', 'c')).code, 0)
  const r = await cli('eval', '-s', 'c', '1')
  assert.notEqual(r.code, 0)
})

test('the broker going away takes Chrome with it and removes its socket', async () => {
  const st = JSON.parse(readFileSync(join(dirname(sock), 'broker.json'), 'utf8'))
  broker.kill('SIGTERM')
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.ok(await wait(() => !alive(st.chromePid) && !existsSync(sock)), 'Chrome or the socket outlived the broker')
})
