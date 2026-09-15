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
  } = opts
  const targets = new Map()
  // `pageMethods` records what was asked of a PAGE endpoint, in order, so a test
  // can assert which route a command took — the quiet focus emulation or the
  // loud activation — rather than only that it printed something cheerful.
  const stats = { activations: 0, createTargets: 0, evaluates: 0, pageMethods: [] }
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
      return json(res, [...targets.values()].map((t) => ({ ...t, webSocketDebuggerUrl: ws(`/devtools/page/${t.id}`) })))
    }
    res.writeHead(404); res.end()
  })

  server.on('upgrade', (req, sock, head) => {
    const key = req.headers['sec-websocket-key']
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}\r\n\r\n`,
    )
    const isBrowser = req.url.startsWith('/devtools/browser/')
    onTextFrames(sock, head, (text) => {
      let msg
      try { msg = JSON.parse(text) } catch { return }
      const reply = (result) => sendText(sock, JSON.stringify({ id: msg.id, result }))
      if (isBrowser) {
        if (msg.method === 'Target.createTarget') {
          stats.createTargets++
          if (createTargetHangs) return
          const id = randomBytes(16).toString('hex').toUpperCase()
          targets.set(id, { id, type: 'page', title: '', url: msg.params?.url ?? 'about:blank' })
          return reply({ targetId: id })
        }
        if (msg.method === 'Target.activateTarget') {
          stats.activations++
          return reply({})
        }
        if (msg.method === 'Target.closeTarget') {
          targets.delete(msg.params?.targetId)
          return reply({ success: true })
        }
        return reply({})
      }
      // Page endpoint: a silent renderer answers nothing at all.
      stats.pageMethods.push(msg.method)
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
    stats,
    async close() {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}
