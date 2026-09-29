// `--show` / BAC_SHOW_TAB: make the session's tab the SELECTED tab in its window,
// so a person watching Chrome sees the page being worked on — without ever
// bringing Chrome in front of another app.
//
// Why "only when Chrome is already in front": measured 2026-09-29 on Chrome 153 /
// macOS 27 with Tabby frontmost, polling the frontmost app every 10-20ms, every
// CDP route that selects a tab also raises Chrome — Target.activateTarget,
// Page.bringToFront, /json/activate, createTarget background:false, and
// window.open / focus() from the page. The one quiet route (an extension calling
// chrome.tabs.update) is not something Google Chrome keeps installed across a
// normal start. So selection happens only when the automation Chrome is ALREADY
// the frontmost app, where it raises nothing.
//
// What these tests pin is the route taken — the fake counts Target.activateTarget
// calls — not the wording: a `--show` that activated with another app in front
// would print the same cheerful line while taking somebody's screen.
//
// Frontmost is injected through BROWSER_AUTOMATION_TEST_FRONTMOST, because the
// fake is not a Chrome process that `lsappinfo` could report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeChrome } from './fake-chrome.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

function run(endpoint, argv, home, env = {}) {
  return new Promise((resolve) => {
    const { BAC_SHOW_TAB: _, ...base } = process.env
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...base,
        HOME: home,
        NO_COLOR: '1',
        NO_UPDATE_NOTIFIER: '1',
        BROWSER_AUTOMATION_CDP: endpoint,
        BROWSER_AUTOMATION_RENDERER_GRACE: '200',
        BROWSER_AUTOMATION_RENDERER_BUDGET: '400',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d })
    child.stderr.on('data', (d) => { all += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, all }) })
  })
}

async function setup(t) {
  const chrome = await startFakeChrome()
  const home = mkdtempSync(join(tmpdir(), 'ba-show-'))
  t.after(async () => { await chrome.close(); rmSync(home, { recursive: true, force: true }) })
  return { chrome, home }
}

const CHROME_IN_FRONT = { BROWSER_AUTOMATION_TEST_FRONTMOST: 'chrome' }
const OTHER_APP_IN_FRONT = { BROWSER_AUTOMATION_TEST_FRONTMOST: 'other' }

test('goto --show selects the tab when the automation Chrome is in front', async (t) => {
  const { chrome, home } = await setup(t)
  const r = await run(chrome.endpoint, ['goto', '-s', 'w', 'https://example.com', '--show'], home, CHROME_IN_FRONT)
  assert.equal(r.code, 0, r.all)
  assert.equal(chrome.stats.activations, 1, 'the tab should have been selected')
})

test('goto --show NEVER activates when another app is in front — it would take the screen', async (t) => {
  const { chrome, home } = await setup(t)
  const r = await run(chrome.endpoint, ['goto', '-s', 'w', 'https://example.com', '--show'], home, OTHER_APP_IN_FRONT)
  assert.equal(r.code, 0, 'not showing is not a failure; the navigation happened')
  assert.equal(chrome.stats.activations, 0)
  assert.match(r.all, /not shown|another app/i, 'say why it did not, so an agent is not left guessing')
})

test('without --show nothing is selected, even with Chrome in front', async (t) => {
  const { chrome, home } = await setup(t)
  const r = await run(chrome.endpoint, ['goto', '-s', 'w', 'https://example.com'], home, CHROME_IN_FRONT)
  assert.equal(r.code, 0, r.all)
  assert.equal(chrome.stats.activations, 0)
})

test('BAC_SHOW_TAB=1 turns it on for every goto, so a skill sets it once', async (t) => {
  const { chrome, home } = await setup(t)
  const r = await run(chrome.endpoint, ['goto', '-s', 'w', 'https://example.com'], home, { ...CHROME_IN_FRONT, BAC_SHOW_TAB: '1' })
  assert.equal(r.code, 0, r.all)
  assert.equal(chrome.stats.activations, 1)
})

test('new --show selects the new tab when the automation Chrome is in front', async (t) => {
  const { chrome, home } = await setup(t)
  const r = await run(chrome.endpoint, ['new', '-s', 'w', 'https://example.com', '--show'], home, CHROME_IN_FRONT)
  assert.equal(r.code, 0, r.all)
  assert.equal(chrome.stats.activations, 1)
})

test('new --show with another app in front leaves the screen alone', async (t) => {
  const { chrome, home } = await setup(t)
  const r = await run(chrome.endpoint, ['new', '-s', 'w', 'https://example.com', '--show'], home, OTHER_APP_IN_FRONT)
  assert.equal(r.code, 0, r.all)
  assert.equal(chrome.stats.activations, 0)
})
