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
const FAKE_PIPE = join(dirname(fileURLToPath(import.meta.url)), 'fake-chrome-pipe.mjs')

/**
 * A context's Chrome, as it really runs since contexts moved onto the pipe: its
 * own broker (`browser-automation broker` with the context set), serving a fake
 * pipe Chrome that logs every method it is sent. `stats` reads that log, in the
 * same shape fake-chrome.mjs gives the person's own Chrome.
 */
async function startFakeContextChrome(home, name, port) {
  const events = join(home, `${name}-events.log`)
  writeFileSync(events, '')
  const { BAC_CONTEXT: _c, BAC_SESSION: _s, BROWSER_AUTOMATION_CDP: _p, ...base } = process.env
  const broker = spawn(process.execPath, [CLI, 'broker', '--context', name, '--chrome', FAKE_PIPE, '--profile', join(home, `${name}-profile`), '--log', join(home, `${name}-chrome.log`)], {
    env: { ...base, HOME: home, FAKE_EVENTS: events, NO_UPDATE_NOTIFIER: '1' },
    stdio: 'ignore',
  })
  const state = join(home, '.browser-automation', 'contexts', name, 'broker.json')
  for (let i = 0; i < 200 && !existsSync(state); i++) await new Promise((r) => setTimeout(r, 50))
  if (!existsSync(state)) { broker.kill('SIGKILL'); throw new Error(`the broker for context "${name}" never served`) }
  const lines = () => readFileSync(events, 'utf8').split('\n')
  let closed = false
  return {
    port,
    stats: {
      get createTargets() { return lines().filter((l) => l === 'method browser Target.createTarget').length },
      get pageMethods() { return lines().filter((l) => l.startsWith('method page ')).map((l) => l.slice('method page '.length)) },
    },
    async close() {
      if (closed) return
      closed = true
      broker.kill('SIGTERM')
      for (let i = 0; i < 200 && existsSync(state); i++) await new Promise((r) => setTimeout(r, 50))
      broker.kill('SIGKILL')
    },
  }
}

