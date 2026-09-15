// `focus` — making a tab report itself visible, and saying which route it took.
//
// The gap it fills (2026-09-14): a backgrounded tab reports
// `{visibility:"hidden", hasFocus:false}`, and pages act on that — deferred
// rendering, paused polling, charts that never draw. The capability to change
// it existed in the codebase and was reachable only as a side effect of
// `click --trusted` and `drop`, both of which need it for trusted input.
//
// Two routes, and the difference is the operator's screen:
//   quiet   Emulation.setFocusEmulationEnabled — the renderer believes it is
//           visible, no window moves. The default.
//   --raise Target.activateTarget — genuinely brings the tab forward, and takes
//           whatever the operator was looking at (measured in renderer-wake.ts:
//           every real activation moved the frontmost app to Chrome).
//
// So the assertions that matter are about WHICH route ran, not about the
// printed line: a quiet focus that silently raised the window would read as a
// pass while stealing somebody's screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeChrome } from './fake-chrome.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

/**
 * ⚠️ `home` is a PARAMETER, not a fresh temp dir per call. Session bookmarks
 * live under HOME, so a per-invocation home means `new -s x` and `focus -s x`
 * cannot see each other — every case then fails with "no live tab", which reads
 * as the command being broken rather than as the harness losing the session.
 */
function run(endpoint, argv, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: '1',
        NO_UPDATE_NOTIFIER: '1',
        BROWSER_AUTOMATION_CDP: endpoint,
        BROWSER_AUTOMATION_RENDERER_GRACE: '200',
        BROWSER_AUTOMATION_RENDERER_BUDGET: '400',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d })
    child.stderr.on('data', (d) => { all += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ code, all })
    })
  })
}

/** Give the fake a tab to act on, the way a session would, in ONE home. */
async function withTab(chrome, fn) {
  const home = mkdtempSync(join(tmpdir(), 'ba-home-'))
  try {
    const made = await run(chrome.endpoint, ['new', '-s', 'focus-test'], home)
    assert.equal(made.code, 0, `could not open a tab:\n${made.all}`)
    return await fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('focus makes the tab report itself visible without taking the screen', async () => {
  const chrome = await startFakeChrome()
  try {
    await withTab(chrome, async (home) => {
      const before = chrome.stats.activations
      const r = await run(chrome.endpoint, ['focus', '-s', 'focus-test'], home)
      assert.equal(r.code, 0, `focus should succeed:\n${r.all}`)
      assert.match(r.all, /focused \+ visible/, `should report the outcome:\n${r.all}`)
      assert.ok(
        chrome.stats.pageMethods.includes('Emulation.setFocusEmulationEnabled'),
        `the quiet route is the emulation command; it was never sent:\n${chrome.stats.pageMethods.join(', ')}`,
      )
      assert.equal(
        chrome.stats.activations, before,
        'a plain `focus` must not activate the target — that takes the operator\'s screen, '
        + 'and doing it silently is the whole thing this default exists to avoid.',
      )
    })
  } finally { await chrome.close() }
})

test('focus --raise really brings the tab forward', async () => {
  const chrome = await startFakeChrome()
  try {
    await withTab(chrome, async (home) => {
      const before = chrome.stats.activations
      const r = await run(chrome.endpoint, ['focus', '-s', 'focus-test', '--raise'], home)
      assert.equal(r.code, 0, `focus --raise should succeed:\n${r.all}`)
      assert.equal(
        chrome.stats.activations, before + 1,
        `--raise is the loud route and must actually activate:\n${r.all}`,
      )
      assert.match(r.all, /raised to the front/, `should say it took the screen:\n${r.all}`)
    })
  } finally { await chrome.close() }
})

test('focus says so when the tab still reports itself hidden', async () => {
  // An older Chrome answers the command and changes nothing. Printing a tick
  // there is the reply-before-the-outcome shape: the command was accepted and
  // the page is still hidden, which is the one thing the caller needed to know.
  const chrome = await startFakeChrome({ focusEmulationWorks: false })
  try {
    await withTab(chrome, async (home) => {
      const r = await run(chrome.endpoint, ['focus', '-s', 'focus-test'], home)
      assert.equal(r.code, 0, `focus should not fail hard:\n${r.all}`)
      assert.doesNotMatch(r.all, /focused \+ visible/, `must not claim success:\n${r.all}`)
      assert.match(r.all, /visibilityState=hidden/, `must name what it could not achieve:\n${r.all}`)
      assert.match(r.all, /--raise/, `should point at the louder route:\n${r.all}`)
    })
  } finally { await chrome.close() }
})
