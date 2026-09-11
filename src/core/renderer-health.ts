// Is Chrome still able to give a NEW tab a live renderer — and if not, WHY not?
//
// The browser process and its renderers are different processes with different
// failure modes, and `/json/version` only ever tells you about the first one.
// A browser process can be perfectly healthy — answering `/json/list`, creating
// targets, listing 60 tabs — while being permanently unable to hand any new
// target a renderer. Every existing tab keeps working, so nothing looks broken
// until you open a tab or navigate cross-origin, and then the error you get is
// `Page.enable timed out` or `net::ERR_ABORTED`, which read as "this site is
// blocking us".
//
// THE PERMANENT FAILURE. Diagnosed 2026-08-22 on a Chrome up for weeks, from
// Chrome's own log:
//
//   ERROR:base/apple/mach_port_rendezvous_mac.cc:256]
//     bootstrap_look_up com.google.Chrome.MachPortRendezvousServer.36893:
//     (ipc/send) invalid destination port
//   ERROR:base/memory/shared_memory_switch.cc:261]
//     No rendezvous client, terminating process (parent died?)
//
// On macOS a Chrome child receives its shared-memory handles by looking up a
// Mach bootstrap service the browser registers ONCE, at startup, named
// `com.google.Chrome.MachPortRendezvousServer.<browser-pid>`. That registration
// had vanished from the user's launchd bootstrap namespace. From that moment
// every child Chrome launches looks the name up, fails, concludes its parent
// died, and kills itself within milliseconds — so no renderer ever appears in
// `ps`, and the browser reports only "Render process gone." It is unrecoverable
// for that browser process; only a restart clears it.
//
// ────────────────────────────────────────────────────────────────────────────
// AND THEN THIS MODULE SPENT THREE WEEKS REPORTING THAT DIAGNOSIS FALSELY.
//
// 2026-09-11: `goto` refused with "Chrome cannot give a new tab a working
// renderer … This is permanent … Recovery: restart Chrome" against a browser
// where all three of that diagnosis's observable consequences were false.
// Measured on the refusing browser (pid 92453), while it was refusing:
//
//   Mach name absent?    NO  — `launchctl print gui/501` listed
//                              MachPortRendezvousServer.92453 throughout.
//   No renderers alive?  NO  — 48 `--type=renderer` processes were running.
//   Unrecoverable?       NO  — the identical `goto` succeeded an hour later
//                              against the same browser pid, nothing restarted.
//
// The whole verdict rested on ONE `Runtime.evaluate` not returning inside ONE
// 5000ms budget, mapped to the string "the target exists, but no renderer ever
// answered it", printed as the permanent condition. An instrument that cannot
// look must not answer in the words of "not there".
//
// What was actually happening is measured in core/renderer-wake.ts: a target
// created with `background: true` — which is how this tool opens every tab, and
// how this probe opened its own — has a median time-to-first-answer of 367ms
// and a tail past 30 SECONDS on a loaded machine, while the same target after
// `Target.activateTarget` answers in a median 19ms. The probe reproduced the
// fault it was testing for, and then blamed the browser for it.
//
// **The cost of being wrong here is not a bad error message.** The advice it
// prints, `launch --restart`, closes every tab of every session sharing this
// Chrome — ~26 agent sessions on this machine. It has twice destroyed work that
// could not be recovered: a finished AlternativeTo submission with the
// operator's own hand edits, and an unrelated session's Azure signup flow,
// mid-form. So this module's rule is:
//
//   Name the permanent condition ONLY when its own signature is present.
//   Offer the cheap recovery first, always. Restarting is the last resort and
//   somebody else's tabs are the price.
//
// **Target count is not the trigger**, and it is worth recording how wrong that
// first theory was: a freshly launched Chrome was driven to 421 page targets /
// 435 live renderers with every one responsive, and a 256-fd `ulimit` changed
// nothing. The browser that broke in August had 66 tabs; the one that "broke"
// in September had 24. Chasing the count would have produced a threshold
// warning that fires on healthy browsers and stays silent on broken ones.

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cdpHost, cdpPort, closeTab, createTab, listPageTargets } from './cdp.js'
import { askRenderer, ensureRenderer, envInt, type RendererOutcome } from './renderer-wake.js'

