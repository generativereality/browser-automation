import { define } from 'gunshi'
import { consola } from 'consola'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { launchScriptPath } from '../core/paths.js'
import { cdpPort, closeBrowser, listPageTargets } from '../core/cdp.js'
import { probeRenderer, explainRendererFailure, chromeLogPath } from '../core/renderer-health.js'
import { migrateProfile, resolveProfile } from '../core/profile.js'

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
    const port = ['--port', String(cdpPort())]
    const bash = (extra: string[]) => spawnSync('bash', [script, ...port, ...extra], { stdio: 'inherit' })

    // `--status` asks only about the port; it neither moves nor opens anything.
    if (ctx.values.status) process.exit(bash(['--status']).status ?? 1)

    // **Quit before moving.** A profile is never moved underneath a running
    // Chrome, so a restart stops it first, then migrates, then launches — which
    // makes `launch --restart` the way to move a profile that is in use now.
    if (ctx.values.restart) {
      // Quit cleanly over CDP first; `--stop` then waits for the process and
      // only signals it if it is still there. A Chrome that is not answering
      // (the usual reason to restart) just falls through to the signals.
      // Count first: once it is asked to quit there is nothing left to count,
      // and "how many tabs am I closing" is the one thing to say before doing it.
      const tabs = await listPageTargets().then((t) => t.length).catch(() => null)
      if (tabs !== null) consola.info(`Restarting Chrome on :${cdpPort()} — closing ${tabs} open tab(s).`)
      await closeBrowser().catch(() => {})
      const stop = bash(['--stop', '--profile', resolveProfile().dir])
      if (stop.status !== 0) process.exit(stop.status ?? 1)
    }

    // **Move the profile out of Chrome's own folder, if it is still there.**
    // See core/profile.ts: inside Google Chrome's app-data container, an
    // app-hosted session is refused by macOS and Chrome dies on its own
    // SingletonLock. Every outcome hands back a profile that holds the logins;
    // a refused move keeps the old folder working rather than starting fresh.
    const m = migrateProfile()
    if (m.outcome === 'moved') consola.success(`Profile ${m.detail} — logins travel with it.`)
    else if (m.outcome === 'refused' || m.outcome === 'failed') consola.warn(`Profile not moved: ${m.detail}`)
    else if (m.outcome === 'in-use') consola.info(`Profile not moved yet: ${m.detail}`)

    const r = bash(['--profile', m.dir])

    if (r.status !== 0) process.exit(r.status ?? 1)

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
      outcome: 'error' as const, verdict: 'unknown' as const, attempts: [],
    }))
    if (health.ok) {
      const woke = health.attempts.some((a) => a.woke)
      consola.success(
        `Renderer capacity: a new tab got a live renderer in ${health.ms}ms — this Chrome works.`
        + (woke ? ' (It had to be activated to get there — this browser is slow to give background tabs a renderer.)' : ''),
      )
      return
    }
    // A browser that cannot make renderers is not a successful launch, whatever
    // the script concluded from the port being held. Fail, so a script that
    // chains off `launch` stops here instead of on a mystery `goto` timeout.
    //
    // But say which failure it is. "Unusable" was printed for a browser that
    // was merely slow, directly above advice to restart it — see the header of
    // core/renderer-health.ts for what that cost.
    consola.error(
      health.verdict === 'wedged'
        ? 'Chrome is up, but it can never make a renderer again — this browser is unusable.\n'
        : 'Chrome is up, but a new tab did not get a working renderer in time.\n',
    )
    for (const line of explainRendererFailure(health).split('\n')) consola.log(line)
    consola.log(`\nChrome's own log: ${chromeLogPath()}`)
    process.exit(1)
  },
})
