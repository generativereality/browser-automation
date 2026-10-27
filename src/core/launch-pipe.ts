// `launch` on macOS and Linux: start the pipe broker (core/broker.ts), which
// starts Chrome. Windows keeps the port (core/launch-windows.ts).
//
// ⛔ **Chrome is exec'd here, not opened through open(1)** — the one thing
// scripts/launch-chrome.sh exists to avoid. open(1) hands the app to
// LaunchServices, and an app started that way inherits no file descriptors, so it
// cannot have our pipe. What open(1) bought was getting past the macOS app-data
// guard on a profile inside Google Chrome's own folder; the profile now lives
// under ~ (core/profile.ts), which no app guards, so a direct exec starts. A
// profile still in Chrome's folder is refused here with the way out, rather than
// started on the port.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brokerDir, browserVersion, closeBrowser, cdpPort, connect, socketPath } from './cdp.js'
import { socketAnswers, statePath, type BrokerState } from './broker.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function brokerLogPath(): string {
  return join(brokerDir(), 'broker.log')
}

export function brokerState(): BrokerState | null {
  try {
    return JSON.parse(readFileSync(statePath(socketPath()), 'utf8')) as BrokerState
  } catch {
    return null
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A browser answers on the socket: the broker is there AND Chrome replies. */
export async function pipeUp(timeout = 3000): Promise<boolean> {
  if (!(await socketAnswers(socketPath(), timeout))) return false
  return browserVersion(timeout).then(() => true, () => false)
}

/**
 * Is this user's Chrome from before the move still running on the port?
 *
 * It holds the profile, so a pipe Chrome cannot open it alongside — and it is
 * the very exposure the move exists to close. `launch` says so and stops;
 * `launch --restart` quits it.
 */
export function portChromeRunning(): boolean {
  try {
    execFileSync('pgrep', ['-u', String(process.getuid?.() ?? -1), '-f', '--', `--remote-debugging-port=${cdpPort()}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The --user-data-dir of this user's browser on the port, read off its command
 * line. The launch script's `--stop` waits for THAT profile's lock to go before
 * it escalates; given the wrong one it sees no lock, decides the profile is
 * released, and SIGKILLs a browser mid-flush.
 */
export function portChromeProfile(): string | null {
  let out: string
  try {
    out = execFileSync('ps', ['-Ao', 'uid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
  const uid = String(process.getuid?.() ?? -1)
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || m[1] !== uid) continue
    const cmd = m[2]
    if (!cmd.includes(`--remote-debugging-port=${cdpPort()}`) || cmd.includes('--type=')) continue
    const d = /--user-data-dir=(.+?)(?= --|$)/.exec(cmd)
    if (d) return d[1]
  }
  return null
}

/** Ask the browser on the port to quit the way its menu does, so it flushes its profile. */
export async function quitPortChrome(): Promise<void> {
  const v = await fetch(`http://127.0.0.1:${cdpPort()}/json/version`, { signal: AbortSignal.timeout(2000) })
  const ws = ((await v.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
  const s = await connect(ws, { timeout: 3000 })
  try {
    await s.send('Browser.close', {}, 3000).catch(() => {})
  } finally {
    s.close()
  }
}

/** Start the broker detached, and wait until Chrome answers through it. */
export async function startBroker(chrome: string, profile: string, chromeLog: string): Promise<{ ok: true; seconds: number } | { ok: false; reason: string }> {
  const start = Date.now()
  mkdirSync(brokerDir(), { recursive: true, mode: 0o700 })
  const logFd = openSync(brokerLogPath(), 'a', 0o600)
  // Our own entry point, so the broker is exactly this build of the CLI.
  const child = spawn(process.execPath, [process.argv[1], 'broker', '--chrome', chrome, '--profile', profile, '--log', chromeLog], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  // A cold start against a long-lived profile measured 10–16s (see the launch
  // script); 60s, as there.
  for (let i = 0; i < 240; i++) {
    if (await pipeUp(1000)) return { ok: true, seconds: Math.round((Date.now() - start) / 1000) }
    if (child.exitCode !== null) break
    await sleep(250)
  }
  return {
    ok: false,
    reason: `Chrome did not answer on ${socketPath()} within 60s. Broker log: ${brokerLogPath()}; Chrome's log: ${chromeLog}`,
  }
}

/**
 * Quit the pipe Chrome and wait for the broker to go, which is when Chrome has
 * exited and released the profile. Browser.close first, so the profile is
 * flushed; the broker's own SIGTERM path next; SIGKILL only after that.
 */
export async function stopBroker(log: (s: string) => void): Promise<void> {
  const st = brokerState()
  await closeBrowser().catch(() => {})
  const gone = () => !alive(st?.brokerPid) && !alive(st?.chromePid) && !existsSync(socketPath())
  for (let i = 0; i < 60 && !gone(); i++) await sleep(250)
  if (gone()) return
  if (alive(st?.brokerPid)) {
    log('Chrome did not quit within 15s of being asked; asking the broker to stop it.')
    process.kill(st!.brokerPid, 'SIGTERM')
    for (let i = 0; i < 100 && !gone(); i++) await sleep(250)
  }
  if (gone()) return
  log('Still running after 40s; sending SIGKILL.')
  for (const pid of [st?.chromePid, st?.brokerPid]) if (alive(pid)) process.kill(pid!, 'SIGKILL')
  for (let i = 0; i < 20 && (alive(st?.chromePid) || alive(st?.brokerPid)); i++) await sleep(250)
  if (alive(st?.chromePid)) throw new Error(`Chrome (pid ${st?.chromePid}) would not exit, even on SIGKILL. Not relaunching on top of it.`)
}
