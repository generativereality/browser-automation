import { define } from 'gunshi'
import { consola } from 'consola'
import { forgetContext, listContexts, loadContext, saveContext, validContextName } from '../core/contexts.js'
import { liveBrowserContexts } from '../core/cdp.js'
import { listSessions } from '../core/session.js'

/**
 * Manage login contexts (core/contexts.ts): separate cookie jars, each with its
 * own window, for signing in to a second account next to your own. Tabs are
 * opened in one with `new --context <name>` / `goto --context <name>`; this
 * command lists, saves and forgets them.
 */
export const contextCommand = define({
  name: 'context',
  description:
    'Login contexts — separate cookie jars, each with its own window, for a second account next to your own (open tabs in one with `new`/`goto --context <name>`). '
    + '`context` lists them; `context save [name]` saves their cookies now; `context forget <name>` deletes a saved login (--close also closes its window).',
  args: {
    close: { type: 'boolean', description: 'With forget: also close the context\'s window and every tab in it' },
  },
  // The action and name are optional positionals, read rather than declared:
  // gunshi makes a declared positional required, and a bare `context` lists.
  async run(ctx) {
    const action = ctx.positionals[1] ?? 'list'
    const name = ctx.positionals[2]

    if (action === 'list' || action === 'ls') {
      const all = listContexts()
      if (!all.length) {
        consola.log('No login contexts. Open one with: browser-automation new -s <session> --context <name> <url>')
        return
      }
      const live = await liveBrowserContexts().catch(() => [] as string[])
      const sessions = listSessions()
      consola.log(`# login contexts (${all.length}) — saved in ~/.browser-automation/contexts/`)
      for (const c of all) {
        const on = !!c.browserContextId && live.includes(c.browserContextId)
        const users = sessions.filter((s) => s.context === c.name).map((s) => s.name)
        consola.log(
          `  ${c.name.padEnd(20)} [${on ? 'open' : 'saved'}] ${String(c.cookies.length).padStart(4)} cookie(s)`
          + `${c.savedAt ? `, saved ${c.savedAt}` : ''}${users.length ? `  sessions: ${users.join(', ')}` : ''}`,
        )
      }
      return
    }

    if (action === 'save') {
      const names = name ? [name] : listContexts().map((c) => c.name)
      let failed = false
      for (const n of names) {
        if (!loadContext(n)) { consola.error(`No context named "${n}".`); failed = true; continue }
        const count = await saveContext(n)
        if (count === null) consola.info(`"${n}" is not open in this Chrome; its saved login is unchanged.`)
        else consola.success(`Saved ${count} cookie(s) of "${n}".`)
      }
      if (failed) process.exit(1)
      return
    }

    if (action === 'forget') {
      if (!name || !validContextName(name)) { consola.error('forget needs a context name — see `browser-automation context`'); process.exit(1) }
      const r = await forgetContext(name, { close: ctx.values.close === true })
      if (!r.existed) { consola.warn(`No saved context named "${name}".`); return }
      consola.success(`Forgot "${name}": its saved cookies are deleted${r.closed ? ', and its window is closed' : ''}.`
        + (r.closed ? '' : ' If its window is still open it stays signed in until Chrome restarts; add --close to close it now.'))
      return
    }

    consola.error(`Unknown action "${action}" — use list, save [name] or forget <name>.`)
    process.exit(1)
  },
})
