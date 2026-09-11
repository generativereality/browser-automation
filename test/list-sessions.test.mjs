// `list` has to stay readable on a machine that has run many sessions.
//
// 2026-09-11: `browser-automation list` printed 105 session lines, most of them
// [stale], for a Chrome holding 24 tabs. Nothing prunes
// ~/.browser-automation/sessions/, so it accumulates one file per session name
// for ever. The cost was not cosmetic — the wall of session lines was read as
// "there are a hundred tabs open", which became the leading theory for a
// renderer failure that had nothing to do with tab count, and hours went into
// it. (A healthy Chrome has been driven to 421 tabs with every renderer alive.)
//
// So: live sessions are the list; stale ones are a number and the command that
// clears them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startFakeChrome } from './fake-chrome.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js')

/** A HOME holding `names` as session bookmarks, all pointing at dead tabs. */
function homeWithSessions(names, liveTargetId) {
  const home = mkdtempSync(join(tmpdir(), 'ba-home-'))
  const dir = join(home, '.browser-automation', 'sessions')
  mkdirSync(dir, { recursive: true })
  for (const [i, name] of names.entries()) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({
      name,
      targetId: name === 'alive' && liveTargetId ? liveTargetId : `DEADBEEF${String(i).padStart(24, '0')}`,
      url: 'https://example.test/',
      createdAt: new Date().toISOString(),
    }))
  }
  return home
}

function run(endpoint, home, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, HOME: home, NO_COLOR: '1', NO_UPDATE_NOTIFIER: '1', BROWSER_AUTOMATION_CDP: endpoint },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let all = ''
    child.stdout.on('data', (d) => { all += d })
    child.stderr.on('data', (d) => { all += d })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000)
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, all }) })
  })
}

const MANY = Array.from({ length: 60 }, (_, i) => `stale-${i}`)

test('stale session bookmarks are summarised, not enumerated', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: true })
  t.after(() => chrome.close())
  const home = homeWithSessions(MANY)
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const r = await run(chrome.endpoint, home, ['list'])
  assert.equal(r.code, 0, `list failed:\n${r.all}`)

  const staleLines = r.all.split('\n').filter((l) => /\[stale\]/.test(l))
  assert.equal(staleLines.length, 0,
    `printed ${staleLines.length} stale session lines; they belong in a count:\n${r.all}`)
  assert.match(r.all, /60 stale/,
    `never said how many stale bookmarks there are:\n${r.all}`)
  assert.match(r.all, /gc/,
    `never named the command that clears them:\n${r.all}`)
})

test('live sessions are still listed in full', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: true })
  t.after(() => chrome.close())
  // Give the fake a real tab, and point a session at it.
  const opened = await run(chrome.endpoint, mkdtempSync(join(tmpdir(), 'ba-seed-')), ['new', '-s', 'seed'])
  assert.equal(opened.code, 0, opened.all)
  const live = (await (await fetch(`${chrome.endpoint}/json/list`)).json())[0].id

  const home = homeWithSessions([...MANY, 'alive'], live)
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const r = await run(chrome.endpoint, home, ['list'])
  assert.match(r.all, /alive.*\[live\]/,
    `dropped a live session from the list:\n${r.all}`)
})

test('--all still shows every bookmark, for when that is the question', async (t) => {
  const chrome = await startFakeChrome({ rendererAnswers: true })
  t.after(() => chrome.close())
  const home = homeWithSessions(MANY)
  t.after(() => rmSync(home, { recursive: true, force: true }))

  const r = await run(chrome.endpoint, home, ['list', '--all'])
  const staleLines = r.all.split('\n').filter((l) => /\[stale\]/.test(l))
  assert.equal(staleLines.length, 60,
    `--all should list all 60 stale bookmarks, printed ${staleLines.length}:\n${r.all}`)
})
