// Login contexts: tabs that hold a DIFFERENT login next to the user's own —
// two Cloudflare dashboards, two Google accounts — inside the one shared Chrome.
//
// # Why a CDP browser context, and not a tab group or a Chrome profile
//
// Chrome has nothing like Firefox's Multi-Account Containers. A tab group
// shares its profile's cookies, so it cannot hold a second login. Measured
// 2026-10-24 on Chrome 155 / macOS 27 (issue #31):
//
//   - A second Chrome PROFILE in the same Chrome persists, but while its window
//     is open Chrome treats it as the default: every plain `Target.createTarget`
//     — every other session's `new`/`goto`, every older CLI — opens there,
//     logged out. Naming the user's profile's context id is rejected ("Failed
//     to find browser context"), so it cannot be steered back. Ruled out.
//   - `Target.createBrowserContext({ disposeOnDetach: false })` makes an
//     incognito-like context: its own cookie jar (isolated both ways), its own
//     window, opened without raising Chrome, and it survives the CLI
//     disconnecting. Plain tabs keep landing in the user's profile meanwhile.
//     That is what this uses.
//
// # The one thing a CDP context lacks: persistence
//
// It lives in memory and dies with Chrome. So the CLI keeps each context's
// cookies in ~/.browser-automation/contexts/<name>.json (0600, directory 0700)
// and writes them back when it has to re-create the context — a restarted
// Chrome no longer knows the old id. Saved whenever a command touches a tab in
// the context, and before `launch --restart`. Cookies only: a site that keeps
// its login in localStorage still needs a fresh sign-in after a restart.
//
// ⚠️ These are the context's login cookies, in plain JSON. Chrome encrypts its
// own cookie store with a Keychain key; this file is protected only by its
// permissions. `context forget <name>` deletes it.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import {
  createBrowserContext,
  disposeBrowserContext,
  getContextCookies,
  liveBrowserContexts,
  setContextCookies,
  targetContext,
  type CdpCookie,
} from './cdp.js'

export interface ContextState {
  name: string
  /** The id in the Chrome that last ran it; stale after a Chrome restart. */
  browserContextId?: string
  savedAt?: string
  cookies: CdpCookie[]
}

function dir(): string {
  return join(homedir(), '.browser-automation', 'contexts')
}

function file(name: string): string {
  return join(dir(), `${name}.json`)
}

export function validContextName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

function assertName(name: string): void {
  if (!validContextName(name)) {
    throw new Error(`invalid context name "${name}": use letters, digits, '.', '_' or '-' (max 64), starting with a letter or digit`)
  }
}

export function loadContext(name: string): ContextState | null {
  const f = file(name)
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, 'utf8')) as ContextState
}

/** Atomic and private: two commands saving at once must never leave half a file. */
function writeContext(st: ContextState): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  try { chmodSync(dir(), 0o700) } catch {}
  const tmp = `${file(st.name)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 })
  renameSync(tmp, file(st.name))
}

export function listContexts(): ContextState[] {
  if (!existsSync(dir())) return []
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(dir(), f), 'utf8')) as ContextState } catch { return null }
    })
    .filter((c): c is ContextState => c !== null)
}

/** CDP cookie -> `Storage.setCookies` param. Session cookies go back as session cookies. */
function toCookieParam(c: CdpCookie): Record<string, unknown> {
  const p: Record<string, unknown> = { name: c.name, value: c.value, domain: c.domain, path: c.path }
  for (const k of ['secure', 'httpOnly', 'sameSite', 'priority', 'sourceScheme', 'sourcePort', 'partitionKey'] as const) {
    if (c[k] !== undefined) p[k] = c[k]
  }
  if (!c.session && c.expires > 0) p.expires = c.expires
  return p
}

function unexpired(cookies: CdpCookie[], now = Date.now() / 1000): CdpCookie[] {
  return cookies.filter((c) => c.session || !(c.expires > 0) || c.expires > now)
}

export interface EnsuredContext {
  browserContextId: string
  /** True when Chrome did not know the context and it was made anew. */
  created: boolean
  /** Cookies written back into a re-created context. */
  restored: number
}

/** The live context for `name`, re-creating it (and its saved cookies) when Chrome no longer has it. */
export async function ensureContext(name: string): Promise<EnsuredContext> {
  assertName(name)
  const st = loadContext(name) ?? { name, cookies: [] }
  if (st.browserContextId && (await liveBrowserContexts()).includes(st.browserContextId)) {
    return { browserContextId: st.browserContextId, created: false, restored: 0 }
  }
  const id = await createBrowserContext()
  const cookies = unexpired(st.cookies)
  let restored = 0
  if (cookies.length) {
    try {
      await setContextCookies(id, cookies.map(toCookieParam))
      restored = cookies.length
    } catch {
      // One cookie Chrome rejects fails the whole batch; put back what it takes.
      for (const c of cookies) {
        try { await setContextCookies(id, [toCookieParam(c)]); restored++ } catch {}
      }
    }
  }
  writeContext({ ...st, browserContextId: id, cookies })
  return { browserContextId: id, created: true, restored }
}

/**
 * Save the cookies of `name`'s live context. Returns how many, or null when
 * Chrome no longer has that context (nothing is read then — see
 * withKnownContext in core/cdp.ts for why that matters).
 */
export async function saveContext(name: string): Promise<number | null> {
  const st = loadContext(name)
  if (!st?.browserContextId) return null
  if (!(await liveBrowserContexts()).includes(st.browserContextId)) return null
  const cookies = await getContextCookies(st.browserContextId)
  writeContext({ ...st, cookies, savedAt: new Date().toISOString() })
  return cookies.length
}

/** Save every context Chrome still has. For `launch --restart`, before the browser goes. */
export async function saveAllContexts(): Promise<{ saved: string[] }> {
  const saved: string[] = []
  const all = listContexts()
  if (!all.length) return { saved }
  const live = await liveBrowserContexts()
  for (const c of all) {
    if (c.browserContextId && live.includes(c.browserContextId)) {
      if ((await saveContext(c.name).catch(() => null)) !== null) saved.push(c.name)
    }
  }
  return { saved }
}

/**
 * Best-effort: when a command touches a tab that lives in one of our contexts,
 * save that context's cookies — this is how a login done by hand in the
 * context's window gets kept. Free when no context exists, which is everyone
 * who never uses one: it reads no target info at all then.
 */
export async function rememberContextOf(targetId: string): Promise<void> {
  try {
    const all = listContexts()
    if (!all.length) return
    const ctx = await targetContext(targetId)
    if (!ctx) return
    const mine = all.find((c) => c.browserContextId === ctx)
    if (mine) await saveContext(mine.name)
  } catch {
    // Never let bookkeeping fail the command the user asked for.
  }
}

/** Delete the saved cookies; with `close`, also close the live context and its tabs. */
export async function forgetContext(name: string, { close = false }: { close?: boolean } = {}): Promise<{ existed: boolean; closed: boolean }> {
  assertName(name)
  const st = loadContext(name)
  let closed = false
  if (close && st?.browserContextId && (await liveBrowserContexts()).includes(st.browserContextId)) {
    await disposeBrowserContext(st.browserContextId)
    closed = true
  }
  if (st) rmSync(file(name), { force: true })
  return { existed: !!st, closed }
}
