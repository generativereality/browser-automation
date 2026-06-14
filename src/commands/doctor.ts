import { define } from 'gunshi'
import { consola } from 'consola'
import { homedir } from 'node:os'
import { cdpHost, listTargets } from '../core/cdp.js'
import { listSessions } from '../core/session.js'

const PROFILE = process.env.BROWSER_AUTOMATION_PROFILE
  || `${homedir()}/Library/Application Support/Google/Chrome/browser-automation`

export const doctorCommand = define({
  name: 'doctor',
  description: 'Diagnose the setup: Node, Chrome on :9223, targets, sessions',
  args: {},
  async run() {
    const ok = (m: string) => consola.log(`  ✓ ${m}`)
    const bad = (m: string) => consola.log(`  ✗ ${m}`)

    // Node
    const major = Number(process.versions.node.split('.')[0])
    if (major >= 22) ok(`Node ${process.versions.node} (global WebSocket available)`)
    else bad(`Node ${process.versions.node} — need >= 22 for the global WebSocket CDP client`)

    consola.log(`  • CDP host: ${cdpHost()}`)
    consola.log(`  • Profile:  ${PROFILE}`)

    // Chrome / CDP
    let version: any
    try {
      const r = await fetch(`${cdpHost()}/json/version`)
      version = await r.json()
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