/** First attempt's budget. Later attempts double it. */
const DEFAULT_TIMEOUT = 5000
/** How many times we ask before we are willing to call a browser broken. */
const DEFAULT_ATTEMPTS = 3
/** Breathing room between attempts — a browser mid-GC deserves a second look. */
const RETRY_PAUSE = 400

/**
 * What we could corroborate about the browser, independent of the probe.
 *
 * Both of these were decisive on 2026-09-11 and neither was consulted. Each is
 * one command. `null` anywhere means "could not look", which is reported as
 * exactly that and never as a fault.
 */
export interface RendererEvidence {
  /** The browser process serving the port we are driving. */
  pid: number | null
  /** Is its Mach bootstrap name still registered? THE signature. */
  rendezvous: boolean | null
  /** Live `--type=renderer` children of that browser. */
  renderers: number | null
}

export type RendererVerdict =
  /** A new target got a renderer that answered. */
  | 'healthy'
  /** The permanent condition, with its own signature confirmed present. */
  | 'wedged'
  /** The probe failed, but the browser is demonstrably NOT wedged. */
  | 'busy'
  /** The probe failed and we could not corroborate either way. Say so. */
  | 'unknown'

export interface ProbeAttempt {
  outcome: RendererOutcome
  /** The budget this attempt was given. */
  budget: number
  ms: number
  /** Did this attempt have to raise the window to get an answer? */
  woke: boolean
  reason?: string
}

export interface RendererHealth {
  /** Did a brand-new target get a renderer that answered? */
  ok: boolean
  /** Total ms spent, across every attempt. */
  ms: number
  /** How many page targets are open (context only — NOT a health signal). */
  pageTargets: number
  /** Why it failed, when it did. */
  reason?: string
  outcome: RendererOutcome
  verdict: RendererVerdict
  attempts: ProbeAttempt[]
  /** Gathered only when the first attempt fails; nothing to explain otherwise. */
  evidence?: RendererEvidence
}

/**
 * The verdict, from the probe and the corroborations — and from nothing else.
 *
 * Pure, and separate from the probing, because this is the decision that was
 * wrong: every failure used to become 'wedged' by default. Now 'wedged'
 * requires `rendezvous === false`, which is the only thing that has ever
 * actually meant it.
 */
export function rendererVerdict(outcome: RendererOutcome, e?: RendererEvidence): RendererVerdict {
  if (outcome === 'ok') return 'healthy'
  if (e?.rendezvous === false) return 'wedged'
  if (e?.rendezvous === true && (e.renderers ?? 0) > 0) return 'busy'
  return 'unknown'
}

/**
 * Create a throwaway tab, make its renderer prove it is alive, close it.
 *
 * Three things changed after 2026-09-11, and each of them is load-bearing:
 *
 *  1. It goes through `ensureRenderer`, so the probe opens its tab the way the
 *     tool opens tabs AND gets the same wake treatment. A probe that is harsher
 *     on itself than `goto` is on a real tab reports failures `goto` would not
 *     have had.
 *  2. It retries with a doubling budget. One 5s timeout is not evidence of a
 *     permanent condition; it is evidence of 5 seconds.
 *  3. It stops early when the Mach name is ABSENT — the one state where more
 *     waiting is genuinely pointless — so the real failure is still reported
 *     fast while a slow browser gets the benefit of the doubt.
 */
