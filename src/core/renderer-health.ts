// Is Chrome still able to give a NEW tab a live renderer?
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
// Diagnosed 2026-08-22 on a Chrome that had been up for weeks. The actual
// mechanism, from Chrome's own log:
//
//   ERROR:base/apple/mach_port_rendezvous_mac.cc:256]
//     bootstrap_look_up com.google.Chrome.MachPortRendezvousServer.36893:
//     (ipc/send) invalid destination port
//   ERROR:base/memory/shared_memory_switch.cc:261]
//     No rendezvous client, terminating process (parent died?)
//
// On macOS a Chrome child process receives its shared-memory handles by looking
// up a Mach bootstrap service the browser registers ONCE, at startup, named
// `com.google.Chrome.MachPortRendezvousServer.<browser-pid>`. That registration
// had vanished from the user's launchd bootstrap namespace (confirmed absent
// via `launchctl print gui/$UID`, while two healthy Chromes on the same machine
// were both registered). From that moment on every child process Chrome
// launches looks the name up, fails, concludes its parent died, and kills
// itself within milliseconds — so no renderer ever appears in `ps`, and the
// browser process reports only "Render process gone."
//
// It is unrecoverable for that browser process: the name is registered at
// startup and never re-registered. Closing tabs does NOT help — the state has
// nothing to do with how many tabs are open. Only restarting Chrome does.
//
// **Target count is not the trigger.** That was the first (wrong) theory, and
// it is worth recording how wrong: a freshly launched Chrome on the same
// machine was driven to 421 page targets / 435 live renderer processes with
// every single one responsive. A 256-fd `ulimit` made no difference either
// (205 renderers, all fine). The broken browser had 66 tabs. The count was a
// coincidence, and chasing it would have produced a threshold warning that
// fires on healthy browsers and stays silent on broken ones.
//
// So health is measured, never inferred: create a throwaway target, ask its
// renderer to evaluate `1+1`, close it. That round-trip is the only thing that
// distinguishes the two states, and it costs ~100ms on a healthy browser.

import { execFileSync } from 'node:child_process'
import { cdpHost, cdpPort, connect, createTab, closeTab, listPageTargets, targetWsUrl } from './cdp.js'

export interface RendererHealth {
  /** Did a brand-new target get a renderer that answered? */
  ok: boolean
  /** Round-trip ms for the probe (or time spent before giving up). */
  ms: number
  /** How many page targets are open (context only — NOT a health signal). */
  pageTargets: number
  /** Why it failed, when it did. */
  reason?: string
}

/**
 * Create a throwaway tab, make its renderer prove it is alive, close it.
 *
 * Deliberately uses `about:blank` and `Runtime.evaluate`, not a navigation:
 * we are asking "can a new renderer exist and execute", which is the narrowest
 * question that separates a wedged browser from a slow network or a hostile
 * site. Nothing here touches the caller's tabs.
 */