function run(endpoint, argv, home, extraEnv = {}) {
  return new Promise((resolve) => {
    const { BAC_CONTEXT: _c, BAC_SESSION: _s, BROWSER_AUTOMATION_CONTEXT: _a, ...base } = process.env
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: {
        ...base,
        ...extraEnv,
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
  // Under /tmp, not os.tmpdir(): the context's socket lives in here, and a Unix
  // socket path is capped at ~104 bytes on macOS, where $TMPDIR is long.
  const home = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'ba-ctx-') : '/tmp/ba-ctx-')
  const profileDir = join(home, '.browser-automation', 'contexts', 'work', 'chrome-profile')
  mkdirSync(profileDir, { recursive: true })
  // A port is still recorded (an old Chrome of the context may hold it), but nothing listens there.
  writeFileSync(join(home, '.browser-automation', 'contexts', 'work.json'),
    JSON.stringify({ name: 'work', port: 10400, profileDir, createdAt: new Date().toISOString() }))
  const work = await startFakeContextChrome(home, 'work', 10400)
  try {
    await fn({
      own, work, home, profileDir,
      ba: (...argv) => run(own.endpoint, argv, home),
      baWith: (env, ...argv) => run(own.endpoint, argv, home, env),
    })
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
    assert.match((await ba('context')).all, /work\s+\[running\].*sessions: cf2/)
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
  writeFileSync(join(p, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Your Chrome', gaia_id: '123', user_name: 'me@personal.example' } } } }))
  writeFileSync(join(p, 'Default', 'Preferences'), JSON.stringify({ account_info: [{ email: 'me@personal.example' }], google: { services: { signin: {} } }, profile: { name: 'Your Chrome', exit_type: 'Crashed' } }))
  for (const f of ['Login Data', 'Web Data', 'History']) writeFileSync(join(p, 'Default', f), 'site data')
  mkdirSync(join(p, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
  mkdirSync(join(p, 'Default', 'Service Worker', 'CacheStorage'), { recursive: true })
  mkdirSync(join(p, 'Default', 'Local Extension Settings', 'abc'), { recursive: true })
  writeFileSync(join(p, 'Default', 'Local Extension Settings', 'abc', 'CURRENT'), 'ext data')
  writeFileSync(join(p, 'Default', 'Cookies'), 'cookies')
  writeFileSync(join(p, 'Default', 'Secure Preferences'), '{}')
  writeFileSync(join(p, 'Default', 'Extensions', 'abc', '1.0', 'manifest.json'), '{}')
  writeFileSync(join(p, 'Default', 'Service Worker', 'Database', 'CURRENT'), 'sw')
  writeFileSync(join(p, 'Default', 'Cache', 'Cache_Data', 'blob'), 'x'.repeat(1000))
  writeFileSync(join(p, 'Cookies'), 'a stray root copy')
  symlinkSync('host-123', join(p, 'SingletonLock'))
  return p
}

const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
const ctxDir = (home, name) => join(home, '.browser-automation', 'contexts', name, 'chrome-profile')

test('a new context gets the automation profile\'s EXTENSIONS, not its logins, and is not signed in to Chrome', async () => {
  await twoChromes(async ({ home, ba }) => {
    fakeAutomationProfile(home)
    const r = await ba('launch', '--context', 'proj', '--status')
    assert.match(r.all, /copying the EXTENSIONS .* no site logins/, r.all)
    const c = ctxDir(home, 'proj')
    for (const kept of ['Default/Extensions/abc/1.0/manifest.json', 'Default/Local Extension Settings/abc/CURRENT', 'Default/Service Worker/Database/CURRENT', 'Default/Secure Preferences']) {
      assert.ok(existsSync(join(c, kept)), `kept ${kept}`)
    }
    for (const left of ['Default/Cookies', 'Default/Login Data', 'Default/Web Data', 'Default/History', 'Default/Local Storage', 'Default/Service Worker/CacheStorage',
      'Default/Cache', 'Default/Code Cache', 'GrShaderCache', 'SingletonLock', 'Cookies', 'ba-probe']) {
      assert.ok(!existsSync(join(c, left)), `left out ${left}`)
    }
    const prefs = read(join(c, 'Default', 'Preferences'))
    assert.equal(prefs.account_info, undefined, "Chrome's own Google sign-in is not copied")
    assert.equal(prefs.google, undefined)
    const cache = read(join(c, 'Local State')).profile.info_cache.Default
    assert.equal(cache.gaia_id, undefined)
    assert.equal(cache.user_name, undefined)
  })
})

test('every new context is named after itself and gets its own window colour', async () => {
  await twoChromes(async ({ home, ba }) => {
    fakeAutomationProfile(home)
    await ba('launch', '--context', 'one', '--status')
    await ba('launch', '--context', 'two', '--empty-profile', '--status')
    const recs = ['one', 'two'].map((n) => read(join(home, '.browser-automation', 'contexts', `${n}.json`)))
    assert.ok(recs[0].color && recs[1].color && recs[0].color !== recs[1].color, `distinct colours: ${recs.map((r) => r.color)}`)
    for (const n of ['one', 'two']) {
      const prefs = read(join(ctxDir(home, n), 'Default', 'Preferences'))
      assert.equal(prefs.profile.name, n)
      assert.ok(Number.isInteger(prefs.browser.theme.user_color2), 'the colour key Chrome 155 reads')
      assert.equal(prefs.browser.theme.color_variant2, 3)
      assert.equal(prefs.extensions.theme.id, 'user_color_theme_id')
      assert.equal(read(join(ctxDir(home, n), 'Local State')).profile.info_cache.Default.name, n)
    }
    assert.equal(read(join(ctxDir(home, 'one'), 'Default', 'Preferences')).profile.exit_type, 'Normal', 'no "Restore pages?" on first start')
  })
})

test('--full-copy takes the logins and Chrome sign-in too', async () => {
  await twoChromes(async ({ home, ba }) => {
    fakeAutomationProfile(home)
    const r = await ba('launch', '--context', 'all', '--full-copy', '--status')
    assert.match(r.all, /FULL copy .* every login and cookie/, r.all)
    const c = ctxDir(home, 'all')
    for (const kept of ['Default/Cookies', 'Default/Login Data', 'Default/Extensions/abc/1.0/manifest.json']) assert.ok(existsSync(join(c, kept)), `kept ${kept}`)
    assert.ok(!existsSync(join(c, 'Default/Cache')), 'caches still left out')
    assert.deepEqual(read(join(c, 'Default', 'Preferences')).account_info, [{ email: 'me@personal.example' }])
  })
})

test('--empty-profile starts a new context with no extensions and no logins', async () => {
  await twoChromes(async ({ home, ba }) => {
    fakeAutomationProfile(home)
    await ba('launch', '--context', 'blank', '--empty-profile', '--status')
    const c = ctxDir(home, 'blank')
    for (const left of ['Default/Extensions', 'Default/Cookies', 'Default/Local Extension Settings']) assert.ok(!existsSync(join(c, left)), `no ${left}`)
  })
})

test('with no automation profile yet, a new context starts empty', async () => {
  await twoChromes(async ({ home, ba }) => {
    const r = await ba('launch', '--context', 'first', '--status')
    assert.equal(r.code === null, false)
    assert.ok(!existsSync(join(ctxDir(home, 'first'), 'Default', 'Extensions')))
  })
})

test('an existing context is never re-seeded', async () => {
  await twoChromes(async ({ home, profileDir, ba }) => {
    fakeAutomationProfile(home)
    assert.equal((await ba('port', '--context', 'work')).code, 0)
    assert.deepEqual(readdirSync(profileDir), [], 'the existing profile is left as it was')
    assert.match((await ba('port', '--context', 'work', '--empty-profile')).all, /already exists, so --empty-profile does nothing/)
  })
})

test('--empty-profile or --full-copy without --context is refused', async () => {
  await twoChromes(async ({ ba }) => {
    for (const f of ['--empty-profile', '--full-copy']) {
      const r = await ba('new', '-s', 'x', f)
      assert.notEqual(r.code, 0)
      assert.match(r.all, /use it with --context <name>/)
    }
  })
})

test('BAC_CONTEXT is a project default: new sessions use it, existing ones keep their own Chrome', async () => {
  await twoChromes(async ({ own, work, home, baWith }) => {
    // A session opened in the person's own Chrome before the project default was set.
    assert.equal((await baWith({}, 'new', '-s', 'old')).code, 0)
    const env = { BAC_CONTEXT: 'work' }
    const r = await baWith(env, 'goto', '-s', 'old', 'https://a.example.test')
    assert.equal(r.code, 0, `an inherited default must not error on an existing session:\n${r.all}`)
    assert.ok(own.stats.pageMethods.includes('Page.navigate'), 'and it stays in the Chrome it was opened in')
    assert.equal((await baWith(env, 'new', '-s', 'fresh')).code, 0)
    assert.equal(work.stats.createTargets, 1, 'a new session goes to the project context')
    assert.equal(session(home, 'fresh').context, 'work')
    assert.match((await baWith(env, 'list')).all, /in context "work"'s Chrome/, 'session-less commands follow it too')
  })
})

test('context lists the person\'s own Chrome too, and marks the project default', async () => {
  await twoChromes(async ({ baWith }) => {
    await baWith({}, 'new', '-s', 'mine')
    const r = await baWith({ BAC_CONTEXT: 'work' }, 'context')
    assert.match(r.all, /\(your automation Chrome\)\s+\[running\].*sessions: mine/)
    assert.match(r.all, /work\s+\[running\].*← BAC_CONTEXT/)
  })
})
