// Start a login context's Chrome on demand (core/context-store.ts), the first
// time a `new`/`goto` needs it after boot. Delegates to `launch --context`, so
// it is the same launch, profile handling and renderer check as the user's own
// Chrome gets — on its own profile, behind its own pipe broker.

import { spawnSync } from 'node:child_process'
import { consola } from 'consola'
import { pipeUp } from './launch-pipe.js'
import { activeContext, listContextRecords, saveContextRecord } from './context-store.js'
import { CONTEXT_COLORS, personalizeProfile } from './profile-clone.js'

async function reachable(): Promise<boolean> {
  return pipeUp(1500)
}

export async function ensureContextChrome(): Promise<void> {
  const ctx = activeContext()
  if (!ctx || (await reachable())) return
  consola.info(
    `Starting the Chrome for context "${ctx.name}": its own window and profile. `
    + 'Whatever you sign in to or install there is kept.',
  )
  const r = spawnSync(process.execPath, [process.argv[1], 'launch', '--context', ctx.name], { stdio: 'inherit' })
  if (r.status !== 0 || !(await reachable())) {
    throw new Error(`could not start the Chrome for context "${ctx.name}" — try: browser-automation launch --context ${ctx.name}`)
  }
}

/**
 * Give a context made before 0.6.1 its window name and colour
 * (core/profile-clone.ts), the next time its Chrome is about to start. Only
 * while that Chrome is not running — it would write its own settings back
 * over these — and only once: a colour the person picked afterwards is theirs.
 */
export async function personalizeIfNeeded(): Promise<void> {
  const ctx = activeContext()
  if (!ctx || ctx.color || (await reachable())) return
  const used = new Set(listContextRecords().map((r) => r.color))
  const color = CONTEXT_COLORS.find((c) => !used.has(c.name)) ?? CONTEXT_COLORS[0]
  personalizeProfile(ctx.profileDir, ctx.name, color.argb)
  saveContextRecord({ ...ctx, color: color.name })
  consola.info(`Context "${ctx.name}": its window is ${color.name} from now on, and its profile is named "${ctx.name}".`)
}
