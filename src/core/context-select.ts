// Which Chrome is this command for? Decided once, at the entry point, before
// any command runs — see core/context-store.ts for what a context is.
//
//   1. `--context <name>` anywhere before a bare `--` (or `--context=<name>`)
//   2. `BAC_CONTEXT`, the way `BAC_SESSION` names a session once per shell
//   3. the context the SESSION was opened in, so `read -s cf2` follows the tab
//      that `new -s cf2 --context cloudflare-2` made, with no flag
//   4. none: the user's own automation Chrome, exactly as before
//
// `--context` is taken out of argv here, so every command accepts it without
// declaring it.

import { mkdirSync } from 'node:fs'
import { allocateContextPort } from './cdp.js'
import {
  contextProfileDir,
  listContextRecords,
  loadContextRecord,
  saveContextRecord,
  validContextName,
} from './context-store.js'
import { defaultSessionName, loadSession } from './session.js'

/** Commands that do not address a session's tab: the session cannot decide their Chrome. */
const SESSIONLESS = new Set(['list', 'ls', 'launch', 'doctor', 'port', 'profile', 'context', 'gc', 'prune'])
/** Commands that may bring a new context into being (and start its Chrome). */
const CREATES = new Set(['new', 'goto', 'launch'])

export class ContextError extends Error {}

function takeContextFlag(argv: string[]): { argv: string[]; name?: string } {
  const out: string[] = []
  let name: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { out.push(...argv.slice(i)); break }
    if (a === '--context') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) throw new ContextError('--context needs a name, e.g. --context cloudflare-2')
      name = v; i++; continue
    }
    if (a.startsWith('--context=')) { name = a.slice('--context='.length); continue }
    out.push(a)
  }
  return { argv: out, name }
}

/** The `-s`/`--session` value, or the default — only when the tab is chosen by session (no -m/-t/-F). */
function sessionOf(argv: string[]): string | null {
  let session: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') break
    if (a === '-m' || a === '--match' || a === '-t' || a === '--target' || a === '-F' || a === '--frame') return null
    if (a.startsWith('--match=') || a.startsWith('--target=') || a.startsWith('--frame=')) return null
    if (a === '-s' || a === '--session') session = argv[i + 1]
    else if (a.startsWith('--session=')) session = a.slice('--session='.length)
  }
  return session || defaultSessionName()
}

/**
 * Work out the context for `sub` + `argv`, register it if this command may
 * create one, and set BROWSER_AUTOMATION_CONTEXT. Returns argv without the flag.
 */
export async function selectContext(sub: string | undefined, rawArgv: string[]): Promise<string[]> {
  const { argv, name: flag } = takeContextFlag(rawArgv)
  const asked = flag ?? (process.env.BAC_CONTEXT || undefined)
  const session = sub && !SESSIONLESS.has(sub) ? sessionOf(argv) : null
  const st = session ? loadSession(session) : null

  // A session's tab lives in one Chrome. Following it into another would
  // silently carry one account's work into the other's — so refuse.
  if (asked !== undefined && st && (st.context ?? undefined) !== asked) {
    throw new ContextError(
      `session "${st.name}" belongs to ${st.context ? `context "${st.context}"` : 'your own Chrome'}, not "${asked}" — `
      + `use another session name (-s), or forget this one first: browser-automation close -s ${st.name}`,
    )
  }
  const name = asked ?? st?.context
  if (!name) { delete process.env.BROWSER_AUTOMATION_CONTEXT; return argv }

  if (!validContextName(name)) {
    throw new ContextError(`invalid context name "${name}": letters, digits, '.', '_' or '-' (max 64), starting with a letter or digit`)
  }
  if (!loadContextRecord(name)) {
    if (!sub || !CREATES.has(sub)) {
      throw new ContextError(`no context named "${name}" — open one with: browser-automation new -s <session> --context ${name} <url>`)
    }
    const port = await allocateContextPort(listContextRecords().map((r) => r.port))
    const profileDir = contextProfileDir(name)
    mkdirSync(profileDir, { recursive: true })
    saveContextRecord({ name, port, profileDir, createdAt: new Date().toISOString() })
  }
  process.env.BROWSER_AUTOMATION_CONTEXT = name
  return argv
}
