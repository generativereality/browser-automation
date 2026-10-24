// Login contexts (`--context <name>`, issue #31): a separate Chrome per extra
// account, next to the person's own. Two fake Chromes stand in for the two
// browsers; what is pinned is that every command reaches the RIGHT one —
// a command that drove the wrong Chrome would do its work in the wrong account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeChrome } from './fake-chrome.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

function run(endpoint, argv, home) {
  return new Promise((resolve) => {
    const { BAC_CONTEXT: _c, BAC_SESSION: _s, BROWSER_AUTOMATION_CONTEXT: _a, ...base } = process.env
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...base,
        HOME: home,
        NO_COLOR: '1',
        NO_UPDATE_NOTIFIER: '1',
        BROWSER_AUTOMATION_CDP: endpoint, // the person's own Chrome
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

/** The person's Chrome, plus a context "work" whose Chrome is a second fake. */
async function twoChromes(fn) {
  const own = await startFakeChrome()
  const work = await startFakeChrome()
  const home = mkdtempSync(join(tmpdir(), 'ba-ctx-'))
  const profileDir = join(home, '.browser-automation', 'contexts', 'work', 'chrome-profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(home, '.browser-automation', 'contexts', 'work.json'),
    JSON.stringify({ name: 'work', port: work.port, profileDir, createdAt: new Date().toISOString() }))
  try {
    await fn({ own, work, home, profileDir, ba: (...argv) => run(own.endpoint, argv, home) })
  } finally {
    await own.close(); await work.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const session = (home, name) => {
  const f = join(home, '.browser-automation', 'sessions', `${name}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

test('new --context opens the tab in the context\'s Chrome, not the person\'s', async () => {
  await twoChromes(async ({ own, work, home, ba }) => {
    const r = await ba('new', '-s', 'cf2', '--context', 'work', 'https://dash.example.test')
    assert.equal(r.code, 0, r.all)
    assert.equal(work.stats.createTargets, 1, 'the tab is created in the context\'s Chrome')
    assert.equal(own.stats.createTargets, 0, 'and nothing in the person\'s')
    assert.equal(session(home, 'cf2').context, 'work')
    assert.match(r.all, /in context "work"/)
  })
})

test('a session follows its context with no flag', async () => {
  await twoChromes(async ({ own, work, ba }) => {
    assert.equal((await ba('new', '-s', 'cf2', '--context', 'work')).code, 0)
    const r = await ba('goto', '-s', 'cf2', 'https://dash.example.test')
    assert.equal(r.code, 0, r.all)
    assert.ok(work.stats.pageMethods.includes('Page.navigate'), 'navigated in the context\'s Chrome')
    assert.ok(!own.stats.pageMethods.includes('Page.navigate'), 'not in the person\'s')
  })
})

test('plain commands still drive the person\'s own Chrome', async () => {
  await twoChromes(async ({ own, work, home, ba }) => {
    const r = await ba('new', '-s', 'plain', 'https://a.example.test')
    assert.equal(r.code, 0, r.all)
    assert.equal(own.stats.createTargets, 1)
    assert.equal(work.stats.createTargets, 0)
    assert.equal(session(home, 'plain').context, undefined)
  })
})

test('a session cannot be moved into another context', async () => {
  await twoChromes(async ({ work, ba }) => {
    assert.equal((await ba('new', '-s', 'plain')).code, 0)
    const r = await ba('goto', '-s', 'plain', '--context', 'work', 'https://a.example.test')
    assert.notEqual(r.code, 0, `must refuse:\n${r.all}`)
    assert.match(r.all, /belongs to your own Chrome, not "work"/)
    assert.equal(work.stats.createTargets, 0, 'and must not have touched the context\'s Chrome')
  })
})

test('an unknown context is an error for a command that cannot create one', async () => {
  await twoChromes(async ({ ba }) => {
    const r = await ba('read', '-s', 'x', '--context', 'ghost')
    assert.notEqual(r.code, 0)
    assert.match(r.all, /no context named "ghost" — open one with: browser-automation new/)
  })
})

test('port and profile answer for the context', async () => {
  await twoChromes(async ({ work, profileDir, ba }) => {
    assert.equal((await ba('port', '--context', 'work')).all.trim(), String(work.port))
    assert.equal((await ba('profile', '--context', 'work')).all.trim(), profileDir)
    assert.notEqual((await ba('port')).all.trim(), String(work.port), 'without it, the person\'s own port')
  })
})

test('list and gc see only the sessions of the Chrome they drive', async () => {
  await twoChromes(async ({ home, ba }) => {
    assert.equal((await ba('new', '-s', 'cf2', '--context', 'work')).code, 0)
    assert.equal((await ba('new', '-s', 'plain')).code, 0)
    const own = await ba('list')
    assert.match(own.all, /plain/)
    assert.doesNotMatch(own.all, /cf2/, 'the context\'s session is not "stale" in the person\'s list')
    assert.match((await ba('list', '--context', 'work')).all, /cf2\s+\[live\] \{work\}/)
    // Against the person's tabs a context's session looks stale — gc must not delete it.
    assert.equal((await ba('gc')).code, 0)
    assert.ok(session(home, 'cf2'), 'gc left the context\'s session alone')
  })
})

test('a new context gets its own port, outside the per-user range', async () => {
  await twoChromes(async ({ home, work, ba }) => {
    await ba('launch', '--context', 'fresh', '--status')
    const rec = JSON.parse(readFileSync(join(home, '.browser-automation', 'contexts', 'fresh.json'), 'utf8'))
    assert.ok(rec.port >= 10323 && rec.port < 11123, `port ${rec.port} in the context block`)
    assert.notEqual(rec.port, work.port)
    assert.ok(existsSync(rec.profileDir), 'its profile folder exists')
  })
})

test('--context after a bare -- is text, not a flag', async () => {
  await twoChromes(async ({ ba }) => {
    const r = await ba('fill', '-s', 'plain', 'e1', '--', '--context ghost')
    assert.doesNotMatch(r.all, /no context named/, r.all)
  })
})

test('context forget refuses a running context, then removes it and its sessions', async () => {
  await twoChromes(async ({ home, work, profileDir, ba }) => {
    assert.equal((await ba('new', '-s', 'cf2', '--context', 'work')).code, 0)
    assert.match((await ba('context')).all, /work\s+:\d+\s+\[running\]\s+sessions: cf2/)
    const busy = await ba('context', 'forget', 'work')
    assert.notEqual(busy.code, 0)
    assert.match(busy.all, /is running — stop it first/)
    await work.close()
    const r = await ba('context', 'forget', 'work')
    assert.equal(r.code, 0, r.all)
    assert.equal(session(home, 'cf2'), null, 'its session is gone too')
    assert.ok(existsSync(profileDir), 'the profile is kept without --delete-profile')
  })
})

test('a context file from the in-memory dev build is replaced, cookies and all', async () => {
  await twoChromes(async ({ home, ba }) => {
    const f = join(home, '.browser-automation', 'contexts', 'old.json')
    writeFileSync(f, JSON.stringify({ name: 'old', browserContextId: 'ABC', cookies: [{ name: 'secret', value: 'login' }] }))
    const r = await ba('read', '-s', 'x', '--context', 'old')
    assert.match(r.all, /no context named "old"/, 'not mistaken for a context with a port')
    await ba('launch', '--context', 'old', '--status')
    const rec = JSON.parse(readFileSync(f, 'utf8'))
    assert.ok(Number.isInteger(rec.port), 'replaced by a separate-Chrome record')
    assert.equal(rec.cookies, undefined, 'and the old cookies are off disk')
  })
})

/** A stand-in automation profile in the test HOME, with what a real one has. */
function fakeAutomationProfile(home) {
  const p = join(home, '.browser-automation', 'chrome-profile')
  for (const d of ['Default/Extensions/abc/1.0', 'Default/Service Worker/Database', 'Default/Cache/Cache_Data', 'Default/Code Cache/js', 'GrShaderCache', 'ba-probe']) {
    mkdirSync(join(p, d), { recursive: true })
  }
  writeFileSync(join(p, 'Local State'), '{}')
  writeFileSync(join(p, 'Default', 'Cookies'), 'cookies')
  writeFileSync(join(p, 'Default', 'Secure Preferences'), '{}')
  writeFileSync(join(p, 'Default', 'Extensions', 'abc', '1.0', 'manifest.json'), '{}')
  writeFileSync(join(p, 'Default', 'Service Worker', 'Database', 'CURRENT'), 'sw')
  writeFileSync(join(p, 'Default', 'Cache', 'Cache_Data', 'blob'), 'x'.repeat(1000))
  writeFileSync(join(p, 'Cookies'), 'a stray root copy')
  symlinkSync('host-123', join(p, 'SingletonLock'))
  return p
}

test('a new context starts EMPTY unless --clone-profile asks for a copy', async () => {
  await twoChromes(async ({ home, ba }) => {
    fakeAutomationProfile(home)
    await ba('launch', '--context', 'blank', '--status')
    const blank = join(home, '.browser-automation', 'contexts', 'blank', 'chrome-profile')
    assert.deepEqual(readdirSync(blank), [], 'no logins, no extensions: a separate account starts from nothing')
  })
})

test('--clone-profile copies the automation profile, without caches or lock files', async () => {
  await twoChromes(async ({ home, ba }) => {
    fakeAutomationProfile(home)
    const r = await ba('launch', '--context', 'seeded', '--clone-profile', '--status')
    assert.match(r.all, /copying the automation profile .* same logins and cookies/, r.all)
    const c = join(home, '.browser-automation', 'contexts', 'seeded', 'chrome-profile')
    for (const kept of ['Local State', 'Default/Cookies', 'Default/Secure Preferences', 'Default/Extensions/abc/1.0/manifest.json', 'Default/Service Worker/Database/CURRENT']) {
      assert.ok(existsSync(join(c, kept)), `kept ${kept}`)
    }
    for (const left of ['Default/Cache', 'Default/Code Cache', 'GrShaderCache', 'SingletonLock', 'Cookies', 'ba-probe']) {
      assert.ok(!existsSync(join(c, left)), `left out ${left}`)
    }
  })
})

test('--clone-profile never touches a context that already exists', async () => {
  await twoChromes(async ({ home, profileDir, ba }) => {
    fakeAutomationProfile(home)
    const r = await ba('port', '--context', 'work', '--clone-profile')
    assert.match(r.all, /already exists, so --clone-profile does nothing/)
    assert.deepEqual(readdirSync(profileDir), [], 'the existing profile is left as it was')
  })
})

test('--clone-profile without --context is refused', async () => {
  await twoChromes(async ({ ba }) => {
    const r = await ba('new', '-s', 'x', '--clone-profile')
    assert.notEqual(r.code, 0)
    assert.match(r.all, /use it with --context <name>/)
  })
})
