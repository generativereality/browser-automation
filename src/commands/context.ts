import { define } from 'gunshi'
import { consola } from 'consola'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { cdpHost, cdpPort, closeBrowser } from '../core/cdp.js'
import { browserPid } from '../core/renderer-health.js'
import { contextsDir, listContextRecords, loadContextRecord, removeContextRecord, type ContextRecord } from '../core/context-store.js'
import { deleteSession, listAllSessions } from '../core/session.js'

/** Run `fn` as if `name` (or, when undefined, the user's own automation Chrome) were the active context. */
async function asChrome<T>(name: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.BROWSER_AUTOMATION_CONTEXT
  if (name) process.env.BROWSER_AUTOMATION_CONTEXT = name
  else delete process.env.BROWSER_AUTOMATION_CONTEXT
  try { return await fn() } finally {
    if (saved === undefined) delete process.env.BROWSER_AUTOMATION_CONTEXT
    else process.env.BROWSER_AUTOMATION_CONTEXT = saved
  }
}

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${cdpHost()}/json/version`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

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
      // Every Chrome this CLI drives, the user's own first: "which Chromes are
      // running, and which window is which?" should not need lsof and ps.
      const all = listContextRecords()
      const sessions = listAllSessions()
      const project = process.env.BAC_CONTEXT || undefined
      const row = async (label: string, name: string | undefined, color: string | undefined) => asChrome(name, async () => {
        const on = await up()
        const pid = on ? browserPid() : null
        const users = sessions.filter((s) => (s.context ?? undefined) === name).map((s) => s.name)
        return `  ${label.padEnd(22)} :${String(cdpPort()).padEnd(5)} [${on ? 'running' : 'stopped'}]`
          + `${pid ? ` pid ${pid}` : ''}${color ? `  ${color} window` : ''}${name && name === project ? '  ← BAC_CONTEXT' : ''}`
          + `${users.length > 6 ? `  ${users.length} sessions` : users.length ? `  sessions: ${users.join(', ')}` : ''}`
      })
      consola.log(`# Chromes driven by browser-automation — login contexts' profiles under ${contextsDir()}`)
      consola.log(await row('(your automation Chrome)', undefined, undefined))
      for (const r of all) consola.log(await row(r.name, r.name, r.color))
      if (!all.length) consola.log('  No login contexts yet. Open one with: browser-automation new -s <session> --context <name> <url>')
      return
    }

    const r = name ? loadContextRecord(name) : null
    if (!r) { consola.error(name ? `No context named "${name}" — see \`browser-automation context\`.` : `${action} needs a context name.`); process.exit(1) }

    if (action === 'stop') {
      if (!(await running(r))) { consola.info(`"${r.name}" is not running.`); return }
      process.env.BROWSER_AUTOMATION_CONTEXT = r.name // so closeBrowser() addresses ITS Chrome
      await closeBrowser()
      const users = listAllSessions().filter((s) => s.context === r.name).map((s) => s.name)
      consola.success(
        `Asked the Chrome for "${r.name}" to quit. Its logins stay in its profile; the next `
        + (users.length ? `\`goto -s ${users[0]} <url>\` (or any goto in one of its sessions)` : `\`goto -s <session> --context ${r.name} <url>\``)
        + ' starts it again.',
      )
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