export async function probeRenderer(
  { timeout, attempts }: { timeout?: number; attempts?: number } = {},
): Promise<RendererHealth> {
  const base = timeout ?? envInt('BROWSER_AUTOMATION_PROBE_TIMEOUT', DEFAULT_TIMEOUT)
  const maxAttempts = Math.max(1, attempts ?? envInt('BROWSER_AUTOMATION_PROBE_ATTEMPTS', DEFAULT_ATTEMPTS))
  const started = Date.now()

  let pageTargets = 0
  try { pageTargets = (await listPageTargets()).length } catch { /* reported below */ }

  const tries: ProbeAttempt[] = []
  let evidence: RendererEvidence | undefined

  for (let i = 0; i < maxAttempts; i++) {
    const budget = base * 2 ** i
    tries.push(await probeOnce(budget))
    const last = tries[tries.length - 1]
    if (last.outcome === 'ok') {
      return finish({ ok: true, started, pageTargets, tries, evidence })
    }
    // Corroborate BEFORE spending more time, and before ever concluding
    // anything: when the Mach name is gone, retrying is theatre.
    evidence ??= gatherEvidence()
    if (evidence.rendezvous === false) break
    if (i + 1 < maxAttempts) await new Promise((r) => setTimeout(r, RETRY_PAUSE))
  }
  return finish({ ok: false, started, pageTargets, tries, evidence })
}

function finish(
  { ok, started, pageTargets, tries, evidence }:
  { ok: boolean; started: number; pageTargets: number; tries: ProbeAttempt[]; evidence?: RendererEvidence },
): RendererHealth {
  const last = tries[tries.length - 1]
  const health: RendererHealth = {
    ok,
    ms: Date.now() - started,
    pageTargets,
    reason: last?.reason,
    outcome: last?.outcome ?? 'error',
    verdict: rendererVerdict(last?.outcome ?? 'error', evidence),
    attempts: tries,
    evidence,
  }
  recordProbe(health)
  return health
}

/** One create -> ensure -> close cycle. */
async function probeOnce(budget: number): Promise<ProbeAttempt> {
  const started = Date.now()
  let targetId: string | undefined
  try {
    targetId = await createTab('about:blank', { timeout: budget })
  } catch (e: any) {
    // NOT the same thing as a silent renderer, and the distinction is the whole
    // point: this is the browser itself refusing, which is what the permanent
    // failure actually looks like from here.
    return { outcome: 'error', budget, ms: Date.now() - started, woke: false, reason: `could not create a target at all: ${e?.message ?? e}` }
  }
  try {
    const r = await ensureRenderer(targetId, { grace: budget, budget })
    return { outcome: r.outcome, budget, ms: Date.now() - started, woke: r.woke, reason: r.reason }
  } finally {
    // Best effort: a target whose renderer is gone still closes cleanly at the
    // browser level, and leaving these behind is how a wedged Chrome ends up
    // with a row of blank-titled corpses in `list`.
    if (targetId) await closeTab(targetId).catch(() => {})
  }
}

/**
 * Ask an EXISTING target's renderer to prove it is alive.
 *
 * Kept returning `string | null` because that is what `gc` wants (a reason to
 * print beside a tab it is about to close). New callers should prefer
 * `askRenderer`, which says WHICH failure it was.
 */
export async function renderersAnswer(targetId: string, timeout = DEFAULT_TIMEOUT): Promise<string | null> {
  const r = await askRenderer(targetId, timeout)
  return r.outcome === 'ok' ? null : (r.reason ?? r.outcome)
}

/**
 * The port we are actually talking to.
 *
 * NOT always `cdpPort()`: `BROWSER_AUTOMATION_CDP` points the CLI at an
 * arbitrary host:port, and everything here that shells out to `ps` or
 * `launchctl` has to ask about THAT browser. Using the uid-derived port instead
 * finds the user's default Chrome and cheerfully reports its health as if it
 * were the one being driven — caught while testing this module against a second
 * Chrome, where a perfectly healthy browser was accused of having lost a
 * bootstrap name that in fact belonged to a different pid.
 */
function targetPort(): number {
  const explicit = process.env.BROWSER_AUTOMATION_CDP
  if (explicit) {
    try {
      const p = Number(new URL(explicit).port)
      if (Number.isInteger(p) && p > 0) return p
    } catch { /* not a URL we can read; fall through */ }
  }
  return cdpPort()
}

