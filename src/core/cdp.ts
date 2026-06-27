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

const DEFAULT_HOST = 'http://localhost:9223'

export function cdpHost(): string {
  return process.env.BROWSER_AUTOMATION_CDP || DEFAULT_HOST
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
async function withBrowser<T>(fn: (s: CdpSession) => Promise<T>): Promise<T> {
  const s = await connect(await browserWsUrl())
  try {
    return await fn(s)
  } finally {
    s.close()
  }
}

/** Create a new tab in the BACKGROUND (never steals focus) -> returns targetId. */
export async function createTab(url = 'about:blank'): Promise<string> {
  return withBrowser(async (s) => {
    const r = await s.send('Target.createTarget', { url, background: true })
    return r.targetId as string
  })
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
