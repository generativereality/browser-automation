// Where the automation Chrome keeps its profile — the one place that decides.
//
// # Why it moved out of Chrome's folder
//
// The default used to be `~/Library/Application Support/Google/Chrome/
// browser-automation`: an isolated `--user-data-dir` that shares nothing with
// the person's everyday Chrome, but which LIVES INSIDE Google Chrome's app-data
// container. macOS guards that container per HOST application
// (`kTCCServiceSystemPolicyAppData`, the "would like to access data from other
// apps" dialog), attributing access to whichever app is responsible for the
// process. The TCC database on the maintainer's Mac:
//
//     kTCCServiceSystemPolicyAppData | org.tabby | allowed | 2026-05-15
//     kTCCServiceSystemPolicyAppData | clerk.ai  | DENIED  | 2026-08-02
//
// So the same CLI, same profile, same user, worked for months from a terminal
// and failed every time an app spawned it — and a denial is remembered, so it
// failed silently from then on. Chrome's own message names its SingletonLock
// ("Operation not permitted"), which reads as a stale lock and is not one.
// Measured again 2026-09-23 on macOS 27: the failure in the log at 08:53, and a
// launch from the allowed terminal succeeding on the same profile minutes later.
//
// A folder under ~ belongs to no app, so no host needs a grant to reach it.
//
// # What the move must never do
//
// An earlier fix, in the Remember This apps, repointed the profile at an empty
// folder and was reverted the same day: the profile is ~5 GB and holds the
// cookies for every bank and supplier portal signed into, so an empty one signs
// the person out of all of them. Hence:
//
//   * MOVE, never repoint. A clone of a real profile relaunched outside
//     `Library` kept 2252/2252 readable cookies across 601 domains — Chrome's
//     cookie key is in the Keychain, not bound to the path.
//   * A single `rename`, never a copy. It is atomic on one volume; a copy that
//     dies halfway leaves a partial profile at the new path, which would then
//     win and be worse than not moving.
//   * An old profile we cannot READ still exists. A denied host gets EACCES/
//     EPERM from stat, and treating that as "no old profile" is precisely how
//     you hand someone a fresh, logged-out browser.
//   * A refused move falls back to the old folder (which `launch` still opens,
//     through open(1) on macOS), never to a new one.
//   * Never move a profile a running Chrome has open.

import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The default, under ~, reachable by every host. */
export function homeProfileDir(): string {
  return join(homedir(), '.browser-automation', 'chrome-profile')
}

/** The old default, inside Google Chrome's own app-data folder. */
export function legacyProfileDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'browser-automation')
}

type Presence = 'present' | 'absent' | 'unreadable'

/**
 * Does a path exist, as far as this process can tell?
 *
 * `unreadable` is its own answer and callers must not fold it into `absent`:
 * it is what a host denied Chrome's container sees for a profile that is very
 * much there.
 */
function presence(p: string): Presence {
  try {
    lstatSync(p)
    return 'present'
  } catch (e: any) {
    return e?.code === 'ENOENT' || e?.code === 'ENOTDIR' ? 'absent' : 'unreadable'
  }
}

export interface ProfileChoice {
  /** The directory to pass as --user-data-dir. */
  dir: string
  /** Why this one. */
  source: 'env' | 'home' | 'legacy'
}

/**
 * Which profile to use, WITHOUT changing anything on disk.
 *
 * The home folder once it exists; otherwise the legacy folder whenever it
 * might exist (present or unreadable); otherwise the home folder, for Chrome
 * to create on first launch.
 */
export function resolveProfile(): ProfileChoice {
  const explicit = process.env.BROWSER_AUTOMATION_PROFILE
  if (explicit) return { dir: explicit, source: 'env' }
  const home = homeProfileDir()
  if (presence(home) === 'present') return { dir: home, source: 'home' }
  if (presence(legacyProfileDir()) !== 'absent') return { dir: legacyProfileDir(), source: 'legacy' }
  return { dir: home, source: 'home' }
}

export type MigrationOutcome =
  | 'explicit' // BROWSER_AUTOMATION_PROFILE set; nothing to do
  | 'current' // already in the home folder
  | 'fresh' // no profile anywhere; Chrome will create the home one
  | 'moved' // moved just now
  | 'in-use' // a running Chrome has the legacy profile open
  | 'refused' // this process may not move it (the macOS grant, or permissions)
  | 'failed' // anything else

export interface Migration {
  outcome: MigrationOutcome
  /** The profile to launch with after this — always one that holds the logins. */
  dir: string
  detail?: string
}

/** Is any Chrome of ours running with this --user-data-dir? */
function inUse(dir: string): boolean {
  try {
    execFileSync('pgrep', ['-u', String(process.getuid?.() ?? -1), '-f', '--', `--user-data-dir=${dir}`], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** Move the legacy profile into the home folder, if that is both needed and safe. */
export function migrateProfile(): Migration {
  const choice = resolveProfile()
  if (choice.source === 'env') return { outcome: 'explicit', dir: choice.dir }
  if (choice.source === 'home') {
    return { outcome: presence(choice.dir) === 'present' ? 'current' : 'fresh', dir: choice.dir }
  }

  const legacy = legacyProfileDir()
  const home = homeProfileDir()

  if (presence(legacy) === 'unreadable') {
    return {
      outcome: 'refused',
      dir: legacy,
      detail: `this process may not read ${legacy}. On macOS that is the app-data permission `
        + `("… would like to access data from other apps") for the app this is running under. `
        + `Run \`browser-automation profile --migrate\` once from a `
        + `terminal that can reach it, and every host will use the new location from then on.`,
    }
  }

  if (inUse(legacy)) {
    return {
      outcome: 'in-use',
      dir: legacy,
      detail: `a running Chrome has ${legacy} open, and a profile is never moved underneath one. `
        + `It moves on the next launch after that Chrome quits — or now, with \`browser-automation launch --restart\`.`,
    }
  }

  try {
    mkdirSync(dirname(home), { recursive: true })
    renameSync(legacy, home)
  } catch (e: any) {
    const code = e?.code
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        outcome: 'refused',
        dir: legacy,
        detail: `could not move ${legacy} (${code}): this process may not write Chrome's folder. `
          + `On macOS that is the app-data grant for the app this is running under. Nothing was changed; `
          + `the old profile keeps working. Run \`browser-automation profile --migrate\` once from a `
          + `terminal that can reach it.`,
      }
    }
    // EXDEV (different volumes) lands here on purpose: a cross-volume move is a
    // 5 GB copy, and a copy that dies halfway leaves a partial profile at the
    // new path that would then be preferred. Not worth it for a case that needs
    // ~ and ~/Library on different volumes.
    return {
      outcome: 'failed',
      dir: legacy,
      detail: `could not move ${legacy} to ${home} (${code ?? e?.message}). Nothing was changed; the old profile keeps working.`,
    }
  }

  // A Chrome that exited uncleanly leaves these symlinks naming its host and
  // pid. Harmless where they were; pointless to carry to a new home.
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(home, f), { force: true })
  }
  return { outcome: 'moved', dir: home, detail: `moved ${legacy} → ${home}` }
}