/**
 * The browser process serving our port, and how many renderers it has.
 *
 * One `ps`, not one `pgrep` plus one `ps` per hit: on a Chrome with 40 children
 * that was 41 forks to answer two questions, and it ran on the error path of a
 * browser already thought to be struggling.
 *
 * The executable check is not decoration. Matching on the command line alone
 * (as `pgrep -f` does) hits any process that merely CONTAINS the debugging-port
 * flag — the `grep` looking for it, or a shell running `browser-automation`
 * with the flag as an argument. One of those, having no `--type=`, would have
 * been reported as the browser pid, and its absent Mach name read as the
 * permanent failure. Seen while writing this: a `ugrep` for the flag sat in
 * `ps` output alongside the real Chrome.
 */
function chromeProcesses(): { browser: number | null; renderers: number | null } {
  const flag = `--remote-debugging-port=${targetPort()}`
  const uid = String(process.getuid?.() ?? -1)
  let out: string
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,uid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { browser: null, renderers: null }
  }
  let browser: number | null = null
  let renderers = 0
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const [, pid, u, cmd] = m
    if (u !== uid || !cmd.includes(flag)) continue
    if (!/chrome|chromium|brave|msedge|thorium/i.test(cmd.split(' --')[0])) continue
    if (/--type=renderer\b/.test(cmd)) renderers++
    else if (!cmd.includes('--type=')) browser = Number(pid)
  }
  return { browser, renderers }
}

/** The pid of the browser process serving the port we are driving, if visible. */
export function browserPid(): number | null {
  return chromeProcesses().browser
}

/**
 * macOS only: is the browser's Mach port rendezvous service still registered?
 *
 * This is the ROOT CAUSE signal, not a symptom — when it is missing, every
 * child process Chrome launches kills itself on startup. Returns null when we
 * cannot tell (not macOS, `launchctl` unavailable, pid unknown), which is
 * different from `false` and must never be reported as a fault.
 */
export function rendezvousRegistered(pid: number | null): boolean | null {
  if (process.platform !== 'darwin' || !pid) return null
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 501}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.includes(`MachPortRendezvousServer.${pid}`)
  } catch {
    return null
  }
}

/** Both corroborations, in one pass. Cheap enough to run on every failure. */
export function gatherEvidence(): RendererEvidence {
  const { browser, renderers } = chromeProcesses()
  // No browser pid means we could not COUNT its renderers either. Reporting 0
  // there would read as "no renderer is alive", which is precisely the
  // permanent failure's signature — the instrument would be inventing it.
  return { pid: browser, renderers: browser === null ? null : renderers, rendezvous: rendezvousRegistered(browser) }
}

/** Where `launch` writes Chrome's stdout/stderr — Chrome logs the real reason there. */
export function chromeLogPath(): string {
  const tmp = process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'
  return process.env.BROWSER_AUTOMATION_LOG || `${tmp}/chrome-${targetPort()}.log`
}

// ── Instrumentation ────────────────────────────────────────────────────────
// One JSONL line per probe. This exists because the September false positive
// could not be argued about: nobody had a distribution of healthy probe times
// to say whether 5000ms was a sane budget, so the timeout was defended on
// nothing and the verdict was believed on nothing. `doctor` prints a summary.

function probeLogPath(): string {
  return process.env.BROWSER_AUTOMATION_PROBE_LOG || join(homedir(), '.browser-automation', 'renderer-probes.jsonl')
}

function recordProbe(h: RendererHealth): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    ok: h.ok,
    verdict: h.verdict,
    outcome: h.outcome,
    ms: h.ms,
    attempts: h.attempts.map((a) => ({ outcome: a.outcome, ms: a.ms, budget: a.budget, woke: a.woke })),
    pageTargets: h.pageTargets,
    evidence: h.evidence,
  })
  try {
    const path = probeLogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    // Keep it bounded without a rotation scheme: the interesting probes are
    // always the recent ones, and an unbounded log on a machine running 26
    // sessions is its own bug report.
    try {
      if (statSync(path).size > 256 * 1024) {
        const kept = readFileSync(path, 'utf8').split('\n').slice(-500).join('\n')
        writeFileSync(path, kept.endsWith('\n') ? kept : kept + '\n')
      }
    } catch { /* no log yet */ }
    appendFileSync(path, line + '\n')
  } catch { /* instrumentation must never break a command */ }
}

