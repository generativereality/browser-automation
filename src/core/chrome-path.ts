// Which Chrome binary `launch` starts — the one place that decides, as cdpPort()
// decides the port and resolveProfile() the profile. `launch` passes the answer
// to scripts/launch-chrome.sh with --chrome; the script keeps the same order
// only so a person running it by hand gets the same Chrome.
//
// Why it exists: Mind My Money's first run installs Chrome itself when it is
// missing, into /Applications when that is writable and otherwise into
// ~/Applications (an account that cannot write /Applications). The script
// hardcoded /Applications/Google Chrome.app and overwrote $CHROME, so a Chrome in
// ~/Applications could not be launched at all (2026-10-05).
//
// Order: an explicit BROWSER_AUTOMATION_CHROME or CHROME that points at an
// executable; then the platform's installs — macOS /Applications then
// ~/Applications; Windows Program Files, Program Files (x86), then the per-user
// %LOCALAPPDATA% install; Linux google-chrome / google-chrome-stable / chromium
// on PATH. An explicit path that is not executable is reported and skipped,
// never handed to `open` or spawn as if it were a browser.

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export interface ChromeChoice {
  /** The executable, or null when none was found. */
  path: string | null
  /** Where it came from, for doctor and error messages. */
  source: string
  /** An explicit override that was set but unusable — worth saying out loud. */
  ignored?: string
}

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    if (process.platform === 'win32') return true // no execute bit; a file is enough
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const MAC_BINARY = join('Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')

function platformCandidates(): Array<{ path: string; source: string }> {
  if (process.platform === 'darwin') {
    // Injected by the test suite only: this Mac's real /Applications Chrome
    // would otherwise win every fallback case.
    const system = process.env.BROWSER_AUTOMATION_TEST_SYSTEM_APPS || '/Applications'
    return [
      { path: join(system, MAC_BINARY), source: '/Applications' },
      { path: join(homedir(), 'Applications', MAC_BINARY), source: '~/Applications' },
    ]
  }
  if (process.platform === 'win32') {
    const out: Array<{ path: string; source: string }> = []
    const exe = join('Google', 'Chrome', 'Application', 'chrome.exe')
    if (process.env.PROGRAMFILES) out.push({ path: join(process.env.PROGRAMFILES, exe), source: 'Program Files' })
    if (process.env['PROGRAMFILES(X86)']) out.push({ path: join(process.env['PROGRAMFILES(X86)']!, exe), source: 'Program Files (x86)' })
    // The per-user install, which needs no administrator — what Mind My Money's
    // first run installs when it cannot install machine-wide.
    if (process.env.LOCALAPPDATA) out.push({ path: join(process.env.LOCALAPPDATA, exe), source: '%LOCALAPPDATA%' })
    return out
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .flatMap((name) => dirs.map((d) => ({ path: join(d, name), source: `PATH (${name})` })))
}

export function chromeExecutable(): ChromeChoice {
  let ignored: string | undefined
  for (const name of ['BROWSER_AUTOMATION_CHROME', 'CHROME'] as const) {
    const v = process.env[name]
    if (!v) continue
    if (executable(v)) return { path: v, source: name }
    ignored ??= `${name}=${v} is not an executable file`
  }
  const hit = platformCandidates().find((c) => executable(c.path))
  return hit ? { path: hit.path, source: hit.source, ignored } : { path: null, source: 'not found', ignored }
}

/** Where we looked, for a "not found" message. */
export function chromeSearchDescription(): string {
  if (process.platform === 'darwin') return '/Applications and ~/Applications'
  if (process.platform === 'win32') return 'Program Files, Program Files (x86) and %LOCALAPPDATA%'
  return 'google-chrome, google-chrome-stable, chromium and chromium-browser on PATH'
}
