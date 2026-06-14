import { define } from 'gunshi'
import { consola } from 'consola'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { launchScriptPath } from '../core/paths.js'

export const launchCommand = define({
  name: 'launch',
  description: 'Start (idempotent) the canonical headed Chrome on :9223 with the persistent profile',
  args: {
    status: { type: 'boolean', description: 'Only report whether the CDP browser is up (exit 0/1)' },
  },
  async run(ctx) {
    const script = launchScriptPath()
    if (!existsSync(script)) {
      consola.error(`launch-chrome.sh not found at ${script}. Reinstall the package.`)
      process.exit(1)
    }
    const args = ctx.values.status ? ['--status'] : []
    const r = spawnSync('bash', [script, ...args], { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  },
})
