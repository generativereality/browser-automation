import { define } from 'gunshi'
import { consola } from 'consola'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { cdpHost, cdpPort, listTargets } from '../core/cdp.js'
import { listSessions } from '../core/session.js'
import { probeRenderer, explainRendererFailure, gatherEvidence, recentProbeStats, chromeLogPath } from '../core/renderer-health.js'

const PROFILE = process.env.BROWSER_AUTOMATION_PROFILE
  || `${homedir()}/Library/Application Support/Google/Chrome/browser-automation`

/**
 * Does a Chrome THIS user started serve our CDP port?
 *
 * **The question is "is it mine", not "whose is it"**, and that is the whole
 * trick. `lsof` tells a non-root user nothing about another user's socket — it
 * prints an empty result and exits 0, which is indistinguishable from a free
 * port. Measured 2026-08-08 on a two-account Mac: as the second user,
 * `lsof -nP -iTCP:9223 -sTCP:LISTEN` returned nothing while the first user's
 * Chrome was plainly listening and answering every request. You can always see
 * your own processes, so ask about those.
 */
function portIsOurs(): boolean {
  try {
    execFileSync('pgrep', ['-u', String(process.getuid?.() ?? -1), '-f', '--', `--remote-debugging-port=${cdpPort()}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

export const doctorCommand = define({
  name: 'doctor',
  description: 'Diagnose the setup: Node, this user\'s Chrome, targets, sessions',
  args: {},
  async run() {
    const ok = (m: string) => consola.log(`  ✓ ${m}`)
    const bad = (m: string) => consola.log(`  ✗ ${m}`)

    // Node
    const major = Number(process.versions.node.split('.')[0])
    if (major >= 22) ok(`Node ${process.versions.node} (global WebSocket available)`)
    else bad(`Node ${process.versions.node} — need >= 22 for the global WebSocket CDP client`)

    consola.log(`  • CDP host: ${cdpHost()} (port ${cdpPort()} — derived from uid ${process.getuid?.() ?? '?'})`)
    consola.log(`  • Profile:  ${PROFILE}`)

    // **Whose browser is this?** The failure this exists for is invisible
    // without asking: another account's Chrome answers every request
    // perfectly, and every tab you open lands in their session.

    // Chrome / CDP
    let version: any
    try {
      const r = await fetch(`${cdpHost()}/json/version`)
      version = await r.json()
      if (!portIsOurs()) {
        bad(
          `something on port ${cdpPort()} is serving CDP (${version.Browser}) but this account `
          + `did not start it — it is another user's Chrome, and anything you drive would `
          + `happen in their browser. Quit Chrome in that account, or set `
          + `BROWSER_AUTOMATION_PORT to a free port.`,
        )
        return
      }
      ok(`Chrome reachable: ${version.Browser}`)
    } catch {
      bad(`No CDP browser on ${cdpHost()} — run:  browser-automation launch`)
      return
    }

    // Targets (informational — per-target driving is immune to target-soup hangs)
    try {
      const targets = await listTargets()
      const byType: Record<string, number> = {}
      for (const t of targets) byType[t.type] = (byType[t.type] ?? 0) + 1
      const summary = Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')
      ok(`${targets.length} targets (${summary})`)
      consola.log(`    (per-target CDP — target count never wedges this CLI)`)
    } catch {
      bad('Could not enumerate targets')
    }

    // **Renderer capacity.** Everything above this line describes the browser
    // PROCESS, and the browser process is not what breaks. A Chrome that has
    // lost the ability to launch renderers passes every check above — reachable,
    // targets listed, version reported — and fails every attempt to open a tab
    // or navigate cross-origin, with errors (`Page.enable timed out`,
    // `net::ERR_ABORTED`) that read as the remote site's doing. A green doctor
    // on a browser in that state is worse than no doctor: it actively points
    // the investigation at the site. So measure it, with the round-trip that is
    // the only thing that tells the two apart.
    const health = await probeRenderer().catch((e) => ({
      ok: false, ms: 0, pageTargets: 0, reason: String(e?.message ?? e),
      outcome: 'error' as const, verdict: 'unknown' as const, attempts: [],
    }))
    if (health.ok) {
      const woke = health.attempts.some((a) => a.woke)
      ok(`Renderer capacity: a new tab got a live renderer in ${health.ms}ms`)
      if (woke) {
        // Worth saying out loud: it worked, but only because the tab was
        // activated. That is the state in which `goto` used to fail outright.
        consola.log(`    ⚠ it only answered after being activated — this Chrome is slow to give`)
        consola.log(`      BACKGROUND tabs a renderer (measured: median 367ms, tail past 30s).`)
        consola.log(`      Commands will work; new tabs may briefly raise the Chrome window.`)
      }
      const ev = gatherEvidence()
      if (ev.rendezvous === false) {
        // Healthy probe, missing bootstrap name: not a state we have seen, but
        // if it happens it is the wedge arriving, so say so rather than wait.
        consola.log(`    ⚠ but the Mach rendezvous service for pid ${ev.pid} is NOT registered —`)
        consola.log(`      new renderers are expected to start failing. Restart Chrome soon:`)
        consola.log(`      browser-automation launch --restart`)
      }
    } else {
      bad(`Renderer capacity: FAILED (${health.verdict})`)
      for (const line of explainRendererFailure(health).split('\n')) consola.log(`    ${line}`)
      consola.log(`    Chrome's own log: ${chromeLogPath()}`)
    }

    // **What the probe usually costs here.** Nobody could say whether the 5000ms
    // budget was sane when it started condemning working browsers, because no
    // history was kept. Now there is one.
    const stats = recentProbeStats()
    if (stats) {
      consola.log(
        `  • last ${stats.n} renderer probe(s): ${stats.failures} failed`
        + (stats.median >= 0 ? `, median ${stats.median}ms, slowest success ${stats.worst}ms` : ''),
      )
    }

    // Sessions. Bookmarks are never cleaned up on their own, so on a machine
    // that has run many parallel sessions for months this list runs to
    // hundreds — long enough to scroll the actual diagnosis off the screen,
    // which is the one thing this command exists to show. Summarise, and name
    // the broom.
    const sessions = listSessions()
    let live = 0
    try {
      const liveIds = new Set((await listTargets()).map((t) => t.id))
      live = sessions.filter((s) => liveIds.has(s.targetId)).length
    } catch { /* leave live at 0 */ }
    const stale = sessions.length - live
    consola.log(`  • ${sessions.length} known session(s): ${live} live, ${stale} stale`)
    if (sessions.length) {
      const names = sessions.map((s) => s.name)
      const shown = names.slice(0, 12).join(', ')
      consola.log(`    ${shown}${names.length > 12 ? `, … (+${names.length - 12} more — \`browser-automation list\`)` : ''}`)
    }
    if (stale > 20) consola.log(`    ${stale} stale bookmarks point at tabs that no longer exist — \`browser-automation gc --dry\` to review.`)
  },
})
