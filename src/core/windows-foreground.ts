// Windows: which process owns the foreground window, and which process is the
// automation Chrome — answered together, because each answer costs a PowerShell
// start-up and `--show` needs both.
//
// The rule is the macOS one (see core/show.ts): select the working tab only when
// the automation Chrome ALREADY owns the foreground window, so nothing is ever
// raised. Matched by PROCESS ID, never by name: the person's everyday Chrome is
// also chrome.exe.
//
// Why PowerShell and not a native addon: this CLI ships as plain JS with no
// native dependencies, and `user32` is reachable from PowerShell's Add-Type with
// nothing installed. The script goes in as -EncodedCommand (base64 of UTF-16LE),
// the one form whose text no quoting layer — Node, cmd, PowerShell 5.1 — can
// alter; it is a few hundred characters, far below the ~32 KiB command-line
// limit that makes long encoded commands fail as "the guest is dead".

import { execFileSync } from 'node:child_process'

/** The script, with the port substituted. Exported so the test can read it. */
export function probeScript(port: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // Add-Type, deliberately, although it runs the C# compiler each call
    // (195-275ms on the ARM64 guest). Reflection.Emit's DefinePInvokeMethod is
    // 40-80ms and was tried: in the interactive session its GetForegroundWindow
    // returned 0 — no error — so every --show answered "cannot tell" while a
    // window was plainly in front (2026-10-02). Over SSH it looked fine, because
    // session 0 has no foreground window either way. Do not swap it back
    // without testing in session 1. The second argument is an OUT uint.
    "Add-Type -Namespace BrowserAutomation -Name User32 -MemberDefinition @'",
    '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);',
    "'@",
    '$U = [BrowserAutomation.User32]',
    '$h = $U::GetForegroundWindow()',
    '$fg = [uint32]0',
    'if ($h -ne [IntPtr]::Zero) { [void]$U::GetWindowThreadProcessId($h, [ref]$fg) }',
    // The browser process is the chrome.exe whose command line carries OUR port
    // and no --type= (renderers, GPU and utility processes all carry --type=).
    // The port must END there: '=9223' must not match '=92230'.
    `$re = '--remote-debugging-port=${port}(\\s|"|$)'`,
    // And in OUR logon session: an administrator sees every user's command
    // lines, so a port match alone can find another account's Chrome. The
    // foreground window always belongs to this session, so this is also the
    // only Chrome the comparison can sensibly be about.
    '$sid = [System.Diagnostics.Process]::GetCurrentProcess().SessionId',
    "$b = Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" |",
    "  Where-Object { $_.SessionId -eq $sid -and $_.CommandLine -and $_.CommandLine -match $re -and $_.CommandLine -notmatch '--type=' } |",
    '  Select-Object -First 1 -ExpandProperty ProcessId',
    "Write-Output ('BA-FG ' + $fg + ' ' + [int]$b)",
  ].join('\n')
}

export interface WindowsForeground {
  /** pid owning the foreground window; 0 when there is none (locked screen, a service session). */
  foreground: number
  /** pid of the automation Chrome's browser process; 0 when not found. */
  browser: number
}

/**
 * Read the answer out of PowerShell's stdout.
 *
 * Scans for the line with the expected SHAPE rather than taking the first line:
 * a PowerShell child process can put other things on its streams (CLIXML
 * progress records, "Preparing modules for first use"), and keying on line one
 * is how a parser starts failing the day something precedes the answer.
 */
export function parseProbe(stdout: string): WindowsForeground | null {
  const m = /^BA-FG (\d+) (\d+)\s*$/m.exec(stdout)
  return m ? { foreground: Number(m[1]), browser: Number(m[2]) } : null
}

export function windowsForeground(port: number): WindowsForeground | null {
  const encoded = Buffer.from(probeScript(port), 'utf16le').toString('base64')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      windowsHide: true,
    })
    return parseProbe(out)
  } catch {
    return null
  }
}