export async function probeRenderer({ timeout = 5000 } = {}): Promise<RendererHealth> {
  const started = Date.now()
  let pageTargets = 0
  try { pageTargets = (await listPageTargets()).length } catch { /* reported below */ }

  let targetId: string | undefined
  try {
    targetId = await createTab('about:blank')
  } catch (e: any) {
    return { ok: false, ms: Date.now() - started, pageTargets, reason: `could not create a target at all: ${e?.message ?? e}` }
  }

  try {
    const reason = await renderersAnswer(targetId, timeout)
    return { ok: reason === null, ms: Date.now() - started, pageTargets, reason: reason ?? undefined }
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
 * Returns null when it answers correctly, or a human-readable reason when it
 * does not. Used both by the throwaway probe and by `new`, which has just
 * created a tab and should check that one rather than manufacture a second.
 */
export async function renderersAnswer(targetId: string, timeout = 5000): Promise<string | null> {
  try {
    const ws = await targetWsUrl(targetId)
    if (!ws) return 'the target vanished immediately'
    const s = await connect(ws, { timeout })
    try {
      const r = await s.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, timeout)
      const value = r?.result?.value
      return value === 2 ? null : `the renderer answered with ${JSON.stringify(value)} instead of 2`
    } finally {
      s.close()
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    // The signature of the wedge: the target exists, the renderer behind it
    // never answers, so the command times out rather than erroring.
    return /timed out|timeout/i.test(msg) ? 'the target exists, but no renderer ever answered it' : msg
  }
}

/**
 * The port we are actually talking to.
 *
 * NOT always `cdpPort()`: `BROWSER_AUTOMATION_CDP` points the CLI at an
 * arbitrary host:port, and everything here that shells out to `pgrep` or
 * `launchctl` has to ask about THAT browser. Using the uid-derived port
 * instead finds the user's default Chrome and cheerfully reports its health
 * as if it were the one being driven — caught while testing this module
 * against a second Chrome, where a perfectly healthy browser was accused of
 * having lost the bootstrap name that in fact belonged to a different pid.
 */
function targetPort(): number {
  const explicit = process.env.BROWSER_AUTOMATION_CDP
  if (explicit) {
    const p = Number(new URL(explicit).port)
    if (Number.isInteger(p) && p > 0) return p
  }
  return cdpPort()
}

/** The pid of the browser process serving the port we are driving, if visible. */
export function browserPid(): number | null {
  try {
    const out = execFileSync('pgrep', ['-u', String(process.getuid?.() ?? -1), '-f', '--', `--remote-debugging-port=${targetPort()}`], {
      encoding: 'utf8',
    })
    // Children carry the same flag; the browser process is the one WITHOUT
    // --type=, and it is the oldest, so it has the lowest pid of the group only
    // by luck. Ask ps what each one actually is instead.
    for (const pid of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      try {
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' })
        if (!cmd.includes('--type=')) return Number(pid)
      } catch { /* raced with exit */ }
    }
  } catch { /* no match */ }
  return null
}

/**
 * macOS only: is the browser's Mach port rendezvous service still registered?
 *
 * This is the ROOT CAUSE signal, not a symptom — when it is missing, every
 * child process Chrome launches kills itself on startup. Returns null when we
 * cannot tell (not macOS, `launchctl` unavailable, pid unknown), which is
 * different from `false` and must not be reported as a fault.
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

/** Where `launch` writes Chrome's stdout/stderr — Chrome logs the real reason there. */
export function chromeLogPath(): string {
  const tmp = process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'
  return process.env.BROWSER_AUTOMATION_LOG || `${tmp}/chrome-${targetPort()}.log`
}

/**
 * A ready-to-print explanation of a renderer failure, with the recovery.
 *
 * Written to be read by somebody who has just been told a site blocks them, so
 * it says what is and is not true before it says what to do.
 */
export function explainRendererFailure(h: RendererHealth): string {
  const pid = browserPid()
  const rendezvous = rendezvousRegistered(pid)
  const lines = [
    `Chrome cannot give a new tab a working renderer.`,
    ``,
    `  probe:        created a target, ${h.reason ?? 'no renderer answered'} (${h.ms}ms)`,
    `  page targets: ${h.pageTargets}   (context only — this is NOT the cause; a healthy`,
    `                Chrome has been driven to 421 tabs with every renderer alive)`,
  ]
  if (rendezvous === false) {
    lines.push(
      `  root cause:   the browser process (pid ${pid}) has lost its Mach bootstrap`,
      `                service "com.google.Chrome.MachPortRendezvousServer.${pid}".`,
      `                Chrome registers that name once, at startup; every child`,
      `                process looks it up to receive its shared memory. With the`,
      `                name gone, every renderer Chrome launches immediately exits.`,
      `                This is permanent for this browser process.`,
    )
  } else if (rendezvous === true) {
    lines.push(
      `  note:         the Mach rendezvous service for pid ${pid} IS still registered,`,
      `                so this is a different renderer failure from the one seen on`,
      `                2026-08-22. Chrome's own log will say why:`,
      `                  tail -50 ${chromeLogPath()}`,
    )
  }
  lines.push(
    ``,
    `This is a browser-level failure. It is NOT the site blocking automation, and`,
    `retrying, changing the URL, or adding a user agent will not help. Two tells:`,
    `same-origin navigations in tabs that already work keep working (they reuse a`,
    `renderer that already exists), and cross-origin ones fail with ERR_ABORTED`,
    `(site isolation needs a new renderer, which is the thing Chrome can't do).`,
    ``,
    `Recovery: restart Chrome. Nothing else clears it — closing tabs does not,`,
    `and plain \`launch\` will not either (it is idempotent and sees a live browser).`,
    ``,
    `  browser-automation launch --restart     # closes ALL tabs, then relaunches`,
    ``,
    `If other sessions are driving this Chrome, agree on the restart first — their`,
    `open tabs go with it. \`browser-automation list\` shows who holds what.`,
  )
  return lines.join('\n')
}

/**
 * Does this error look like it could be the renderer wedge rather than the site?
 *
 * Kept deliberately narrow. These three are the ONLY shapes the failure takes
 * through the CLI, and each of them has an innocent explanation too — so a hit
 * here buys a probe, never a conclusion.
 */
export function mayBeRendererFailure(err: unknown): boolean {
  const m = String((err as any)?.message ?? err)
  return (
    /Page\.enable timed out/i.test(m)
    || /net::ERR_ABORTED/i.test(m)
    || /Runtime\.evaluate timed out/i.test(m)
    || /Render process gone/i.test(m)
    || /CDP connect timeout/i.test(m)
  )
}

/**
 * Run `fn`; if it fails in a way the renderer wedge could explain, spend one
 * probe finding out, and re-throw with the diagnosis attached.
 *
 * The probe only ever runs on the error path, so the happy path pays nothing.
 * If the probe comes back healthy the original error is re-thrown untouched —
 * the point is to stop misattributing a browser fault to a site, not to blame
 * the browser for every timeout.
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
