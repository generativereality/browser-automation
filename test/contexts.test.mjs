// Login contexts (`--context <name>`, issue #31): a second account signed in
// next to the person's own, in the one shared Chrome.
//
// What must hold, each pinned below against the fake Chrome (whose context
// model is Chrome 155's, measured 2026-10-24 — see test/fake-chrome.mjs):
//   - a context tab is created IN a CDP context; a plain tab is not, and a
//     plain run creates no context at all;
//   - a login made in the context's window is saved to disk, privately, and
//     the person's own cookies are never touched;
//   - after Chrome restarts, the session's next `goto` re-creates the context
//     and puts the saved login back before the page loads;
//   - ⛔ the CLI never sends a cookie call for a context id Chrome does not
//     know, because Chrome applies those to the DEFAULT jar — the person's own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeChrome } from './fake-chrome.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

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
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, all }) })
  })
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ba-ctx-'))
  try { return await fn(home) } finally { rmSync(home, { recursive: true, force: true }) }
}

const sessionFile = (home, name) => JSON.parse(readFileSync(join(home, '.browser-automation', 'sessions', `${name}.json`), 'utf8'))
const contextFile = (home, name) => join(home, '.browser-automation', 'contexts', `${name}.json`)
const created = (chrome) => chrome.stats.browserCalls.filter((c) => c.method === 'Target.createTarget')

test('new --context opens the tab in its own browser context, and records it on the session', async () => {
  const chrome = await startFakeChrome({ userTabs: ['mail'] })
  try {
    await withHome(async (home) => {
      const r = await run(chrome.endpoint, ['new', '-s', 'cf2', '--context', 'cloudflare-2'], home)
      assert.equal(r.code, 0, r.all)
      const [ctxId] = chrome.contexts()
      assert.ok(ctxId, 'a browser context should have been created')
      const call = created(chrome).at(-1)
      assert.equal(call.params.browserContextId, ctxId, `the tab must be created IN the context:\n${JSON.stringify(call)}`)
      assert.equal(call.params.background, true, 'still a background tab')
      assert.equal(sessionFile(home, 'cf2').context, 'cloudflare-2')
      assert.equal(chrome.selectedTab(), 'mail', "the person's window still shows their tab")
      assert.match(r.all, /context "cloudflare-2"/)
    })
  } finally { await chrome.close() }
})

test('a plain new tab names no context, and creates none', async () => {
  const chrome = await startFakeChrome()
  try {
    await withHome(async (home) => {
      const r = await run(chrome.endpoint, ['new', '-s', 'plain'], home)
      assert.equal(r.code, 0, r.all)
      assert.equal(created(chrome).at(-1).params.browserContextId, undefined)
      assert.equal(chrome.contexts().length, 0)
      assert.ok(!chrome.stats.browserCalls.some((c) => c.method.startsWith('Storage.')), 'no cookie calls for a plain run')
      assert.ok(!existsSync(join(home, '.browser-automation', 'contexts')), 'and nothing written for contexts')
    })
  } finally { await chrome.close() }
})

test('a login made in the context window is saved privately, and the person\'s own cookies are untouched', async () => {
  const chrome = await startFakeChrome()
  try {
    await withHome(async (home) => {
      chrome.addCookie(chrome.DEFAULT_CTX, { name: 'own', value: 'mine', domain: '.cloudflare.com' })
      assert.equal((await run(chrome.endpoint, ['new', '-s', 'cf2', '--context', 'cloudflare-2'], home)).code, 0)
      const [ctxId] = chrome.contexts()
      // The person signs in by hand in the context's window...
      chrome.addCookie(ctxId, { name: 'CF_Authorization', value: 'second-account', domain: '.cloudflare.com' })
      // ...and the next command that touches the tab keeps it.
      const r = await run(chrome.endpoint, ['focus', '-s', 'cf2'], home)
      assert.equal(r.code, 0, r.all)
      const f = contextFile(home, 'cloudflare-2')
      const saved = JSON.parse(readFileSync(f, 'utf8'))
      assert.deepEqual(saved.cookies.map((c) => c.value), ['second-account'], 'only the context\'s cookie is saved')
      if (process.platform !== 'win32') {
        assert.equal(statSync(f).mode & 0o777, 0o600, 'the saved login is readable by this user only')
        assert.equal(statSync(dirname(f)).mode & 0o777, 0o700)
      }
      assert.deepEqual(chrome.cookies(chrome.DEFAULT_CTX).map((c) => c.value), ['mine'], "the person's own jar is unchanged")
    })
  } finally { await chrome.close() }
})

