// `launch` on Windows: the same contract as scripts/launch-chrome.sh on macOS and
// Linux, implemented here because that script is POSIX through and through
// (open(1), pgrep, pkill, nohup) and under Git Bash it stopped at its OS check:
// "unsupported OS MINGW64_NT ARM64" (Mind My Money 0.1.0 on Windows, 2026-09-30),
// so agents started Chrome by hand. A TypeScript path needs nothing but Node,
// which the CLI already requires — no Git Bash, no bash at all.
//
// The contract, per the script:
//   * one Chrome per user on the CDP port, with the persistent profile;
//   * idempotent: a Chrome of OURS already serving the port is "already running";
//   * a Chrome on the port that is NOT ours is refused, never driven — it would
//     act in another account's browser;
//   * --restart quits ours cleanly (the profile holds the logins), then relaunches;
//   * --status answers only "is anything serving this port".
//
// "Ours" on Windows = a chrome.exe in OUR logon session whose command line
// carries our --remote-debugging-port and no --type=. Session, not just port:
// an administrator sees every user's command lines.

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { closeBrowser } from './cdp.js'
import { chromeExecutable } from './chrome-path.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** chrome.exe — decided in one place for every platform (core/chrome-path.ts). */
export function windowsChromeExe(): string | null {
  return chromeExecutable().path
}

/** Is anything answering CDP on this port? (The script's `is_up`.) */
export async function cdpUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

/**
 * pid of OUR automation Chrome's browser process on this port, or 0.
 *
 * PowerShell for the command lines: Node cannot read another process's command
 * line on Windows, and `wmic` is gone from Windows 11 25H2.
 */
export function ourChromePid(port: number): number {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$re = '--remote-debugging-port=${port}(\\s|"|$)'`,
    '$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId',
    "$b = Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |",
    "  Where-Object { $_.SessionId -eq $sid -and $_.CommandLine -and $_.CommandLine -match $re -and $_.CommandLine -notmatch '--type=' } |",
    '  Select-Object -First 1 -ExpandProperty ProcessId',
    "Write-Output ('BA-PID ' + [int]$b)",
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true,
    })
    return Number(/^BA-PID (\d+)\s*$/m.exec(out)?.[1] ?? 0)
  } catch {
    return 0
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * Quit OUR Chrome on this port and wait until it has really exited.
 *
 * CDP Browser.close first — Chrome's own quit, which flushes the profile that
 * holds the logins. On Windows the process does exit after it (unlike macOS,
 * where it lingers windowless). taskkill /F only if it will not go.
 */
export async function stopOurChrome(port: number, say: (s: string) => void): Promise<'stopped' | 'none' | 'not-ours'> {
  const pid = ourChromePid(port)
  if (!pid) return (await cdpUp(port)) ? 'not-ours' : 'none'
  await closeBrowser().catch(() => {})
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250)
  if (alive(pid)) {
    say(`Chrome (pid ${pid}) did not exit within 10s of being asked to quit; ending it.`)
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* reported below */ }
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250)
  }
  if (alive(pid)) throw new Error(`Chrome on :${port} (pid ${pid}) would not exit. Not relaunching on top of it.`)
  // Chrome releases the port a beat after the process is gone; relaunching into
  // that window gives a browser that cannot bind CDP.
  for (let i = 0; i < 20 && (await cdpUp(port)); i++) await sleep(250)
  return 'stopped'
}

export type StartResult =
  | { outcome: 'already-running' }
  | { outcome: 'launched'; seconds: number }
  | { outcome: 'not-ours' }
  | { outcome: 'no-chrome' }
  | { outcome: 'timeout'; log: string }

/** Start the automation Chrome unless ours is already serving the port. */
export async function startChrome(port: number, profile: string, log: string): Promise<StartResult> {
  if (await cdpUp(port)) return ourChromePid(port) ? { outcome: 'already-running' } : { outcome: 'not-ours' }
  const exe = windowsChromeExe()
  if (!exe) return { outcome: 'no-chrome' }

  mkdirSync(profile, { recursive: true })
  mkdirSync(dirname(log), { recursive: true })
  // Keep the previous browser's log: after a restart it is the one with the
  // reason in it (same as the script's chrome-<port>.log.prev).
  try { if (statSync(log).size > 0) renameSync(log, `${log}.prev`) } catch { /* no previous log */ }
  const fd = openSync(log, 'a')

  // Detached + unref: Chrome must outlive this CLI process (every command is a
  // fresh, short-lived process). Not windowsHide — this is the headed browser
  // a person is meant to be able to see.
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: ['ignore', fd, fd] })
  child.unref()

  const started = Date.now()
  // A cold start against a long-lived profile took 10-16s on macOS; same budget.
  for (let i = 0; i < 240; i++) {
    if (await cdpUp(port)) return { outcome: 'launched', seconds: Math.round((Date.now() - started) / 1000) }
    await sleep(250)
  }
  return { outcome: 'timeout', log }
}
