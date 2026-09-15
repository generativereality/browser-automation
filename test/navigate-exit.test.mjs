// The CLI must EXIT when the work is done, not when a forgotten timer fires.
//
// The bug (present since ffb1d2c, found 2026-09-14): `navigate()` raced the
// page's load event against `setTimeout(res, 30000)` and never cleared the
// loser. `Promise.race` settles the moment the load event lands, so the command
// printed its success line in the first second — and then Node kept the process
// alive until the abandoned timer fired. Every `goto` cost 30 seconds of doing
// nothing, on a new tab and an existing tab alike.
//
// It hid for two reasons worth remembering. The success line appears first, so
// the command looks finished and the wait reads as "the browser is slow" rather
// than as a defect in our own file. And it sat one line below the renderer
// investigation that ran all week — whose own test harness recorded the symptom
// as "the defaults make each run ~35s" and attributed it to probe budgets.
//
// The fake Chrome answers `Page.navigate` and never sends `Page.loadEventFired`,
// which is the arm that always waited out the full timeout, so this reproduces
// it exactly. Watched failing before the fix: 30.5s against a 10s assertion.
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
 * ⚠️ The navigate timeout is deliberately NOT overridden here. Shrinking it
 * would shrink the leak too, and the test would pass against the bug — the
 * whole assertion is that a 30s timer nobody is waiting for does not delay the
 * exit, so it has to be a real 30s timer.
 */
function run(endpoint, argv, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ba-home-'))
  const started = Date.now()
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
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d })
    child.stderr.on('data', (d) => { all += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.on('close', (code) => {
      clearTimeout(killer)
      rmSync(home, { recursive: true, force: true })
      resolve({ code, all, ms: Date.now() - started })
    })
  })
}

test('goto exits as soon as the page has loaded', async () => {
  const chrome = await startFakeChrome({ rendererAnswers: true, firesLoadEvent: true })
  try {
    const r = await run(chrome.endpoint, ['goto', '-s', 'exit-test', 'https://example.com'])
    assert.equal(r.code, 0, `goto should succeed:\n${r.all}`)
    assert.match(r.all, /navigated/, `should report the navigation:\n${r.all}`)
    assert.doesNotMatch(r.all, /No load event arrived/, `the load event DID arrive here:\n${r.all}`)
    assert.ok(
      r.ms < 10000,
      `goto took ${r.ms}ms. The work finishes in well under a second; anything `
      + `near the 30s navigate timeout means its loser was left pending and is `
      + `holding the event loop open.\n${r.all}`,
    )
  } finally {
    await chrome.close()
  }
})

test('goto says so when the load event never arrived', async () => {
  const chrome = await startFakeChrome({ rendererAnswers: true, firesLoadEvent: false })
  try {
    // A short timeout is fine HERE: this arm is about what the command SAYS
    // when it gives up, not about how long it is willing to wait.
    const r = await run(chrome.endpoint, ['goto', '-s', 'unconfirmed-test', 'https://example.com'],
      { BROWSER_AUTOMATION_NAV_TIMEOUT: '1500' })
    assert.equal(r.code, 0, `goto should succeed:\n${r.all}`)
    // Reporting a confirmed load when none was confirmed is the reply-before-
    // the-outcome shape: the navigation was accepted, and that is all we know.
    assert.match(
      r.all,
      /No load event arrived/,
      `an unconfirmed load must be named rather than reported as a clean load:\n${r.all}`,
    )
  } finally {
    await chrome.close()
  }
})
