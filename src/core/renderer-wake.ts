// Getting a NEW tab's renderer to answer, without stealing the user's screen.
//
// Chrome does not give a BACKGROUND target's renderer the urgency it gives a
// visible one. Measured 2026-09-11 against one Chrome 152.0.7977.83 (28 tabs
// open, machine at load average 38) — time from `Target.createTarget` to the
// first `Runtime.evaluate` returning, 8 trials each:
//
//   background: true                          median 367ms   worst 12517ms
//                                                            (and >30000ms in a
//                                                             separate run)
//   background: true + Target.activateTarget  median  19ms   worst    65ms
//   background: false                         median  18ms   worst    22ms
//
// The renderer PROCESS exists either way: `ps` gains a `--type=renderer` child
// within a second of the create, in both arms. What a background target does
// not get is a renderer that answers promptly, and on a loaded machine that
// tail runs past any budget you would make a person wait behind.
//
// **This is why the health probe kept condemning a working browser.** It
// created a background target and timed out on it — it manufactured the symptom
// it was testing for, and renderer-health.ts then reported that timeout as a
// permanent, restart-the-browser condition. Probing has to be done the way the
// tool actually opens tabs, and opening tabs has to stop producing 12-second
// renderers.
//
// **Waking costs the user their window.** Every route to a prompt renderer
// raises Chrome above whatever the operator is typing into. All four measured,
// with the terminal deliberately put in front first:
//
//   Target.activateTarget          Tabby -> Google Chrome
//   GET /json/activate/<id>        Tabby -> Google Chrome
//   Page.bringToFront              Tabby -> Google Chrome
//   createTarget background=false  Tabby -> Google Chrome
//
// There is no quiet one. So waking is a last resort rather than a strategy:
// wait out a short grace period first — 9 of 10 new tabs never need more — and
// only then spend the focus. Two measured facts make that spend nearly
// invisible. A woken tab STAYS responsive after it is handed back (10/10
// trials, still answering in 1-3ms seconds later), so one wake lasts the tab's
// life rather than repeating per command; and both the previously-active tab
// and the previously-frontmost app are restored afterwards, so what the
// operator sees is a flicker, not a theft.
//
// The alternative was what shipped before: refuse, and tell the operator to run
// `launch --restart`, which closes every tab of every session sharing this
// browser. That advice has twice destroyed another session's unrecoverable
// work. A flicker is cheaper than somebody else's hour.

import { execFileSync } from 'node:child_process'
import { activateTab, connect, listPageTargets, targetWsUrl } from './cdp.js'

/** How long a new tab gets to produce a renderer on its own before we wake it. */
const DEFAULT_GRACE = 2000
/** How long the woken tab then gets. Generous: waking is the expensive step. */
const DEFAULT_BUDGET = 10000

export function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/**
 * What happened when we asked a target's renderer to prove it is alive.
 *
 * These are kept apart on purpose. The old code mapped every one of them to a
 * single sentence — "the target exists, but no renderer ever answered it" —
 * which is how "could not create a target" (the real, permanent failure) and
 * "this took longer than 5s" (a loaded machine) came to print the same advice.
 */
export type RendererOutcome =
  /** Evaluated 1+1 and got 2. */
  | 'ok'
  /** The target disappeared before we could attach to it. */
  | 'gone'
  /** The target exists but its CDP WebSocket would not open in time. */
  | 'unattachable'
  /** Attached fine; the renderer behind it never answered. THE slow case. */
  | 'silent'
  /** It answered, with the wrong thing. Never yet seen in the wild. */
  | 'wrong-answer'
  /** Anything else, reported verbatim rather than translated. */
  | 'error'

export interface RendererAnswer {
  outcome: RendererOutcome
  ms: number
  /** Human-readable, and specific to the outcome. Absent only when ok. */
  reason?: string
}

/**
 * Ask ONE existing target's renderer to evaluate `1+1`.
 *
 * Deliberately not a navigation: the question is "can this renderer execute",
 * which is the narrowest thing that separates a busy browser from a broken one
 * without involving the network or the site.
 */