export interface ProbeStats { n: number; failures: number; median: number; worst: number }

/** Recent probe timings, for `doctor`. Returns null when there is no history. */
export function recentProbeStats(limit = 50): ProbeStats | null {
  try {
    const lines = readFileSync(probeLogPath(), 'utf8').trim().split('\n').slice(-limit)
    const rows = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as any[]
    if (!rows.length) return null
    const okMs = rows.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b)
    return {
      n: rows.length,
      failures: rows.filter((r) => !r.ok).length,
      median: okMs.length ? okMs[Math.floor(okMs.length / 2)] : -1,
      worst: okMs.length ? okMs[okMs.length - 1] : -1,
    }
  } catch {
    return null
  }
}

// ── Explaining a failure ───────────────────────────────────────────────────

function evidenceLines(e: RendererEvidence | undefined): string[] {
  if (!e) return []
  const mach = e.rendezvous === true ? `registered for pid ${e.pid} — the permanent failure's signature is ABSENT`
    : e.rendezvous === false ? `NOT REGISTERED for pid ${e.pid} — this is the permanent failure`
    : `could not check (${e.pid ? `pid ${e.pid}, ` : 'browser pid unknown, '}not macOS or launchctl unavailable)`
  const rend = e.renderers === null ? `could not count`
    : `${e.renderers} live renderer process(es) for this browser`
  return [
    `  mach service: ${mach}`,
    `  renderers:    ${rend}`,
  ]
}

/** The cheap recovery. Always printed, always before anything expensive. */
function cheapRecovery(): string[] {
  return [
    `Try these first, cheapest first:`,
    ``,
    `  1. Run the command again. A new tab's renderer has been measured taking`,
    `     12s and more on a loaded machine, and it is not broken, only late.`,
    `  2. Use a tab that already works. An existing tab navigates same-origin`,
    `     without needing a new renderer, so it keeps working throughout:`,
    `       browser-automation list`,
    `       browser-automation eval -t <id> "location.href='<url>'"`,
    `  3. browser-automation doctor   — re-measures, and prints recent probe times.`,
  ]
}

/**
 * A ready-to-print explanation of a renderer failure, with the recovery.
 *
 * Written to be read by somebody who has just been told a site blocks them, so
 * it says what is and is not true before it says what to do — and it says only
 * what was actually established. The four verdicts get four different endings
 * because they need four different actions, and exactly one of them is worth
 * anybody's tabs.
 */
