// Daemonless, per-target Chrome DevTools Protocol client.
//
// Every operation opens a short-lived WebSocket to ONE target (a single tab's
// `webSocketDebuggerUrl`, or the browser endpoint for tab create/close), runs
// its commands, and closes. There is no long-lived process and no
// whole-browser `connectOverCDP` enumeration — so a stuck iframe/worker can't
// wedge us, and parallel sessions never share a connection (no id collisions,
// no event cross-talk). Isolation comes from each session only ever touching
// its own targetId; we never call Target.activateTarget / Page.bringToFront,
// so we never steal focus from the user or from sibling sessions.

// The debugging port is PER-USER, and that is not a nicety.
//
// `127.0.0.1` is machine-wide, not per-account, and Chrome's DevTools protocol
// has no authentication — so with one hardcoded port, the first macOS account
// to `launch` owns it and **every other account's automation silently drives
// that account's browser**. Reported 2026-08-08: an app running as a second
// user drove the first user's Chrome all day, reporting page loads it had
// genuinely performed, in somebody else's session. Nothing errors; the tab just
// opens in the wrong place, and on a real task that place is signed into
// somebody's bank.
//
// So the port is derived from the uid. The first human account on the platform
// keeps 9223 — the overwhelmingly common single-user case is unchanged, and an
// upgrade does not orphan a Chrome that is already running — and everybody else
// gets 9224, 9225, and so on.
const BASE_PORT = 9223
// The uid the platform hands its first human account. Everything below it is
/// a system account, which will not be running a headed Chrome.
const FIRST_HUMAN_UID = process.platform === 'darwin' ? 501 : 1000

/**
 * The CDP port for THIS user.
 *
 * `BROWSER_AUTOMATION_PORT` overrides it, for the cases a formula cannot know
 * about: a shared CI box, a container, or somebody who simply wants two.
 *
 * **This is the only place the number is decided.** It was copied into
 * `scripts/launch-chrome.sh` within an hour of being written, each copy with a
 * comment promising to keep it in step — which is the tell, not the plan. The
 * script asks `browser-automation port` instead, and the `port` command exists
 * for exactly that.
 */
export function cdpPort(): number {
  const explicit = Number(process.env.BROWSER_AUTOMATION_PORT)
  if (Number.isInteger(explicit) && explicit > 0 && explicit < 65536) return explicit
  const uid = typeof process.getuid === 'function' ? process.getuid() : FIRST_HUMAN_UID
  const offset = uid - FIRST_HUMAN_UID
  // A uid outside the ordinary human range (a system account, or a directory
  // service handing out five-digit ids) still gets its own port rather than
  // sharing one. Deterministic, and `BROWSER_AUTOMATION_PORT` is the way out if
  // two of them ever land on the same number.
  if (offset < 0 || offset > 499) return BASE_PORT + 500 + (uid % 500)
  return BASE_PORT + offset
}

export function cdpHost(): string {
  return process.env.BROWSER_AUTOMATION_CDP || `http://localhost:${cdpPort()}`
}

/** A target has gone away (tab closed, or Chrome restarted -> new targetIds). */
export class TargetGoneError extends Error {
  constructor(public targetId: string) {
    super(`target ${targetId} not found on ${cdpHost()} (tab closed or Chrome restarted)`)
    this.name = 'TargetGoneError'
  }
}

export interface CdpTarget {
  id: string
  type: string
  title?: string
  url?: string
  webSocketDebuggerUrl?: string
}

