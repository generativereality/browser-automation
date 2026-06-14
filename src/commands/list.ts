import { define } from 'gunshi'
import { consola } from 'consola'
import { listSessions } from '../core/session.js'
import { listPageTargets } from '../core/cdp.js'

export const listCommand = define({
  name: 'list',
  description: 'List sessions and every open tab (with targetId + title) so you can pick -m/-t',
  args: {
    json: { type: 'boolean', description: 'Output raw JSON' },
  },
  async run(ctx) {
    const sessions = listSessions()
    const targets = await listPageTargets().catch(() => [])

    if (ctx.values.json) {
      process.stdout.write(JSON.stringify({ sessions, targets }, null, 2) + '\n')
      return
    }

    const liveIds = new Set(targets.map((t) => t.id))
    if (sessions.length) {
      consola.log(`# sessions (${sessions.length})`)
      for (const s of sessions) {
        consola.log(`  ${s.name.padEnd(16)} [${liveIds.has(s.targetId) ? 'live' : 'stale'}] ${s.url ?? ''}`)
      }
      consola.log('')
    }
    consola.log(`# open tabs (${targets.length}) — address with -t <id> or -m <substr>`)
    for (const t of targets) {
      const owner = sessions.find((s) => s.targetId === t.id)
      const title = (t.title ?? '').replace(/\s+/g, ' ').slice(0, 28)
      consola.log(`  ${t.id.slice(0, 12)}  ${owner ? `(${owner.name}) ` : ''}${title.padEnd(28)}  ${(t.url ?? '').slice(0, 70)}`)
    }
  },
})