export function explainRendererFailure(h: RendererHealth): string {
  const e = h.evidence ?? gatherEvidence()
  const verdict = h.verdict ?? rendererVerdict(h.outcome, e)
  const tried = h.attempts?.length ?? 1
  const longest = h.attempts?.length ? Math.max(...h.attempts.map((a) => a.budget)) : 0
  const woke = h.attempts?.some((a) => a.woke)

  const lines = [
    `Chrome did not give a new tab a working renderer.`,
    ``,
    `  probe:        ${tried} attempt(s), longest budget ${longest}ms, ${h.ms}ms total`,
    `                ${h.reason ?? 'no renderer answered'}`,
    ...(woke ? [`                (it was also activated to force a renderer, and still did not answer)`] : []),
    `  page targets: ${h.pageTargets}   (context only — NOT the cause; a healthy Chrome has`,
    `                been driven to 421 tabs with every renderer alive)`,
    ...evidenceLines(e),
    ``,
  ]

  if (verdict === 'wedged') {
    lines.push(
      `VERDICT: this browser process can never make a renderer again.`,
      ``,
      `Chrome registers "com.google.Chrome.MachPortRendezvousServer.${e.pid}" once, at`,
      `startup, and every child process looks that name up to receive its shared`,
      `memory. The name is gone, so every renderer Chrome launches from now on exits`,
      `within milliseconds. Nothing re-registers it, and closing tabs does not help.`,
      ``,
      `This is NOT the site blocking automation. Two tells: same-origin navigations in`,
      `tabs that already work keep working (they reuse a renderer that exists), and`,
      `cross-origin ones fail with ERR_ABORTED (site isolation needs a new renderer).`,
      ``,
      ...cheapRecovery(),
      ``,
      `Only then, and only because the signature above is confirmed present, a restart`,
      `is the real fix:`,
      ``,
      `  browser-automation launch --restart     # closes ALL tabs, for EVERY session`,
      ``,
      `Other sessions are driving this Chrome. Their open tabs go with it, and they`,
      `will not be told why — agree on it first. \`browser-automation list\` shows who`,
      `holds what.`,
    )
  } else if (verdict === 'busy') {
    lines.push(
      `VERDICT: Chrome is NOT in the permanent, restart-only state.`,
      ``,
      `Its Mach rendezvous service is registered and ${e.renderers} renderer processes are`,
      `alive. Both are absent in that failure, so whatever this is, a restart is not`,
      `the fix for it — the probe asked ${tried} times, waited up to ${longest}ms, and did not`,
      `get an answer. That happens on a loaded machine and it usually clears by itself.`,
      ``,
      ...cheapRecovery(),
      ``,
      `Do NOT restart Chrome on the strength of this message. \`launch --restart\` closes`,
      `every tab of every session sharing this browser, and the evidence above says`,
      `this is not the failure a restart fixes.`,
    )
  } else {
    lines.push(
      `VERDICT: undiagnosed — and specifically, NOT confirmed as the permanent failure.`,
      ``,
      `The probe failed, but the signature of the restart-only condition (an ABSENT`,
      `Mach rendezvous service) could not be confirmed, so this may equally be a slow`,
      `or heavily loaded browser. Those need opposite responses, and guessing wrong`,
      `costs every session on this browser its tabs.`,
      ``,
      ...cheapRecovery(),
      ``,
      `If it keeps failing, get the corroboration before doing anything drastic:`,
      ``,
      `  browser-automation doctor`,
      `  tail -50 ${chromeLogPath()}`,
      ``,
      `A \`doctor\` that reports the Mach service ABSENT is the permanent failure, and`,
      `only that justifies \`launch --restart\` — which closes every tab for every`,
      `session sharing this Chrome.`,
    )
  }
  return lines.join('\n')
}

/**
 * Does this error look like it could be a renderer failure rather than the site?
 *
 * Kept deliberately narrow. These are the ONLY shapes the failure takes through
 * the CLI, and each of them has an innocent explanation too — so a hit here
 * buys a probe, never a conclusion.
 */
export function mayBeRendererFailure(err: unknown): boolean {
  const m = String((err as any)?.message ?? err)
  return (
    /Page\.enable timed out/i.test(m)
    || /Target\.createTarget timed out/i.test(m)
    || /net::ERR_ABORTED/i.test(m)
    || /Runtime\.evaluate timed out/i.test(m)
    || /Render process gone/i.test(m)
    || /CDP connect timeout/i.test(m)
  )
}

/**
 * Run `fn`; if it fails in a way a renderer failure could explain, spend one
 * probe finding out, and re-throw with the diagnosis attached.
 *
 * The probe only ever runs on the error path, so the happy path pays nothing.
 * If the probe comes back healthy the original error is re-thrown untouched —
 * and since the probe now retries and can wake a late renderer, "healthy" is
 * the answer a loaded browser gets, which is the September bug not happening.
 */
export async function withRendererDiagnosis<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (!mayBeRendererFailure(e)) throw e
    const h = await probeRenderer().catch(() => null)
    if (!h || h.ok) throw e
    const err = new Error(`${String((e as any)?.message ?? e)}\n\n${explainRendererFailure(h)}`)
    ;(err as any).cause = e
    ;(err as any).rendererHealth = h
    throw err
  }
}

export { cdpHost }
