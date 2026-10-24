// A fake Chrome that speaks just enough CDP to exercise renderer-health.
//
// The point is to hold ONE variable still: whether a brand-new target's
// renderer answers `Runtime.evaluate`. Everything a real wedged Chrome still
// does — serve `/json/version`, list targets, create and close targets over the
// browser WebSocket — this does too. What it can be told to do is go silent
// behind the page endpoint, which is the exact shape the CLI has to tell apart
// from "this browser can never make a renderer again".
//
// Node 22 ships a WebSocket *client* and no server, so the ~60 lines below are
// the server half of RFC 6455 (text frames only, which is all CDP uses).

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function sendText(sock, str) {
  const payload = Buffer.from(str, 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  sock.write(Buffer.concat([header, payload]))
}

/** Decode masked client frames; hand complete text payloads to `cb`. */
function onTextFrames(sock, head, cb) {
  let buf = Buffer.from(head ?? Buffer.alloc(0))
  const pump = () => {
    for (;;) {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      let mask
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4 }
      if (buf.length < off + len) return
      const payload = Buffer.from(buf.subarray(off, off + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      buf = buf.subarray(off + len)
      // Complete the close handshake. Without the echoed close frame the
      // client keeps the handle open and the CLI process never exits — which
      // looked exactly like the CLI hanging, and wasted a test run proving it.
      if (opcode === 0x8) { try { sock.write(Buffer.from([0x88, 0])) } catch {} ; sock.end(); return }
      if (opcode === 0x1) cb(payload.toString('utf8'))
    }
  }
  pump()
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump() })
  sock.on('error', () => {})
}

/**
 * @param {{ rendererAnswers?: boolean, createTargetHangs?: boolean, firesLoadEvent?: boolean }} opts
 *   rendererAnswers=false  -> page targets are created but never answer.
 *   createTargetHangs=true -> the browser endpoint never answers createTarget.
 *   firesLoadEvent=false   -> `Page.navigate` is answered but no
 *                             `Page.loadEventFired` ever follows.
 *   focusEmulationWorks=false -> Emulation.setFocusEmulationEnabled is answered
 *                             but the renderer goes on reporting itself hidden,
 *                             as an older Chrome without the command would.
 *   userTabs=['mail','calendar'] -> the person's own tabs, open before the CLI
 *                             touches anything, in ONE window showing the first.
 *                             `selectedTab()` then answers which tab that window
 *                             shows — what the person's typing goes into.
 *
 * Browser contexts (login contexts, issue #31) are modelled as Chrome 155
 * behaves, measured 2026-10-24: `Target.createBrowserContext` makes one with its
 * own cookie jar; `Target.getBrowserContexts` lists ONLY those, never the
 * default; `Target.createTarget` with an unknown `browserContextId` fails; and
 * ⛔ `Storage.*` with an unknown `browserContextId` silently acts on the DEFAULT
 * jar — the hazard the CLI must never trigger. `restart()` forgets every
 * context and tab, as a relaunched Chrome does; the default jar survives (it
 * is the profile on disk). `browserCalls` records every browser-level call
 * with its params, so a test can assert what the CLI asked for.
 *
 * The selected-tab model is Chrome's, as far as issue #28 needs it: a tab
 * created with `background: true` is not selected; `Target.activateTarget` and a
 * page's `Page.bringToFront` select it; closing the SELECTED tab selects its
 * neighbour (the previous tab in the strip, as Chrome does for a tab with no
 * opener), and closing any other tab changes nothing.
 *
 * ⭐ `firesLoadEvent` defaults TRUE because real Chrome fires it — measured at
 * 0.19s — and the default has to be the real world. It exists as a switch
 * because the two arms catch opposite faults, and a fixture that can only
 * express one of them cannot tell them apart: with the event, a slow exit means
 * somebody left a timer pending; without it, a slow exit is the timeout doing
 * its job and the fault to look for is a command that CLAIMS the page loaded.
 * Written the wrong way round first, and the test passed against the bug.
 */