test('after Chrome restarts, goto re-creates the context and puts the saved login back', async () => {
  const chrome = await startFakeChrome()
  try {
    await withHome(async (home) => {
      assert.equal((await run(chrome.endpoint, ['new', '-s', 'cf2', '--context', 'cloudflare-2'], home)).code, 0)
      const [oldId] = chrome.contexts()
      chrome.addCookie(oldId, { name: 'CF_Authorization', value: 'second-account', domain: '.cloudflare.com' })
      assert.equal((await run(chrome.endpoint, ['context', 'save', 'cloudflare-2'], home)).code, 0)

      chrome.restart()
      const atRestart = chrome.stats.browserCalls.length
      const r = await run(chrome.endpoint, ['goto', '-s', 'cf2', 'https://dash.cloudflare.com'], home)
      assert.equal(r.code, 0, r.all)
      assert.match(r.all, /re-created with 1 saved cookie/, `goto should say the login came back:\n${r.all}`)
      const [newId] = chrome.contexts()
      assert.ok(newId && newId !== oldId, 'a fresh context, since the old id died with Chrome')
      assert.deepEqual(chrome.cookies(newId).map((c) => c.value), ['second-account'], 'the saved login is back in it')
      assert.equal(chrome.contextOf(sessionFile(home, 'cf2').targetId), newId, 'and the session\'s new tab is in it')
      assert.deepEqual(chrome.cookies(chrome.DEFAULT_CTX), [], "nothing leaked into the person's jar")
      const afterRestart = chrome.stats.browserCalls.slice(atRestart)
      assert.deepEqual(afterRestart.filter((c) => c.method.startsWith('Storage.') && c.params.browserContextId !== newId), [],
        'after the restart, every cookie call names the NEW context: the dead id would hit the default jar')
    })
  } finally { await chrome.close() }
})

test('a stale context id is never used for a cookie call (Chrome would apply it to the person\'s profile)', async () => {
  const chrome = await startFakeChrome()
  try {
    await withHome(async (home) => {
      chrome.addCookie(chrome.DEFAULT_CTX, { name: 'own', value: 'mine', domain: '.example.com' })
      assert.equal((await run(chrome.endpoint, ['new', '-s', 'w', '--context', 'work'], home)).code, 0)
      const [oldId] = chrome.contexts()
      chrome.restart()
      const before = chrome.stats.browserCalls.length
      const r = await run(chrome.endpoint, ['context', 'save', 'work'], home)
      assert.equal(r.code, 0, r.all)
      assert.match(r.all, /not open in this Chrome/)
      const storage = chrome.stats.browserCalls.slice(before).filter((c) => c.method.startsWith('Storage.'))
      assert.deepEqual(storage, [], `no Storage call at all for a context Chrome no longer has:\n${JSON.stringify(storage)}`)
      assert.ok(!chrome.contexts().includes(oldId))
      assert.deepEqual(chrome.cookies(chrome.DEFAULT_CTX).map((c) => c.value), ['mine'])
    })
  } finally { await chrome.close() }
})

test('a session cannot switch context under a live tab', async () => {
  const chrome = await startFakeChrome()
  try {
    await withHome(async (home) => {
      assert.equal((await run(chrome.endpoint, ['goto', '-s', 'x', 'https://a.test'], home)).code, 0)
      const r = await run(chrome.endpoint, ['goto', '-s', 'x', '--context', 'other', 'https://a.test'], home)
      assert.notEqual(r.code, 0, `must refuse:\n${r.all}`)
      assert.match(r.all, /your own profile, not "other"/)
      assert.equal(chrome.contexts().length, 0, 'and must not have created the context')
    })
  } finally { await chrome.close() }
})

test('context list and forget', async () => {
  const chrome = await startFakeChrome()
  try {
    await withHome(async (home) => {
      assert.equal((await run(chrome.endpoint, ['new', '-s', 'cf2', '--context', 'cloudflare-2'], home)).code, 0)
      const l = await run(chrome.endpoint, ['context'], home)
      assert.match(l.all, /cloudflare-2\s+\[open\].*sessions: cf2/)
      const f = await run(chrome.endpoint, ['context', 'forget', 'cloudflare-2', '--close'], home)
      assert.equal(f.code, 0, f.all)
      assert.ok(!existsSync(contextFile(home, 'cloudflare-2')), 'the saved login is deleted')
      assert.equal(chrome.contexts().length, 0, '--close closed the context and its window')
    })
  } finally { await chrome.close() }
})
