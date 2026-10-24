// Resolve a session name -> a live targetId, self-healing when the tab is gone
// (closed, or Chrome restarted and reissued targetIds). This is what makes the
// daemonless model robust: there's no process to "die"; a stale pointer just
// triggers a fresh background tab on the next call.

import { loadSession, saveSession } from './session.js'
import { targetWsUrl, createTab } from './cdp.js'
import { ensureContext } from './contexts.js'

export interface ResolvedTarget {
  targetId: string
  created: boolean
  /** Set when the session's login context had to be re-created (Chrome restarted). */
  contextRestored?: { name: string; cookies: number }
}

export async function resolveLiveTarget(
  name: string,
  { create = true, context }: { create?: boolean; context?: string } = {},
): Promise<ResolvedTarget> {
  const st = loadSession(name)
  if (st) {
    const ws = await targetWsUrl(st.targetId)
    if (ws) {
      // A session's tab cannot change login context: it would silently carry
      // one account's work into the other's window. Say so instead.
      if (context !== undefined && (st.context ?? undefined) !== context) {
        throw new Error(
          `session "${name}" already has a tab in ${st.context ? `context "${st.context}"` : 'your own profile'}, not "${context}" — `
          + `use another session name (-s), or close this one first: browser-automation close -s ${name} --tab`,
        )
      }
      return { targetId: st.targetId, created: false }
    }
  }
  if (!create) {
    throw new Error(`session "${name}" has no live tab — run:  browser-automation goto -s ${name} <url>`)
  }
  // A session remembers its context, so a tab lost to a Chrome restart comes
  // back in the same login — re-created, with its saved cookies, if need be.
  const ctxName = context ?? st?.context
  const ensured = ctxName ? await ensureContext(ctxName) : undefined
  const targetId = await createTab('about:blank', { browserContextId: ensured?.browserContextId })
  saveSession({ name, targetId, createdAt: new Date().toISOString(), url: st?.url, ...(ctxName ? { context: ctxName } : {}) })
  return {
    targetId,
    created: true,
    ...(ctxName && ensured?.created ? { contextRestored: { name: ctxName, cookies: ensured.restored } } : {}),
  }
}

export function isValidRef(ref: string): boolean {
  return /^e\d+$/.test(ref)
}

// Schemes that are valid without "//" — leave them untouched.
const NO_SLASH_SCHEMES = /^(data|about|blob|file|chrome|view-source|javascript):/i

/** Add https:// to a bare host/path; leave full URLs and schemeless schemes alone. */
export function normalizeUrl(input: string): string {
  if (input.includes('://') || NO_SLASH_SCHEMES.test(input)) return input
  return `https://${input}`
}
