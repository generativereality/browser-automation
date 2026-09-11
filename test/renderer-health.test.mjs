// Black-box regression tests for the renderer-health VERDICT.
//
// The bug (2026-09-11): a Chrome that merely took longer than one 5s budget to
// hand a new background tab its renderer was reported as
//
//     "Chrome cannot give a new tab a working renderer ...
//      This is permanent for this browser process.
//      Recovery: restart Chrome."
//
// while the browser was demonstrably fine — Mach rendezvous service registered,
// 48 renderer processes alive, and the same `goto` succeeding an hour later
// against the same browser pid. The advice it printed, `launch --restart`,
// closes every tab of every session sharing that Chrome, and twice destroyed
// another session's in-progress work.
//
// These tests drive the built CLI against a fake Chrome whose page targets are
// created normally and then never answer — the exact shape of "slow" — with no
// real Chrome process behind the port, so the permanent failure's own signature
// (an ABSENT Mach bootstrap name) cannot be confirmed either way. The CLI must
// therefore NOT claim it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeChrome } from './fake-chrome.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

// The fake Chrome runs IN THIS PROCESS, so the CLI must be spawned
// asynchronously: `spawnSync` blocks the event loop, the fake never gets to
// answer a single request, and every case times out identically — which is
// indistinguishable from the CLI hanging, and cost two full red runs to see.
function run(endpoint, argv, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ba-home-'))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: '1',
        // Each run gets a throwaway HOME, so update-notifier would find no
        // cache and go to the registry. Tests do not need the network.
        NO_UPDATE_NOTIFIER: '1',
        BROWSER_AUTOMATION_CDP: endpoint,
        // Keep the test quick: the shape under test is the verdict, not the
        // wall-clock budget. Without these the defaults make each run ~35s.
        BROWSER_AUTOMATION_PROBE_TIMEOUT: '300',
        BROWSER_AUTOMATION_PROBE_ATTEMPTS: '2',
        BROWSER_AUTOMATION_RENDERER_GRACE: '200',
        BROWSER_AUTOMATION_RENDERER_BUDGET: '400',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d })
    child.stderr.on('data', (d) => { all += d })
    // A CLI that hangs is a failure, not a reason to wedge the suite.
    const killer = setTimeout(() => child.kill('SIGKILL'), 40000)
    child.on('close', (code) => {
      clearTimeout(killer)
      rmSync(home, { recursive: true, force: true })
      resolve({ code, all })
    })
  })
}

test('a silent renderer is not reported as the permanent, restart-only failure', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: false })
  t.after(() => chrome.close())

  const r = await run(chrome.endpoint, ['new', '-s', 'probe-test', 'https://example.test/'])

  // The whole bug, in three assertions. None of these may appear when the
  // browser has not been shown to be in the permanent state.
  // Note what is banned: the CLAIM, not the word. Saying "NOT confirmed as the
  // permanent failure" is the whole point of the fix.
  assert.doesNotMatch(r.all, /is permanent for this browser|can never make a renderer again|This is permanent/i,
    `claimed a permanent failure it did not establish:\n${r.all}`)
  assert.doesNotMatch(r.all, /Recovery: restart Chrome/i,
    `prescribed a restart on evidence it does not have:\n${r.all}`)
  assert.doesNotMatch(r.all, /lost its Mach bootstrap|MachPortRendezvousServer\.\d+["']? *\.?$/im,
    `asserted the Mach rendezvous name is gone without checking it:\n${r.all}`)

  // And it must say what it actually knows instead.
  assert.match(r.all, /could not (be )?confirm|undiagnosed|unconfirmed/i,
    `did not admit the permanent failure's signature was unverifiable:\n${r.all}`)
})

test('the cheap recovery is offered before any restart', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: false })
  t.after(() => chrome.close())

  const r = await run(chrome.endpoint, ['new', '-s', 'probe-test', 'https://example.test/'])

  // An already-live tab navigates without needing a new renderer, so a
  // same-origin question is answerable without costing anybody their tabs.
  assert.match(r.all, /location\.href/,
    `never mentioned the live-tab escape hatch:\n${r.all}`)
  const restartAt = r.all.search(/launch --restart/)
  const cheapAt = r.all.search(/location\.href/)
  if (restartAt !== -1) {
    assert.ok(cheapAt !== -1 && cheapAt < restartAt,
      `offered --restart before the cheap alternative:\n${r.all}`)
  }
})

test('one timeout is not a verdict — the probe retries before concluding', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: false })
  t.after(() => chrome.close())

  const r = await run(chrome.endpoint, ['new', '-s', 'probe-test', 'https://example.test/'])

  // A single 5s timeout was the entire basis of the old verdict. The unfixed
  // code did ask twice by accident (once in `new`, once in the probe) and still
  // called it permanent, so counting alone is not enough: the report has to
  // show what it actually did, or nobody can tell a retried verdict from a
  // lucky one.
  assert.match(r.all, /[2-9]\d* attempt\(s\)/,
    `never said how many times it looked before deciding:\n${r.all}`)
  assert.ok(chrome.stats.evaluates > 2,
    `asked the renderer only ${chrome.stats.evaluates} time(s) before reaching a verdict`)
})

test('a silent background tab is woken before it is declared dead', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: false })
  t.after(() => chrome.close())

  await run(chrome.endpoint, ['new', '-s', 'probe-test', 'https://example.test/'])

  // Measured 2026-09-11 on Chrome 152: a target created with background=true
  // takes a median 367ms and up to 30s+ to answer, while the same target after
  // Target.activateTarget answers in a median 19ms (max 65ms). The probe used
  // to create a background target and so reproduced the very slowness it was
  // testing for. It must try waking the tab before calling the browser broken.
  assert.ok(chrome.stats.activations > 0,
    'never tried Target.activateTarget before declaring the renderer dead')
})

test('a healthy browser still just works, and says nothing about restarts', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: true })
  t.after(() => chrome.close())

  const r = await run(chrome.endpoint, ['new', '-s', 'probe-test', 'https://example.test/'])

  assert.equal(r.code, 0, `healthy browser should succeed, got ${r.code}:\n${r.all}`)
  assert.doesNotMatch(r.all, /restart/i, `frightened a healthy browser's user:\n${r.all}`)
  assert.equal(chrome.stats.activations, 0,
    'stole window focus on a tab whose renderer answered straight away')
})

test('a browser that cannot even create a target is described as that', async (t) => {
  const chrome = await startFakeChrome({ createTargetHangs: true })
  t.after(() => chrome.close())

  const r = await run(chrome.endpoint, ['new', '-s', 'probe-test', 'https://example.test/'])

  assert.notEqual(r.code, 0, `should fail when no target can be created:\n${r.all}`)
  assert.match(r.all, /could not create a target|create a target at all/i,
    `collapsed "could not create a target" into the renderer message:\n${r.all}`)
})
