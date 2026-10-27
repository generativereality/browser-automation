#!/usr/bin/env node
// A fake Chrome for the DevTools PIPE: what the broker starts in place of the
// real one. It reads NUL-terminated JSON on fd 3 and writes it on fd 4, as
// Chrome does under --remote-debugging-pipe, and exits when the pipe closes, as
// Chrome does (measured on Chrome 155).
//
// Its one trick: `Runtime.evaluate` answers with the id of the TARGET the
// session is attached to, so a test can tell whether a command reached the tab
// it named and nobody else's.
import { appendFileSync } from 'node:fs'
import { Socket } from 'node:net'

// Test hooks: FAKE_ATTACH_DELAY_MS answers an attach late, as a slow Chrome
// does; FAKE_EVENTS names a file that gets one line per attach, detach and method.
const attachDelay = Number(process.env.FAKE_ATTACH_DELAY_MS || 0)
const record = (line) => { if (process.env.FAKE_EVENTS) appendFileSync(process.env.FAKE_EVENTS, line + '\n') }

// Sockets on the inherited pipe fds, not fs streams: an fs stream reads a pipe
// with a blocking read() on the thread pool, and process.exit then waits on it.
const input = new Socket({ fd: 3, readable: true, writable: false })
const output = new Socket({ fd: 4, readable: false, writable: true })
const send = (m) => output.write(JSON.stringify(m) + '\0')

let n = 0
const targets = new Map([['T0', { targetId: 'T0', type: 'page', title: '', url: 'about:blank' }]])
const sessions = new Map() // sessionId -> targetId

function handle(m) {
  // Every method, and whether it came on a tab's session, for tests that need to
  // know which Chrome did the work (contexts.test.mjs).
  record(`method ${m.sessionId ? 'page' : 'browser'} ${m.method}`)
  const reply = (result) => send({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) })
  const error = (message) => send({ id: m.id, error: { code: -32602, message }, ...(m.sessionId ? { sessionId: m.sessionId } : {}) })
  switch (m.method) {
    case 'Browser.getVersion': return reply({ product: 'FakeChrome/1.0' })
    case 'Browser.close': reply({}); return setTimeout(() => process.exit(0), 50)
    case 'Target.getTargets': return reply({ targetInfos: [...targets.values(), { targetId: 'UI', type: 'browser_ui', title: '', url: '' }] })
    case 'Target.createTarget': {
      const targetId = `T${++n}`
      targets.set(targetId, { targetId, type: 'page', title: '', url: m.params.url })
      return reply({ targetId })
    }
    case 'Target.closeTarget': {
      const ok = targets.delete(m.params.targetId)
      for (const [s, t] of sessions) {
        if (t !== m.params.targetId) continue
        sessions.delete(s)
        send({ method: 'Target.detachedFromTarget', params: { sessionId: s, targetId: t } })
      }
      return reply({ success: ok })
    }
    case 'Target.attachToTarget': {
      if (!targets.has(m.params.targetId)) return error('No target with given id found')
      const sessionId = `S${++n}`
      sessions.set(sessionId, m.params.targetId)
      record(`attach ${sessionId}`)
      if (attachDelay) return setTimeout(() => reply({ sessionId }), attachDelay)
      return reply({ sessionId })
    }
    case 'Page.navigate': {
      // As a page does: answered, then its load event on the same session.
      const t = sessions.get(m.sessionId)
      if (t && targets.has(t)) targets.get(t).url = m.params.url
      reply({ frameId: 'F1', loaderId: 'L1' })
      return setTimeout(() => send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: m.sessionId }), 10)
    }
    case 'Target.detachFromTarget': sessions.delete(m.params.sessionId); record(`detach ${m.params.sessionId}`); return reply({})
    case 'Runtime.evaluate': {
      const t = sessions.get(m.sessionId)
      if (!t) return error('no session')
      const value = m.params.expression === '1+1' ? 2 : `${t}:${m.params.expression}`
      return reply({ result: { type: typeof value, value } })
    }
    default: return reply({})
  }
}

let buf = ''
input.setEncoding('utf8')
input.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\0')) >= 0) {
    const raw = buf.slice(0, i)
    buf = buf.slice(i + 1)
    handle(JSON.parse(raw))
  }
})
input.on('end', () => process.exit(0))