export async function askRenderer(targetId: string, timeout = 5000): Promise<RendererAnswer> {
  const started = Date.now()
  const ms = () => Date.now() - started
  let ws: string | null
  try {
    ws = await targetWsUrl(targetId)
  } catch (e: any) {
    return { outcome: 'error', ms: ms(), reason: String(e?.message ?? e) }
  }
  if (!ws) return { outcome: 'gone', ms: ms(), reason: 'the target vanished before we could attach to it' }

  let session
  try {
    session = await connect(ws, { timeout })
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    // A refused or errored WebSocket is the same class of answer as a timed-out
    // one: the target is listed, and we could not attach to it. A tab whose
    // renderer has not started yet does both, depending on how long we waited —
    // seen with a 1ms budget, where the socket errors before the timer fires.
    // Calling one 'unattachable' and the other an unclassified error meant the
    // second never earned the wake that would have fixed it.
    return /timed out|timeout|WebSocket error/i.test(msg)
      ? { outcome: 'unattachable', ms: ms(), reason: `the target is listed, but its CDP connection would not open within ${timeout}ms (${msg})` }
      : { outcome: 'error', ms: ms(), reason: msg }
  }
  try {
    const r = await session.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, timeout)
    const value = r?.result?.value
    if (value === 2) return { outcome: 'ok', ms: ms() }
    return { outcome: 'wrong-answer', ms: ms(), reason: `the renderer answered with ${JSON.stringify(value)} instead of 2` }
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    return /timed out|timeout/i.test(msg)
      ? { outcome: 'silent', ms: ms(), reason: `attached to the target, but its renderer did not answer within ${timeout}ms` }
      : { outcome: 'error', ms: ms(), reason: msg }
  } finally {
    session.close()
  }
}

/**
 * The macOS app currently in front, as a bundle path we can hand focus back to.
 *
 * `lsappinfo`, not AppleScript: `tell application "System Events" to get name
 * of first application process whose frontmost is true` needs Accessibility
 * permission, and a permission dialog appearing in the middle of an automated
 * command is worse than the focus steal it is trying to undo. `lsappinfo` needs
 * nothing and is present on every macOS.
 */
function frontmostApp(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (!asn) return null
    const info = execFileSync('lsappinfo', ['info', '-only', 'bundlepath', asn], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return /"LSBundlePath"="([^"]+)"/.exec(info)?.[1] ?? null
  } catch {
    return null
  }
}

/** Put the operator's app back in front. Best effort, and never fatal. */
function raiseApp(bundlePath: string | null): void {
  if (!bundlePath || process.platform !== 'darwin') return
  if (/Google Chrome\.app|Chromium\.app/.test(bundlePath)) return // it was already Chrome
  try {
    execFileSync('open', ['-a', bundlePath], { stdio: 'ignore' })
  } catch { /* the operator keeps a raised Chrome; not worth failing a command over */ }
}

/**
 * Which tab the operator is looking at, so it can be put back afterwards.
 *
 * Chrome lists page targets most-recently-active first. That is an observation,
 * not a documented guarantee — it held in every trial here, and when it is
 * wrong the cost is that the window comes back to a different tab of the
 * automation browser, not a failure.
 */
async function activePageId(): Promise<string | undefined> {
  try {
    return (await listPageTargets())[0]?.id
  } catch {
    return undefined
  }
}

export interface EnsureResult extends RendererAnswer {
  ok: boolean
  /** Did we have to raise the window to get an answer? */
  woke: boolean
}

/**
 * Make sure `targetId` has a renderer that answers — cheaply if possible.
 *
 * Grace period first (the common case: no focus is taken at all), then one
 * wake, then the verdict. `allowWake: false` (or BROWSER_AUTOMATION_NO_WAKE=1)
 * keeps the window untouched for callers who would rather fail than flicker.
 */
export async function ensureRenderer(
  targetId: string,
  { grace, budget, allowWake = !process.env.BROWSER_AUTOMATION_NO_WAKE }: { grace?: number; budget?: number; allowWake?: boolean } = {},
): Promise<EnsureResult> {
  const graceMs = grace ?? envInt('BROWSER_AUTOMATION_RENDERER_GRACE', DEFAULT_GRACE)
  const budgetMs = budget ?? envInt('BROWSER_AUTOMATION_RENDERER_BUDGET', DEFAULT_BUDGET)
  const started = Date.now()

  const first = await askRenderer(targetId, graceMs)
  if (first.outcome === 'ok') return { ...first, ok: true, woke: false, ms: Date.now() - started }
  // Only slowness is worth a wake. A target that has gone, or that answers
  // wrongly, is not going to be fixed by raising a window.
  if (!allowWake || (first.outcome !== 'silent' && first.outcome !== 'unattachable')) {
    return { ...first, ok: false, woke: false, ms: Date.now() - started }
  }

  const previousApp = frontmostApp()
  const previousTab = await activePageId()
  try {
    await activateTab(targetId)
  } catch (e: any) {
    return { ...first, ok: false, woke: false, ms: Date.now() - started, reason: `${first.reason}; and it could not be activated either (${e?.message ?? e})` }
  }
  const second = await askRenderer(targetId, budgetMs)
  // Hand the screen back in the order the operator would: their tab, then
  // their app. Both before we report, so a slow report cannot leave the window
  // sitting in front of them.
  if (previousTab && previousTab !== targetId) await activateTab(previousTab).catch(() => {})
  raiseApp(previousApp)

  return { ...second, ok: second.outcome === 'ok', woke: true, ms: Date.now() - started }
}
