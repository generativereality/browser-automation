// Resolve a session name -> a live targetId, self-healing when the tab is gone
// (closed, or Chrome restarted and reissued targetIds). This is what makes the
// daemonless model robust: there's no process to "die"; a stale pointer just
// triggers a fresh background tab on the next call.

import { loadSession, saveSession } from './session.js'
import { targetWsUrl, createTab } from './cdp.js'

export interface ResolvedTarget {
  targetId: string
  created: boolean
}

export async function resolveLiveTarget(
  name: string,
  { create = true }: { create?: boolean } = {},
): Promise<ResolvedTarget> {
  const st = loadSession(name)
  if (st) {
    const ws = await targetWsUrl(st.targetId)
    if (ws) return { targetId: st.targetId, created: false }
  }
  if (!create) {
    throw new Error(`session "${name}" has no live tab — run:  browser-automation goto -s ${name} <url>`)
  }
  const targetId = await createTab('about:blank')
  saveSession({ name, targetId, createdAt: new Date().toISOString(), url: st?.url })
  return { targetId, created: true }
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
