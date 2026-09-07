import { define } from 'gunshi'
import { consola } from 'consola'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { launchScriptPath } from '../core/paths.js'
import { cdpPort } from '../core/cdp.js'
import { probeRenderer, explainRendererFailure, chromeLogPath } from '../core/renderer-health.js'

export const launchCommand = define({
  name: 'launch',
  description: 'Start (idempotent) this user\'s headed Chrome with the persistent profile, and verify it can still make renderers',
  args: {
    status: { type: 'boolean', description: 'Only report whether the CDP browser is up (exit 0/1) — reachability, not health' },
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

    // `--status` asks a deliberately cheaper question — "is anything serving
    // this port" — and callers use its exit code as a boolean. Leave it alone.
    if (r.status !== 0 || ctx.values.status) process.exit(r.status ?? 1)

    // **"Already running" is not a health check, so do the health check.**
    //
    // Everything the script can see is a property of the browser PROCESS: the
    // port is held, `/json/version` answers, targets list. None of that
    // survives contact with the failure this browser actually has — losing the
    // ability to give a new tab a renderer (see core/renderer-health.ts). A
    // Chrome in that state answers every cheap probe and fails every `goto`.
    //
    // Measured 2026-09-07: a Chrome up 12 days had `launch` reporting
    // "nothing to do", a normal `/json/version`, and 10 targets listed, while
    // `goto` exited 1 and `eval` timed out at 30000ms. The operator spent many
    // minutes raising timeouts, because the one line that would have said
    // otherwise was a hint printed unconditionally on every launch — which
    // reads as boilerplate precisely because it is. A measured verdict that
    // only appears when it is true is worth more than any wording.
    //
    // The probe costs one throwaway tab and ~100ms, on every launch, and it is
    // the only thing here that talks to a renderer at all.
    const health = await probeRenderer().catch((e: any) => ({
      ok: false as const, ms: 0, pageTargets: 0, reason: String(e?.message ?? e),
    }))
    if (health.ok) {
      consola.success(`Renderer capacity: a new tab got a live renderer in ${health.ms}ms — this Chrome works.`)
      return
    }
    // A browser that cannot make renderers is not a successful launch, whatever
    // the script concluded from the port being held. Fail, so a script that
    // chains off `launch` stops here instead of on a mystery `goto` timeout.
    consola.error('Chrome is up, but it cannot make renderers — this browser is unusable.\n')
    for (const line of explainRendererFailure(health).split('\n')) consola.log(line)
    consola.log(`\nChrome's own log: ${chromeLogPath()}`)
    process.exit(1)
  },
})
