// Login contexts: a SEPARATE Chrome per extra account — its own profile folder
// and its own debugging port — started on demand, next to the user's own
// automation Chrome. For a second login beside the first: two Cloudflare
// dashboards, a client's Google account next to the user's.
//
// # Why a whole Chrome, measured 2026-10-24 (issue #31)
//
// Chrome has nothing like Firefox's Multi-Account Containers, and a tab group
// shares its profile's cookies. The lighter routes each failed on something a
// person needs:
//
//   - A second Chrome PROFILE in the same Chrome becomes Chrome's default while
//     its window is open: every OTHER session's new tab opens there, logged
//     out, and naming the user's profile is rejected, so nothing steers them
//     back.
//   - A CDP browser context (`Target.createBrowserContext`) isolates cookies
//     and leaves other sessions alone, but extensions cannot see its tabs:
//     Bitwarden's worker answered `No tab with id` / `No window with id`, so its
//     passkeys and autofill never worked there. It is also memory-only.
//
// A separate Chrome is a real profile: extensions installed in it stay, logins
// persist across restarts, and the user's own Chrome is not touched at all.
//
// # How it plugs in
//
// The entry point (commands/index.ts) works out which context a command is for
// — `--context <name>`, `BAC_CONTEXT`, or the context the session was opened
// in — and sets `BROWSER_AUTOMATION_CONTEXT`. `cdpPort()` and
// `resolveProfile()`, the one place each of those is decided, then answer for
// that context's Chrome, so every command — `launch`, `doctor`, `list`, every
// page command — drives it without knowing contexts exist.
//
// This file only reads and writes the registry; it imports nothing that talks
// to Chrome, so cdp.ts and profile.ts can use it.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export interface ContextRecord {
  name: string
  /** Allocated once (cdp.ts, allocateContextPort) and kept, so the context's Chrome is always found in the same place. */
  port: number
  /** Its Chrome's --user-data-dir. */
  profileDir: string
  createdAt: string
}

export function contextsDir(): string {
  return join(homedir(), '.browser-automation', 'contexts')
}

function file(name: string): string {
  return join(contextsDir(), `${name}.json`)
}

export function contextProfileDir(name: string): string {
  return join(contextsDir(), name, 'chrome-profile')
}

export function validContextName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

export function loadContextRecord(name: string): ContextRecord | null {
  if (!validContextName(name)) return null
  const f = file(name)
  if (!existsSync(f)) return null
  try {
    const r = JSON.parse(readFileSync(f, 'utf8')) as Partial<ContextRecord>
    // A record without a port is not a separate-Chrome context. The one known
    // case is a file left by the unreleased in-memory version (0.6.0-dev.1),
    // which held a CDP context id and its COOKIES in plain JSON. Treated as
    // absent, so the next `new`/`goto --context` overwrites it — which also
    // takes those cookies off disk.
    if (!Number.isInteger(r.port) || typeof r.profileDir !== 'string') return null
    return r as ContextRecord
  } catch { return null }
}

export function saveContextRecord(r: ContextRecord): void {
  mkdirSync(contextsDir(), { recursive: true })
  const tmp = `${file(r.name)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(r, null, 2))
  renameSync(tmp, file(r.name))
}

export function removeContextRecord(name: string): void {
  rmSync(file(name), { force: true })
}

export function listContextRecords(): ContextRecord[] {
  if (!existsSync(contextsDir())) return []
  return readdirSync(contextsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadContextRecord(f.slice(0, -'.json'.length)))
    .filter((r): r is ContextRecord => r !== null)
}

/** The context this process is driving, as set by the entry point. Undefined = the user's own Chrome. */
export function activeContextName(): string | undefined {
  return process.env.BROWSER_AUTOMATION_CONTEXT || undefined
}

export function activeContext(): ContextRecord | null {
  const name = activeContextName()
  return name ? loadContextRecord(name) : null
}
