import { define } from 'gunshi'
import { consola } from 'consola'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { cdpHost, cdpPort, listTargets } from '../core/cdp.js'
import { listSessions } from '../core/session.js'

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

    // Sessions
    const sessions = listSessions()
    consola.log(`  • ${sessions.length} known session(s): ${sessions.map((s) => s.name).join(', ') || '(none)'}`)
  },
})
