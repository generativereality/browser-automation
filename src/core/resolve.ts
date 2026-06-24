// Resolve a "which tab?" selector (-t / -m / -s) to a live targetId.
// Precedence: explicit target id > url/title match > saved session.

import { listTargets, listPageTargets, targetWsUrl, type CdpTarget } from './cdp.js'
import { loadSession, defaultSessionName } from './session.js'
import { resolveLiveTarget } from './target.js'
import type { TargetOpts } from './args.js'

/** Resolve a -t value: exact targetId, or a unique prefix (so the truncated id
 *  shown by `list` is directly usable). Searches ALL targets (incl. iframes). */
export async function resolveTargetIdArg(idOrPrefix: string): Promise<string> {
  const targets = await listTargets()
  const exact = targets.find((t) => t.id === idOrPrefix)
  if (exact) return exact.id
  const pre = targets.filter((t) => t.id.startsWith(idOrPrefix))
  if (pre.length === 1) return pre[0].id
  if (pre.length === 0) throw new Error(`no live tab with targetId ${idOrPrefix}`)
  throw new Error(`targetId prefix "${idOrPrefix}" matches ${pre.length} tabs — use more characters`)
}

async function matchOne(match: string, first?: boolean): Promise<CdpTarget> {
  const pages = await listPageTargets()
  const m = match.toLowerCase()
  const hits = pages.filter(
    (p) => (p.url ?? '').toLowerCase().includes(m) || (p.title ?? '').toLowerCase().includes(m),
  )
  if (hits.length === 0) throw new Error(`no open tab matches "${match}" — try \`browser-automation list\``)
  if (hits.length > 1 && !first) {
    throw new Error(
      `"${match}" matches ${hits.length} tabs — narrow it or pass --first:\n` +
        hits.map((h) => `  ${(h.title ?? '').slice(0, 30)}  ${h.url}`).join('\n'),
    )
  }
  return hits[0]
}

/** Match a CROSS-ORIGIN child iframe (OOPIF) by URL/title substring. Out-of-process
 *  iframes are first-class CDP targets (type === 'iframe') with their own
 *  webSocketDebuggerUrl, so once resolved every page command drives them exactly
 *  like a tab. (Same-origin iframes share the parent's target and never appear
 *  here — they're already reachable from the parent page.) */
async function matchIframe(match: string, first?: boolean): Promise<CdpTarget> {
  const frames = (await listTargets()).filter((t) => t.type === 'iframe')
  const m = match.toLowerCase()
  const hits = frames.filter(
    (f) => (f.url ?? '').toLowerCase().includes(m) || (f.title ?? '').toLowerCase().includes(m),
  )
  if (hits.length === 0) {
    throw new Error(
      `no cross-origin iframe matches "${match}" — run \`browser-automation list --frames\` to see them. ` +
        `(Same-origin iframes aren't separate targets; reach them from the parent page without -F.)`,
    )
  }
  if (hits.length > 1 && !first) {
    throw new Error(
      `-F "${match}" matches ${hits.length} iframes — narrow it, address one exactly with \`-t <iframeTargetId>\` ` +
        `(from \`list --frames\`), or pass --first:\n` +
        hits.map((h) => `  ${h.id.slice(0, 12)}  ${(h.url ?? '').slice(0, 70)}`).join('\n'),
    )
  }
  return hits[0]
}

/** Resolve to an EXISTING live tab — or, with `-F`, a cross-origin child iframe
 *  of one. Never creates. For read/snapshot/click/fill/eval/close. */
export async function resolveExistingTargetId(opts: TargetOpts): Promise<string> {
  // -F descends into an OOPIF. It resolves to the iframe's own target, which the
  // caller then drives with the identical machinery used for a page target.
  if (opts.frame) {
    return (await matchIframe(opts.frame, opts.first)).id
  }
  if (opts.target) {
    return resolveTargetIdArg(opts.target)
  }
  if (opts.match) {
    return (await matchOne(opts.match, opts.first)).id
  }
  const name = opts.session || defaultSessionName()
  const st = loadSession(name)
  if (st) {
    const ws = await targetWsUrl(st.targetId)
    if (ws) return st.targetId
  }
  throw new Error(
    `session "${name}" has no live tab. Open one with \`browser-automation goto -s ${name} <url>\`, ` +
      `target an existing tab with \`-m <url-or-title-substr>\`, or run \`browser-automation list\`.`,
  )
}

/** Resolve, creating+binding a session tab only in pure session mode. For goto. */
export async function resolveOrCreateTargetId(opts: TargetOpts): Promise<{ targetId: string; created: boolean }> {
  if (opts.target || opts.match) {
    return { targetId: await resolveExistingTargetId(opts), created: false }
  }
  return resolveLiveTarget(opts.session || defaultSessionName())
}

export { matchOne, matchIframe }