async function httpJson<T>(path: string): Promise<T> {
  const res = await fetch(`${cdpHost()}${path}`)
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${path} — is Chrome running with --remote-debugging-port? (${cdpHost()})`)
  return (await res.json()) as T
}

export async function browserWsUrl(): Promise<string> {
  const v = await httpJson<{ webSocketDebuggerUrl: string }>('/json/version')
  return v.webSocketDebuggerUrl
}

export async function listTargets(): Promise<CdpTarget[]> {
  return httpJson<CdpTarget[]>('/json/list')
}

export async function listPageTargets(): Promise<CdpTarget[]> {
  return (await listTargets()).filter((t) => t.type === 'page')
}

/** webSocketDebuggerUrl for a targetId, or null if it no longer exists. */
export async function targetWsUrl(targetId: string): Promise<string | null> {
  const t = (await listTargets()).find((t) => t.id === targetId)
  return t?.webSocketDebuggerUrl ?? null
}

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>
  on(method: string, cb: (params: any) => void): void
  close(): void
}

/** Open a CDP session to an arbitrary webSocketDebuggerUrl (page or browser). */
export function connect(wsUrl: string, { timeout = 15000 } = {}): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>()
    const listeners = new Map<string, Array<(p: any) => void>>()

    const openTimer = setTimeout(() => {
      try { ws.close() } catch { /* ignore */ }
      reject(new Error(`CDP connect timeout ${timeout}ms to ${wsUrl}`))
    }, timeout)

    ws.addEventListener('open', () => {
      clearTimeout(openTimer)
      resolve({
        send(method, params = {}, timeoutMs = 30000) {
          return new Promise((res, rej) => {
            const id = nextId++
            const t = setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            pending.set(id, {
              resolve: (v: any) => { clearTimeout(t); res(v) },
              reject: (e: Error) => { clearTimeout(t); rej(e) },
              method,
            })
            ws.send(JSON.stringify({ id, method, params }))
          })
        },
        on(method, cb) {
          const arr = listeners.get(method) ?? []
          arr.push(cb)
          listeners.set(method, arr)
        },
        close() {
          try { ws.close() } catch { /* ignore */ }
        },
      })
    })

    ws.addEventListener('message', (ev: any) => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const cb of listeners.get(msg.method) ?? []) cb(msg.params)
      }
    })

    ws.addEventListener('error', () => {
      clearTimeout(openTimer)
      reject(new Error(`WebSocket error connecting to ${wsUrl}`))
    })
  })
}

/** Run `fn` against a session bound to a single page target, then close it. */
export async function withPage<T>(targetId: string, fn: (s: CdpSession) => Promise<T>): Promise<T> {
  const wsUrl = await targetWsUrl(targetId)
  if (!wsUrl) throw new TargetGoneError(targetId)
  const s = await connect(wsUrl)
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

/** Make a page target behave as the foreground tab for trusted CDP input,
 *  WITHOUT stealing OS focus from the user's other apps.
 *
 *  CDP `Input.*` events (and the user-activation they grant) are dropped by the
 *  renderer when the tab's `visibilityState` is `hidden` — which it is whenever
 *  the automation Chrome window isn't the frontmost OS window (the normal case:
 *  the user is in their terminal). `Page.bringToFront` alone does NOT fix this;
 *  the tab still reports `hidden`. `Emulation.setFocusEmulationEnabled` forces
 *  the renderer to treat itself as focused+visible regardless of the real window
 *  state (this is how Playwright drives backgrounded/headless pages), and
 *  `Page.setWebLifecycleState: active` un-throttles a frozen tab. Together they
 *  flip `document.hasFocus()`+`visibilityState:visible` on, so a trusted click /
 *  drag actually lands and grants user activation — which activation-gated flows
 *  (e.g. drop-zone uploaders that only start work inside a user gesture) require.
 *
 *  All three are best-effort: older Chrome builds may not expose every command. */
export async function forceForeground(s: CdpSession): Promise<void> {
  await s.send('Page.bringToFront').catch(() => {})
  await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await s.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
}

/** Run `fn` against the browser-level endpoint (Target.* commands), then close. */
async function withBrowser<T>(fn: (s: CdpSession) => Promise<T>, timeout?: number): Promise<T> {
  const s = await connect(await browserWsUrl(), timeout === undefined ? undefined : { timeout })
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

/**
 * Create a new tab in the BACKGROUND (never steals focus) -> returns targetId.
 *
 * `timeout` exists for the health probe. On a browser that has lost the ability
 * to make renderers, `Target.createTarget` itself can hang rather than fail, so
 * a caller that means to spend ~100ms deciding whether the browser works would
 * otherwise sit on the default 30s — measured 2026-09-07, when this put a 30s
 * stall in front of every `launch` on a wedged Chrome. Ordinary callers pass
 * nothing and keep the generous default, which is right for them: a real tab
 * opening slowly should still open.
 */
export async function createTab(url = 'about:blank', { timeout }: { timeout?: number } = {}): Promise<string> {
  return withBrowser(async (s) => {
    const r = await s.send('Target.createTarget', { url, background: true }, timeout)
    return r.targetId as string
  }, timeout)
}

export async function closeTab(targetId: string): Promise<boolean> {
  return withBrowser(async (s) => {
    const r = await s.send('Target.closeTarget', { targetId })
    return !!r.success
  })
}

/** Evaluate a JS expression in a page target and return its value by-value.
 *  Set userGesture for actions that require user activation (e.g. downloads). */
export async function evaluate<T = any>(
  targetId: string,
  expression: string,
  { userGesture = false }: { userGesture?: boolean } = {},
): Promise<T> {
  return withPage(targetId, async (s) => {
    const res = await s.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    })
    if (res.exceptionDetails) {
      const e = res.exceptionDetails
      throw new Error('page JS exception: ' + (e.exception?.description || e.text || 'unknown'))
    }
    return res.result?.value as T
  })
}

/** Re-evaluate until `ready(value)` is true or the timeout elapses (Playwright-
 * style auto-wait for SPA content that renders after load). Returns the last
 * value regardless, so callers can still handle a genuinely-empty page. */
export async function evaluateUntil<T = any>(
  targetId: string,
  expression: string,
  ready: (v: T) => boolean,
  { timeout = 5000, interval = 250 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout
  let last = await evaluate<T>(targetId, expression)
  while (!ready(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    last = await evaluate<T>(targetId, expression)
  }
  return last
}

/** Capture a PNG screenshot of a page target (optionally the full page). */
export async function captureScreenshot(targetId: string, { fullPage = false }: { fullPage?: boolean } = {}): Promise<Buffer> {
  return withPage(targetId, async (s) => {
    const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage })
    return Buffer.from(r.data, 'base64')
  })
}

/** Navigate a page target and wait for load (or timeout). */
export async function navigate(targetId: string, url: string, { timeout = 30000 } = {}): Promise<void> {
  return withPage(targetId, async (s) => {
    await s.send('Page.enable')
    const loaded = new Promise<void>((resolve) => s.on('Page.loadEventFired', () => resolve()))
    const r = await s.send('Page.navigate', { url })
    if (r.errorText) throw new Error(`navigate failed: ${r.errorText}`)
    await Promise.race([loaded, new Promise<void>((res) => setTimeout(res, timeout))])
  })
}
