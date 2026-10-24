// Start a login context's Chrome on demand (core/context-store.ts), the first
// time a `new`/`goto` needs it after boot. Delegates to `launch --context`, so
// it is the same launch, profile handling and renderer check as the user's own
// Chrome gets — on its own port and profile.

import { spawnSync } from 'node:child_process'
import { consola } from 'consola'
import { cdpHost } from './cdp.js'
import { activeContext } from './context-store.js'

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${cdpHost()}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

export async function ensureContextChrome(): Promise<void> {
  const ctx = activeContext()
  if (!ctx || (await reachable())) return
  consola.info(
    `Starting the Chrome for context "${ctx.name}": its own window and profile, on :${ctx.port}. `
    + 'Whatever you sign in to or install there is kept.',
  )
  const r = spawnSync(process.execPath, [process.argv[1], 'launch', '--context', ctx.name], { stdio: 'inherit' })
  if (r.status !== 0 || !(await reachable())) {
    throw new Error(`could not start the Chrome for context "${ctx.name}" — try: browser-automation launch --context ${ctx.name}`)
  }
}
