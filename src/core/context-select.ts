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

import { allocateContextPort } from './cdp.js'
import { resolveProfile } from './profile.js'
import { CONTEXT_COLORS, personalizeProfile, seedProfile, type SeedMode } from './profile-clone.js'
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

function takeContextFlag(argv: string[]): { argv: string[]; name?: string; seed?: SeedMode } {
  const out: string[] = []
  let name: string | undefined
  let seed: SeedMode | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { out.push(...argv.slice(i)); break }
    if (a === '--context') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) throw new ContextError('--context needs a name, e.g. --context cloudflare-2')
      name = v; i++; continue
    }
    if (a.startsWith('--context=')) { name = a.slice('--context='.length); continue }
    if (a === '--empty-profile' || a === '--full-copy') {
      const m: SeedMode = a === '--empty-profile' ? 'empty' : 'full'
      if (seed && seed !== m) throw new ContextError('--empty-profile and --full-copy contradict each other')
      seed = m; continue
    }
    out.push(a)
  }
  return { argv: out, name, seed }
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
  const { argv, name: flag, seed } = takeContextFlag(rawArgv)
  const session = sub && !SESSIONLESS.has(sub) ? sessionOf(argv) : null
  const st = session ? loadSession(session) : null

  // A session's tab lives in one Chrome. Moving it into another would
  // silently carry one account's work into the other's — so an explicit
  // --context that disagrees with the session is refused.
  if (flag !== undefined && st && (st.context ?? undefined) !== flag) {
    throw new ContextError(
      `session "${st.name}" belongs to ${st.context ? `context "${st.context}"` : 'your own Chrome'}, not "${flag}" — `
      + `use another session name (-s), or forget this one first: browser-automation close -s ${st.name}`,
    )
  }
  // Precedence: the flag, then the SESSION (its tab is where it is), then
  // BAC_CONTEXT — a project-wide default, typically set in a Claude account's
  // settings.json `env`. An inherited default must not error on a session
  // that was opened elsewhere before it was set; it governs new sessions,
  // -m/-t, and the session-less commands.
  const name = flag ?? (st ? st.context : undefined) ?? (st ? undefined : process.env.BAC_CONTEXT || undefined)
  if (!name) {
    if (seed) throw new ContextError(`--${seed === 'empty' ? 'empty-profile' : 'full-copy'} is for a NEW login context: use it with --context <name>`)
    delete process.env.BROWSER_AUTOMATION_CONTEXT
    return argv
  }

  if (!validContextName(name)) {
    throw new ContextError(`invalid context name "${name}": letters, digits, '.', '_' or '-' (max 64), starting with a letter or digit`)
  }
  if (!loadContextRecord(name)) {
    if (!sub || !CREATES.has(sub)) {
      throw new ContextError(`no context named "${name}" — open one with: browser-automation new -s <session> --context ${name} <url>`)
    }
    const records = listContextRecords()
    const port = await allocateContextPort(records.map((r) => r.port))
    const profileDir = contextProfileDir(name)
    const color = nextContextColor(records)
    // The AUTOMATION profile — resolved with no context active, so it is the
    // user's own automation Chrome's, never another context's, and never the
    // user's ordinary Chrome profile (core/profile-clone.ts).
    delete process.env.BROWSER_AUTOMATION_CONTEXT
    const from = resolveProfile().dir
    const mode: SeedMode = seed ?? 'extensions'
    console.error(SEED_NOTE[mode](name, from, color.name))
    try {
      seedProfile(from, profileDir, mode)
      personalizeProfile(profileDir, name, color.argb)
    } catch (e) {
      throw new ContextError(`could not set up the profile for context "${name}": ${e instanceof Error ? e.message : String(e)} — nothing was kept; run it again, or pass --empty-profile`)
    }
    saveContextRecord({ name, port, profileDir, color: color.name, createdAt: new Date().toISOString() })
  } else if (seed) {
    console.error(`Context "${name}" already exists, so --${seed === 'empty' ? 'empty-profile' : 'full-copy'} does nothing; its profile is left as it is.`)
  }
  process.env.BROWSER_AUTOMATION_CONTEXT = name
  return argv
}

const SEED_NOTE: Record<SeedMode, (name: string, from: string, color: string) => string> = {
  extensions: (name, from, color) =>
    `Context "${name}" (a ${color} window): copying the EXTENSIONS of the automation profile (${from}) — a password manager stays `
    + 'signed in — but no site logins, cookies or history, and not signed in to Chrome. (--full-copy takes the logins too; --empty-profile takes nothing.)',
  full: (name, from, color) =>
    `Context "${name}" (a ${color} window): a FULL copy of the automation profile (${from}), caches left out — every login and cookie comes along, `
    + "including Chrome's own Google sign-in, which may then be the default Google account there. Sign out of any account this context is not for.",
  empty: (name, _from, color) => `Context "${name}" (a ${color} window): an empty profile — no extensions, no logins.`,
}

/** The first palette colour no context has yet; after that, round the palette. */
function nextContextColor(records: Array<{ color?: string }>): { name: string; argb: number } {
  const used = new Set(records.map((r) => r.color))
  return CONTEXT_COLORS.find((c) => !used.has(c.name)) ?? CONTEXT_COLORS[records.length % CONTEXT_COLORS.length]
}
