import { define } from 'gunshi'
import { consola } from 'consola'
import { defaultSessionName, deleteSession, listSessions } from '../core/session.js'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { closeTab } from '../core/cdp.js'

export const closeCommand = define({
  name: 'close',
  description: 'Forget a session binding (tab stays open by default). Pass --tab to also close the browser tab',
  args: {
    ...targetArgs,
    tab: { type: 'boolean', description: 'Also close the actual browser tab (destructive; off by default)' },
  },
  async run(ctx) {
    const opts = targetOpts(ctx.values)
    let targetId: string
    try {
      targetId = await resolveExistingTargetId(opts)
    } catch (e) {
      consola.warn(e instanceof Error ? e.message : String(e))
      return
    }

    // Default is non-destructive: only close the tab if explicitly asked.
    if (ctx.values.tab) {
      const ok = await closeTab(targetId).catch(() => false)
      consola.log(ok ? `Closed tab ${targetId.slice(0, 12)}….` : `Tab ${targetId.slice(0, 12)}… was already gone.`)
    }

    // Forget any session(s) bookmarking this tab.
    const forgotten: string[] = []
    for (const s of listSessions()) {
      if (s.targetId === targetId) { deleteSession(s.name); forgotten.push(s.name) }
    }
    // Pure session mode: forget the named session even if its tab was already stale.
    if (!opts.match && !opts.target) {
      const name = opts.session || defaultSessionName()
      if (!forgotten.includes(name)) { deleteSession(name); forgotten.push(name) }
    }

    if (forgotten.length) consola.success(`Forgot session(s): ${forgotten.join(', ')}.`)
    else if (!ctx.values.tab) consola.info('No session bound to that tab and --tab not given — nothing to do.')
  },
})
