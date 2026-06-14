// Network capture via CDP Network domain. Daemonless: connect to the tab,
// enable Network, optionally run a trigger (reload / click), watch for a window,
// then return the requests (with optional response bodies + headers). This is
// how you find the JSON API behind a dashboard and capture the auth headers it
// uses — the basis for robust API-based scraping instead of DOM reading.

import { connect, targetWsUrl, evaluate, TargetGoneError } from './cdp.js'
import { clickExpr } from './dom.js'

export interface NetEntry {
  requestId: string
  url: string
  method: string
  type: string
  status?: number
  mimeType?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  postData?: string
  body?: string
}

export interface CaptureOpts {
  durationMs?: number
  filter?: string
  all?: boolean
  wantBody?: boolean
  reload?: boolean
  clickRef?: string
  gotoUrl?: string
}

const INTERESTING = new Set(['XHR', 'Fetch', 'Document', 'WebSocket', 'EventSource'])

export async function captureNetwork(targetId: string, opts: CaptureOpts): Promise<NetEntry[]> {
  const { durationMs = 6000, filter, all = false, wantBody = false } = opts
  const wsUrl = await targetWsUrl(targetId)
  if (!wsUrl) throw new TargetGoneError(targetId)
  const s = await connect(wsUrl)
  try {
    try {
      await s.send('Network.enable', {}, 8000)
    } catch {
      throw new Error('Network.enable stalled — the page renderer is busy. Let the page finish loading and retry, and prefer --click over --reload on heavy SPAs.')
    }
    const byId = new Map<string, NetEntry>()

    s.on('Network.requestWillBeSent', (p: any) => {
      byId.set(p.requestId, {
        requestId: p.requestId,
        url: p.request?.url,
        method: p.request?.method,
        type: p.type,
        requestHeaders: p.request?.headers,
        postData: p.request?.postData,
      })
    })
    s.on('Network.responseReceived', (p: any) => {
      const e = byId.get(p.requestId)
      if (e) {
        e.status = p.response?.status
        e.mimeType = p.response?.mimeType
        e.responseHeaders = p.response?.headers
        if (p.type) e.type = p.type
      }
    })

    // Trigger (optional). reload/goto use this session; click uses its own.
    if (opts.reload) {
      await s.send('Page.enable')
      await s.send('Page.reload', {})
    } else if (opts.gotoUrl) {
      await s.send('Page.enable')
      await s.send('Page.navigate', { url: opts.gotoUrl })
    } else if (opts.clickRef) {
      await evaluate(targetId, clickExpr(opts.clickRef), { userGesture: true })
    }

    await new Promise((r) => setTimeout(r, durationMs))

    let entries = [...byId.values()].filter((e) => e.url && !e.url.startsWith('data:'))
    if (!all) entries = entries.filter((e) => INTERESTING.has(e.type))
    if (filter) {
      const f = filter.toLowerCase()
      entries = entries.filter((e) => e.url.toLowerCase().includes(f))
    }

    if (wantBody) {
      for (const e of entries) {
        try {
          const b: any = await s.send('Network.getResponseBody', { requestId: e.requestId })
          e.body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body
        } catch { /* body not available (in-flight, cached, or evicted) */ }
      }
    }

    return entries
  } finally {
    s.close()
  }
}
