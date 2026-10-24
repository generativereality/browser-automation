import { define } from 'gunshi'
import { consola } from 'consola'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { closeBrowser } from '../core/cdp.js'
import { contextsDir, listContextRecords, loadContextRecord, removeContextRecord, type ContextRecord } from '../core/context-store.js'
import { deleteSession, listAllSessions } from '../core/session.js'

async function running(r: ContextRecord): Promise<boolean> {
  try {
    return (await fetch(`http://localhost:${r.port}/json/version`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

/**
 * Login contexts (core/context-store.ts): a separate Chrome per extra account,
 * started by `new`/`goto --context <name>`. This lists, stops and forgets them.
 */
export const contextCommand = define({
  name: 'context',
  description:
    'Login contexts — a separate Chrome (own profile, own port, own window) per extra account, so a second login sits next to your own; '
    + 'opened by `new`/`goto --context <name>`, which start it on demand. `context` lists them; `context stop <name>` quits one; '
    + '`context forget <name>` removes it (its sessions too), keeping its profile unless --delete-profile.',
  args: {
    'delete-profile': { type: 'boolean', description: 'With forget: also delete the context\'s Chrome profile — its logins and extensions. Not undoable.' },
  },
  // Action and name are optional positionals, read rather than declared:
  // gunshi makes a declared positional required, and a bare `context` lists.
  async run(ctx) {
    const action = ctx.positionals[1] ?? 'list'
    const name = ctx.positionals[2]

    if (action === 'list' || action === 'ls') {
      const all = listContextRecords()
      if (!all.length) {
        consola.log('No login contexts. Open one with: browser-automation new -s <session> --context <name> <url>')
        return
      }
      const sessions = listAllSessions()
      consola.log(`# login contexts (${all.length}) — each its own Chrome; profiles under ${contextsDir()}`)
      for (const r of all) {
        const users = sessions.filter((s) => s.context === r.name).map((s) => s.name)
        consola.log(`  ${r.name.padEnd(20)} :${r.port}  [${(await running(r)) ? 'running' : 'stopped'}]${users.length ? `  sessions: ${users.join(', ')}` : ''}`)
      }
      return
    }

    const r = name ? loadContextRecord(name) : null
    if (!r) { consola.error(name ? `No context named "${name}" — see \`browser-automation context\`.` : `${action} needs a context name.`); process.exit(1) }

    if (action === 'stop') {
      if (!(await running(r))) { consola.info(`"${r.name}" is not running.`); return }
      process.env.BROWSER_AUTOMATION_CONTEXT = r.name // so closeBrowser() addresses ITS Chrome
      await closeBrowser()
      consola.success(`Asked the Chrome for "${r.name}" to quit. Its logins stay in its profile; the next \`goto --context ${r.name}\` starts it again.`)
      return
    }

    if (action === 'forget') {
      if (await running(r)) { consola.error(`"${r.name}" is running — stop it first: browser-automation context stop ${r.name}`); process.exit(1) }
      const gone = listAllSessions().filter((s) => s.context === r.name)
      for (const s of gone) deleteSession(s.name)
      removeContextRecord(r.name)
      if (ctx.values['delete-profile']) rmSync(join(contextsDir(), r.name), { recursive: true, force: true })
      consola.success(
        `Forgot context "${r.name}"${gone.length ? ` and its session(s) ${gone.map((s) => s.name).join(', ')}` : ''}. `
        + (ctx.values['delete-profile'] ? 'Its profile is deleted.' : `Its profile is kept at ${r.profileDir} (--delete-profile removes it).`),
      )
      return
    }

    consola.error(`Unknown action "${action}" — use list, stop <name> or forget <name>.`)
    process.exit(1)
  },
})
