// Which Chrome binary `launch` uses — read back through `doctor`, which reports it.
//
// Mind My Money's first run installs Chrome itself when it is missing: into
// /Applications when that is writable, otherwise ~/Applications (an account that
// cannot write /Applications). The launch script hardcoded
// /Applications/Google Chrome.app and overwrote $CHROME, so a Chrome in
// ~/Applications could not be launched at all (2026-10-05).
//
// The order these pin: an explicit BROWSER_AUTOMATION_CHROME / CHROME that points
// at an executable; then /Applications; then ~/Applications. An explicit path
// that is NOT executable is ignored with a warning rather than handed to `open`.
//
// /Applications is injected via BROWSER_AUTOMATION_TEST_SYSTEM_APPS: this Mac has
// a real Chrome there, which would otherwise win every fallback case.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')
const MAC = process.platform === 'darwin'
const BIN = ['Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome']

function fakeChrome(appsDir) {
  const p = join(appsDir, ...BIN)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ba-chrome-'))
  const home = join(root, 'home'), sys = join(root, 'system-apps')
  mkdirSync(home, { recursive: true }); mkdirSync(sys, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { home, sys }
}

function doctor({ home, sys }, env = {}) {
  const { CHROME: _a, BROWSER_AUTOMATION_CHROME: _b, ...base } = process.env
  const r = spawnSync(process.execPath, [CLI, 'doctor'], {
    env: {
      ...base, HOME: home, NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1',
      BROWSER_AUTOMATION_CDP: 'http://127.0.0.1:9', // nothing there: doctor stops after setup
      BROWSER_AUTOMATION_TEST_SYSTEM_APPS: sys,
      ...env,
    },
    encoding: 'utf8', timeout: 20000,
  })
  const line = (r.stdout + r.stderr).split('\n').find((l) => /Chrome binary/i.test(l)) ?? ''
  return line
}

test('CHROME pointing at an executable is used', (t) => {
  const x = setup(t)
  const custom = join(x.home, 'custom-chrome')
  writeFileSync(custom, '#!/bin/sh\nexit 0\n'); chmodSync(custom, 0o755)
  assert.match(doctor(x, { CHROME: custom }), new RegExp(custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('BROWSER_AUTOMATION_CHROME is honoured too', (t) => {
  const x = setup(t)
  const custom = join(x.home, 'ba-chrome')
  writeFileSync(custom, '#!/bin/sh\nexit 0\n'); chmodSync(custom, 0o755)
  assert.match(doctor(x, { BROWSER_AUTOMATION_CHROME: custom }), /ba-chrome/)
})

test('/Applications wins over ~/Applications when both have Chrome', { skip: !MAC }, (t) => {
  const x = setup(t)
  const sysChrome = fakeChrome(x.sys)
  fakeChrome(join(x.home, 'Applications'))
  assert.ok(doctor(x).includes(sysChrome), doctor(x))
})

test('a Chrome only in ~/Applications is found', { skip: !MAC }, (t) => {
  const x = setup(t)
  const userChrome = fakeChrome(join(x.home, 'Applications'))
  assert.ok(doctor(x).includes(userChrome), `expected ${userChrome} in: ${doctor(x)}`)
})

test('a CHROME that is not executable is ignored, and the fallback still works', { skip: !MAC }, (t) => {
  const x = setup(t)
  const userChrome = fakeChrome(join(x.home, 'Applications'))
  const line = doctor(x, { CHROME: join(x.home, 'no-such-chrome') })
  assert.ok(line.includes(userChrome), line)
})

test('no Chrome anywhere is reported as such, not as a path that does not exist', { skip: !MAC }, (t) => {
  const x = setup(t)
  assert.match(doctor(x), /not found/i)
})
