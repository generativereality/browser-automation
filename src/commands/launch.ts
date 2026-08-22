import { define } from 'gunshi'
import { consola } from 'consola'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { launchScriptPath } from '../core/paths.js'
import { cdpPort } from '../core/cdp.js'

export const launchCommand = define({
  name: 'launch',
  description: 'Start (idempotent) this user\'s headed Chrome with the persistent profile',
  args: {
    status: { type: 'boolean', description: 'Only report whether the CDP browser is up (exit 0/1)' },
    restart: { type: 'boolean', description: 'Quit this user\'s running Chrome first, then launch. CLOSES ALL ITS TABS — the only recovery for a browser that can no longer launch renderers (see `doctor`).' },
  },
  async run(ctx) {
    const script = launchScriptPath()
    if (!existsSync(script)) {
      consola.error(`launch-chrome.sh not found at ${script}. Reinstall the package.`)
      process.exit(1)
    }
    // **The port is passed, never assumed.** `cdpPort()` is the one place it is
    // decided; the script has a fallback of its own only so a person can run it
    // by hand, and the two must not be allowed to drift.
    // `--restart` is destructive to every session sharing this browser, so it
    // is never implied — not by a failed launch, not by an unhealthy doctor.
    // Something has to type it.
    const args = [
      '--port', String(cdpPort()),
      ...(ctx.values.status ? ['--status'] : []),
      ...(ctx.values.restart ? ['--restart'] : []),
    ]
    const r = spawnSync('bash', [script, ...args], { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  },
})