export async function startFakeChrome(opts = {}) {
  const {
    rendererAnswers = true,
    createTargetHangs = false,
    firesLoadEvent = true,
    focusEmulationWorks = true,
    userTabs = [],
  } = opts
  const targets = new Map()
  const DEFAULT_CTX = 'DEFAULTCONTEXT0000000000000000000'
  // jars: context id -> cookies. The default jar is the user's profile.
  const jars = new Map([[DEFAULT_CTX, []]])
  const jarFor = (id) => (id && jars.has(id) ? jars.get(id) : jars.get(DEFAULT_CTX))
  // The tab strip of the person's one window, in order, and which tab it shows.
  const strip = []
  let selected = null
  for (const title of userTabs) {
    const id = randomBytes(16).toString('hex').toUpperCase()
    targets.set(id, { id, type: 'page', title, url: `https://example.test/${title}`, browserContextId: DEFAULT_CTX })
    strip.push(id)
  }
  selected = strip[0] ?? null
  const select = (id) => { if (targets.has(id)) selected = id }
  // `pageMethods` records what was asked of a PAGE endpoint, in order, so a test
  // can assert which route a command took — the quiet focus emulation or the
  // loud activation — rather than only that it printed something cheerful.
  const stats = { activations: 0, createTargets: 0, evaluates: 0, pageMethods: [], browserCalls: [] }

  // Whether the renderer currently believes it is focused. A real Chrome flips
  // this when Emulation.setFocusEmulationEnabled lands; an older build that does
  // not support the command leaves it false, which is the arm `focus` has to
  // report honestly instead of ticking.
  let emulatedFocus = false
  let port = 0
  const ws = (path) => `ws://127.0.0.1:${port}${path}`

  const json = (res, body) => {
    const s = JSON.stringify(body)
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
    res.end(s)
  }

  const server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    if (path === '/json/version') {
      return json(res, { Browser: 'FakeChrome/0.0.0', webSocketDebuggerUrl: ws('/devtools/browser/fake') })
    }
    if (path === '/json/list' || path === '/json') {
      return json(res, [...targets.values()].map(({ browserContextId: _c, ...t }) => ({ ...t, webSocketDebuggerUrl: ws(`/devtools/page/${t.id}`) })))
    }
    res.writeHead(404); res.end()
  })

  // Upgraded sockets are not the HTTP server's any more: closeAllConnections()
  // does not reach them, and one left half-open by a CLI that process.exit()s
  // mid-session (click --trusted failing actionability does) makes close()
  // wait for ever — which reads as the test hanging, not the harness.
  const sockets = new Set()
  server.on('upgrade', (req, sock, head) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    const key = req.headers['sec-websocket-key']
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}\r\n\r\n`,
    )
    const isBrowser = req.url.startsWith('/devtools/browser/')
    const pageId = req.url.split('/').pop()
    onTextFrames(sock, head, (text) => {
      let msg
      try { msg = JSON.parse(text) } catch { return }
      const reply = (result) => sendText(sock, JSON.stringify({ id: msg.id, result }))
      if (isBrowser) {
        stats.browserCalls.push({ method: msg.method, params: msg.params ?? {} })
        const fail = (message) => sendText(sock, JSON.stringify({ id: msg.id, error: { code: -32000, message } }))
        if (msg.method === 'Target.createBrowserContext') {
          const id = randomBytes(16).toString('hex').toUpperCase()
          jars.set(id, [])
          return reply({ browserContextId: id })
        }
        if (msg.method === 'Target.getBrowserContexts') {
          return reply({ browserContextIds: [...jars.keys()].filter((k) => k !== DEFAULT_CTX) })
        }
        if (msg.method === 'Target.disposeBrowserContext') {
          const id = msg.params?.browserContextId
          if (!jars.has(id) || id === DEFAULT_CTX) return fail(`Failed to find context with id ${id}`)
          jars.delete(id)
          for (const [tid, t] of targets) if (t.browserContextId === id) targets.delete(tid)
          return reply({})
        }
        if (msg.method === 'Target.getTargets') {
          return reply({ targetInfos: [...targets.values()].map((t) => ({ targetId: t.id, type: t.type, title: t.title, url: t.url, browserContextId: t.browserContextId })) })
        }
        if (msg.method === 'Storage.getCookies') {
          return reply({ cookies: [...jarFor(msg.params?.browserContextId)] })
        }
        if (msg.method === 'Storage.setCookies') {
          const jar = jarFor(msg.params?.browserContextId)
          for (const c of msg.params?.cookies ?? []) {
            const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path)
            const full = { expires: -1, session: c.expires === undefined, ...c }
            if (i >= 0) jar[i] = full; else jar.push(full)
          }
          return reply({})
        }
        if (msg.method === 'Target.createTarget') {
          stats.createTargets++
          if (createTargetHangs) return
          const ctxId = msg.params?.browserContextId
          if (ctxId !== undefined && !jars.has(ctxId)) return fail(`Failed to find browser context with id ${ctxId}`)
          const id = randomBytes(16).toString('hex').toUpperCase()
          targets.set(id, { id, type: 'page', title: '', url: msg.params?.url ?? 'about:blank', browserContextId: ctxId ?? DEFAULT_CTX })
          strip.push(id)
          if (msg.params?.background === false || selected === null) select(id)
          return reply({ targetId: id })
        }
        if (msg.method === 'Target.activateTarget') {
          stats.activations++
          select(msg.params?.targetId)
          return reply({})
        }
        if (msg.method === 'Target.closeTarget') {
          const id = msg.params?.targetId
          const at = strip.indexOf(id)
          targets.delete(id)
          if (at >= 0) strip.splice(at, 1)
          if (selected === id) selected = strip[Math.max(0, at - 1)] ?? null
          return reply({ success: true })
        }
        return reply({})
      }
      // Page endpoint: a silent renderer answers nothing at all.
      stats.pageMethods.push(msg.method)
      if (msg.method === 'Page.bringToFront') select(pageId)
      if (msg.method === 'Runtime.evaluate') stats.evaluates++
      if (!rendererAnswers) return
      if (msg.method === 'Emulation.setFocusEmulationEnabled') {
        if (focusEmulationWorks) emulatedFocus = msg.params?.enabled !== false
        return reply({})
      }
      // The focus probe asks for a shape, not a number — answer it as a real
      // renderer would, so the command's success path is reachable in a test.
      if (msg.method === 'Runtime.evaluate' && /document\.hasFocus/.test(msg.params?.expression ?? '')) {
        return reply({
          result: {
            type: 'object',
            value: { focused: emulatedFocus, visibility: emulatedFocus ? 'visible' : 'hidden' },
          },
        })
      }
      if (msg.method === 'Runtime.evaluate') return reply({ result: { type: 'number', value: 2 } })
      if (msg.method === 'Page.navigate') {
        reply({ frameId: 'f1' })
        // Real Chrome follows the reply with the load event a moment later.
        if (firesLoadEvent) {
          setTimeout(() => {
            try { sendText(sock, JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } })) } catch {}
          }, 10)
        }
        return
      }
      return reply({})
    })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
  return {
    port,
    endpoint: `http://127.0.0.1:${port}`,
    targetCount: () => targets.size,
    DEFAULT_CTX,
    /** The cookies in a context's jar (the default jar when no id is given). */
    cookies: (id) => [...jarFor(id)],
    /** Put a cookie straight into a jar — a login done by hand in that window. */
    addCookie: (id, cookie) => { jarFor(id).push({ path: '/', expires: -1, session: true, ...cookie }) },
    /** Ids of the CDP-created contexts that exist now. */
    contexts: () => [...jars.keys()].filter((k) => k !== DEFAULT_CTX),
    /** Which context a target is in. */
    contextOf: (targetId) => targets.get(targetId)?.browserContextId ?? null,
    /** A relaunched Chrome: every CDP context and every tab gone; the profile's own jar survives. */
    restart: () => {
      for (const k of [...jars.keys()]) if (k !== DEFAULT_CTX) jars.delete(k)
      targets.clear(); strip.length = 0; selected = null
    },
    /** Title (or id) of the tab the person's window shows. */
    selectedTab: () => (selected && (targets.get(selected)?.title || selected)) ?? null,
    stats,
    async close() {
      server.closeAllConnections?.()
      for (const sock of sockets) sock.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}
