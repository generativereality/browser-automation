// The broker's three races (review of the DevTools-pipe change, 2026-10-19):
//   * two brokers started at once must leave exactly one, serving one Chrome;
//   * a connection that closes while its attach is in flight must not leak the
//     CDP session it was attaching;
//   * Chrome going away must hang up on every open connection at once, so a
//     command fails as "closed" instead of waiting out its own timeout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'dist', 'index.js')
const FAKE = join(here, 'fake-chrome-pipe.mjs')

const wait = async (cond, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

// Under /tmp, not os.tmpdir(): a Unix socket path is capped at ~104 bytes on macOS.
function setup(extraEnv = {}) {
  const home = mkdtempSync('/tmp/ba-race-')
  const env = { ...process.env, HOME: home, NO_COLOR: '1', ...extraEnv }
  delete env.BROWSER_AUTOMATION_CDP
  const sock = join(home, '.browser-automation', 'cdp.sock')
  const broker = () => {
    const child = spawn(process.execPath, [CLI, 'broker', '--chrome', FAKE, '--profile', join(home, 'profile'), '--log', join(home, 'chrome.log')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderrText = ''
    child.stderr.setEncoding('utf8').on('data', (d) => { child.stderrText += d })
    child.exited = new Promise((r) => child.on('exit', (code) => r(code)))
    return child
  }
  return { home, env, sock, broker, state: () => JSON.parse(readFileSync(join(dirname(sock), 'broker.json'), 'utf8')) }
}

function open(sock, first) {
  const s = createConnection(sock)
  s.setEncoding('utf8')
  s.lines = []
  s.on('data', (d) => s.lines.push(...d.split('\n').filter(Boolean)))
  s.whenClosed = new Promise((r) => s.on('close', r))
  s.on('connect', () => s.write(JSON.stringify(first) + '\n'))
  s.on('error', () => {})
  return s
}

test('two brokers started at once leave one, and the other steps aside cleanly', { timeout: 20000 }, async () => {
  const t = setup()
  const a = t.broker()
  const b = t.broker()
  try {
    assert.ok(await wait(() => existsSync(t.sock)), 'no broker opened the socket')
    // The loser exits 0 once the winner serves; the winner stays.
    const first = await Promise.race([a.exited.then((code) => ({ who: a, code })), b.exited.then((code) => ({ who: b, code }))])
    assert.equal(first.code, 0, 'the broker that lost the race should exit cleanly')
    const winner = first.who === a ? b : a
    assert.ok(alive(winner.pid), 'the winning broker should still be serving')
    const st = t.state()
    assert.equal(st.brokerPid, winner.pid)
    assert.ok(alive(st.chromePid))
  } finally {
    a.kill('SIGKILL'); b.kill('SIGKILL')
    rmSync(t.home, { recursive: true, force: true })
  }
})

test('a connection that closes during its attach leaves no session behind', { timeout: 20000 }, async () => {
  const events = join(mkdtempSync('/tmp/ba-ev-'), 'events')
  const t = setup({ FAKE_ATTACH_DELAY_MS: '300', FAKE_EVENTS: events })
  const broker = t.broker()
  try {
    assert.ok(await wait(() => existsSync(t.sock)))
    const s = open(t.sock, { attach: 'target', targetId: 'T0' })
    // Hang up while the attach is still in flight (the fake answers after 300ms).
    await wait(() => existsSync(events) && readFileSync(events, 'utf8').includes('attach '), 3000)
    s.destroy()
    const log = () => (existsSync(events) ? readFileSync(events, 'utf8') : '')
    assert.ok(await wait(() => /detach S\d+/.test(log()), 3000), `the session was never detached:\n${log()}`)
    const attached = log().match(/attach (S\d+)/)[1]
    assert.match(log(), new RegExp(`detach ${attached}\\b`))
  } finally {
    broker.kill('SIGKILL')
    rmSync(t.home, { recursive: true, force: true })
    rmSync(dirname(events), { recursive: true, force: true })
  }
})

test('Chrome exiting hangs up on open connections at once, and the broker exits', { timeout: 20000 }, async () => {
  const t = setup()
  const broker = t.broker()
  try {
    assert.ok(await wait(() => existsSync(t.sock)))
    const s = open(t.sock, { attach: 'browser' })
    assert.ok(await wait(() => s.lines.some((l) => l.includes('"attached"')), 3000), 'the browser connection never attached')
    const started = Date.now()
    process.kill(t.state().chromePid, 'SIGKILL')
    await Promise.race([s.whenClosed, new Promise((r) => setTimeout(r, 5000))])
    assert.ok(Date.now() - started < 3000, `the connection stayed open ${Date.now() - started}ms after Chrome died`)
    assert.ok(await wait(() => !alive(broker.pid), 3000), 'the broker outlived Chrome')
  } finally {
    broker.kill('SIGKILL')
    rmSync(t.home, { recursive: true, force: true })
  }
})

// 2026-11-13, mbp21: the broker died of an unhandled ERR_STREAM_WRITE_AFTER_END
// in toPipe. Asked to stop (`launch --restart` SIGTERMs it when Chrome does not
// quit), it sends Browser.close and, 10s later, closes its end of the pipe. A
// wedged Chrome is still running then, other tabs' connections are still open,
// and the next command one of them sent was written after that end. The error
// had no listener: the broker crashed without cleaning up, leaving its state
// file and socket behind, and every session lost the browser.
test('a command sent after the broker closed the pipe does not take the broker down', { timeout: 40000 }, async () => {
  const t = setup({ FAKE_WEDGED_MS: '13000' })
  const broker = t.broker()
  try {
    assert.ok(await wait(() => existsSync(t.sock)))
    const chromePid = t.state().chromePid
    const a = open(t.sock, { attach: 'browser' })
    assert.ok(await wait(() => a.lines.some((l) => l.includes('"attached"')), 3000), 'never attached')
    broker.kill('SIGTERM')
    // The broker closes the pipe 10s after Browser.close goes unanswered; keep
    // sending, as a busy tab does, across that moment. Chrome reads nothing now,
    // so these back up in the pipe and its close cannot complete: the window in
    // which the next write is one after end. (A big command, as a long `eval` is,
    // fills the pipe quickly.)
    const pad = 'x'.repeat(64 * 1024)
    for (let i = 1; i < 60 && !a.destroyed && alive(broker.pid); i++) {
      a.write(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: pad } }) + '\n')
      await new Promise((r) => setTimeout(r, 250))
    }
    const code = await Promise.race([broker.exited, new Promise((r) => setTimeout(() => r('still running'), 15000))])
    assert.equal(code, 0, `the broker should exit cleanly once Chrome is gone, not crash (exit: ${code})\n${broker.stderrText.split('\n').filter((l) => /Error|error/.test(l)).slice(0, 3).join('\n')}`)
    assert.ok(!alive(chromePid), 'Chrome is still running')
    assert.ok(!existsSync(join(dirname(t.sock), 'broker.json')), 'the broker left its state file behind')
    assert.ok(!existsSync(t.sock), 'the broker left its socket behind')
  } finally {
    broker.kill('SIGKILL')
    rmSync(t.home, { recursive: true, force: true })
  }
})
