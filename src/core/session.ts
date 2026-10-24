// Per-session state: one tiny JSON file per named session mapping a session
// name -> the targetId it owns. This is the ONLY thing that persists between
// CLI invocations (besides Chrome itself). Per-file (not one shared file) so
// concurrent sessions never contend on a lock.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { activeContextName } from './context-store.js'

const DIR = join(homedir(), '.browser-automation', 'sessions')

export interface SessionState {
  name: string
  targetId: string
  url?: string
  createdAt: string
  /** The login context (core/context-store.ts) whose Chrome holds this tab; absent = the user's own Chrome. */
  context?: string
}

function file(name: string): string {
  return join(DIR, `${encodeURIComponent(name)}.json`)
}

export function defaultSessionName(): string {
  return process.env.BAC_SESSION || 'default'
}

export function saveSession(s: SessionState): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(file(s.name), JSON.stringify(s, null, 2))
}

export function loadSession(name: string): SessionState | null {
  const f = file(name)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as SessionState) : null
}

export function deleteSession(name: string): void {
  const f = file(name)
  if (existsSync(f)) rmSync(f)
}

/** Every session, whichever Chrome its tab is in. */
export function listAllSessions(): SessionState[] {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as SessionState)
}

/**
 * The sessions whose tab is in the Chrome THIS command drives — the user's
 * own, or the active login context's (core/context-store.ts). Everything that
 * compares sessions against the open tabs uses this: against one Chrome's
 * tabs, another Chrome's sessions all look stale, and `gc` would delete them.
 */
export function listSessions(): SessionState[] {
  const ctx = activeContextName()
  return listAllSessions().filter((s) => (s.context ?? undefined) === ctx)
}
