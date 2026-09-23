// Where the Chrome profile lives, and moving it out of Chrome's own folder.
//
// The old default, ~/Library/Application Support/Google/Chrome/browser-automation,
// sits inside Google Chrome's app-data container, which macOS guards per HOST app
// (kTCCServiceSystemPolicyAppData). A session started from a terminal that was
// once allowed reaches it; a session started by an app that was not — Clerk.AI,
// denied 2026-08-02 and silently refused ever since — gets EPERM, and Chrome dies
// on its own SingletonLock. A folder under ~ belongs to no app, so every host
// reaches it.
//
// What these tests guard is mostly what the MOVE must never do. An earlier fix
// (reverted in rememberthis.ai, d43b13b) repointed the profile at an empty
// folder, which signs the person out of every bank and supplier portal they use.
// So: a profile that cannot be read is still a profile that exists, a refused
// move falls back to the old folder rather than to a fresh one, and a profile a
// running Chrome has open is never moved underneath it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync,
  lstatSync, chmodSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

function paths(home) {
  const chromeDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  return {
    chromeDir,
    legacy: join(chromeDir, 'browser-automation'),
    current: join(home, '.browser-automation', 'chrome-profile'),
  }
}

/** A HOME, optionally holding a legacy profile with a recognisable file in it. */
function home({ legacy = false, current = false } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'ba-profile-'))
  const p = paths(h)
  if (legacy) {
    mkdirSync(join(p.legacy, 'Default'), { recursive: true })
    writeFileSync(join(p.legacy, 'Default', 'Cookies'), 'the logins')
    // What a Chrome that exited uncleanly leaves behind.
    symlinkSync('some-host-12345', join(p.legacy, 'SingletonLock'))
  }
  if (current) {
    mkdirSync(p.current, { recursive: true })
    writeFileSync(join(p.current, 'marker'), 'already here')
  }
  return { h, ...p }
}

function cli(h, argv, env = {}) {
  const { BROWSER_AUTOMATION_PROFILE: _, ...base } = process.env
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    env: { ...base, HOME: h, ...env },
    encoding: 'utf8',
    timeout: 15000,
  })
  return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' }
}

const cleanup = (h) => {
  // A test may have made a directory unreadable; give it back before deleting.
  spawnSync('chmod', ['-R', 'u+rwx', h])
  rmSync(h, { recursive: true, force: true })
}

test('a new machine gets the home-folder profile, and nothing is created early', (t) => {
  const x = home()
  t.after(() => cleanup(x.h))
  assert.equal(cli(x.h, ['profile']).out, x.current)
  const m = cli(x.h, ['profile', '--migrate'])
  assert.equal(m.code, 0, m.err)
  assert.equal(existsSync(x.current), false, 'Chrome creates it on first launch; we should not')
})

test('an existing profile is MOVED, with its logins, and the stale lock is cleared', (t) => {
  const x = home({ legacy: true })
  t.after(() => cleanup(x.h))
  // Before migrating, the answer is the folder that holds the logins.
  assert.equal(cli(x.h, ['profile']).out, x.legacy)
  const m = cli(x.h, ['profile', '--migrate'])
  assert.equal(m.code, 0, m.err)
  assert.equal(readFileSync(join(x.current, 'Default', 'Cookies'), 'utf8'), 'the logins')
  assert.equal(existsSync(x.legacy), false, 'moved, not copied — two profiles is two sets of logins drifting')
  assert.throws(() => lstatSync(join(x.current, 'SingletonLock')), 'a dead lock must not ride along')
  assert.equal(cli(x.h, ['profile']).out, x.current)
})

test('when both exist, the home-folder one wins and the old one is left alone', (t) => {
  const x = home({ legacy: true, current: true })
  t.after(() => cleanup(x.h))
  assert.equal(cli(x.h, ['profile']).out, x.current)
  cli(x.h, ['profile', '--migrate'])
  assert.equal(readFileSync(join(x.legacy, 'Default', 'Cookies'), 'utf8'), 'the logins')
  assert.equal(readFileSync(join(x.current, 'marker'), 'utf8'), 'already here')
})

test('a REFUSED move keeps using the old profile and creates no empty one', (t) => {
  const x = home({ legacy: true })
  t.after(() => cleanup(x.h))
  // The rename needs to write Chrome's folder, which is what a denied host cannot do.
  chmodSync(x.chromeDir, 0o555)
  const m = cli(x.h, ['profile', '--migrate'])
  assert.notEqual(m.code, 0, 'a move that did not happen must not report success')
  assert.match(m.out + m.err, /could not move|refused|permission/i)
  assert.equal(existsSync(x.current), false, 'an empty profile here signs the person out of everything')
  assert.equal(cli(x.h, ['profile']).out, x.legacy)
})

test('an UNREADABLE old profile still counts as existing — never "no profile, start fresh"', (t) => {
  const x = home({ legacy: true })
  t.after(() => cleanup(x.h))
  // Stat on the profile itself now fails with EACCES: the shape a denied host sees.
  chmodSync(x.chromeDir, 0o000)
  assert.equal(cli(x.h, ['profile']).out, x.legacy)
  const m = cli(x.h, ['profile', '--migrate'])
  assert.notEqual(m.code, 0)
  assert.equal(existsSync(x.current), false)
})

test('a profile a running Chrome has open is not moved underneath it', async (t) => {
  const x = home({ legacy: true })
  // Anything whose command line carries the flag is what pgrep sees; a real
  // Chrome is not needed to prove the check is made.
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', `--user-data-dir=${x.legacy}`])
  t.after(() => { holder.kill(); cleanup(x.h) })
  await new Promise((r) => setTimeout(r, 300))
  const m = cli(x.h, ['profile', '--migrate'])
  assert.notEqual(m.code, 0)
  assert.match(m.out + m.err, /in use|running/i)
  assert.equal(readFileSync(join(x.legacy, 'Default', 'Cookies'), 'utf8'), 'the logins')
  assert.equal(existsSync(x.current), false)
})

test('BROWSER_AUTOMATION_PROFILE is obeyed and never migrated', (t) => {
  const x = home({ legacy: true })
  t.after(() => cleanup(x.h))
  const mine = join(x.h, 'mine')
  assert.equal(cli(x.h, ['profile'], { BROWSER_AUTOMATION_PROFILE: mine }).out, mine)
  cli(x.h, ['profile', '--migrate'], { BROWSER_AUTOMATION_PROFILE: mine })
  assert.equal(existsSync(x.legacy), true)
  assert.equal(existsSync(x.current), false)
})
