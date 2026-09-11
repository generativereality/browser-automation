import { define } from 'gunshi'
import { consola } from 'consola'
import { listSessions } from '../core/session.js'
import { listPageTargets, listTargets } from '../core/cdp.js'

export const listCommand = define({
  name: 'list',
  description: 'List sessions and every open tab (with targetId + title) so you can pick -m/-t. Add --frames to also list cross-origin child iframes (OOPIFs) addressable with -F/-t.',
  args: {
    json: { type: 'boolean', description: 'Output raw JSON' },
    all: { type: 'boolean', description: 'Also list stale session bookmarks (tabs that no longer exist), instead of just counting them' },
    frames: { type: 'boolean', description: 'Also list cross-origin child iframes (OOPIFs) — their targetIds/URLs let you drive Stripe Elements, embedded SSO widgets, etc. via -F <substr> or -t <id>.' },
  },
  async run(ctx) {
    const sessions = listSessions()
    const targets = await listPageTargets().catch(() => [])
    const frames = ctx.values.frames
      ? (await listTargets().catch(() => [])).filter((t) => t.type === 'iframe')
      : []

    if (ctx.values.json) {
      process.stdout.write(JSON.stringify({ sessions, targets, ...(ctx.values.frames ? { frames } : {}) }, null, 2) + '\n')
      return
    }

    // **Stale bookmarks are counted, not listed.** Nothing prunes
    // ~/.browser-automation/sessions/, so it grows one file per session name
    // for ever: on 2026-09-11 this printed 105 session lines, most of them
    // [stale], for a Chrome holding 24 tabs. That wall of text was read as
    // "there are a hundred tabs open" and became the leading theory for a
    // renderer failure that has nothing to do with tab count — a healthy Chrome
    // has been driven to 421 tabs with every renderer alive. Hours went into it.
    // The stale ones are bookkeeping; the live ones are the answer.
    const liveIds = new Set(targets.map((t) => t.id))
    const live = sessions.filter((s) => liveIds.has(s.targetId))
    const stale = sessions.filter((s) => !liveIds.has(s.targetId))
    const shown = ctx.values.all ? sessions : live
    if (shown.length) {
      consola.log(`# sessions (${shown.length}${ctx.values.all ? '' : ' live'})`)
      for (const s of shown) {
        consola.log(`  ${s.name.padEnd(16)} [${liveIds.has(s.targetId) ? 'live' : 'stale'}] ${s.url ?? ''}`)
      }
    } else if (sessions.length) {
      consola.log(`# sessions (0 live)`)
    }
    if (stale.length && !ctx.values.all) {
      consola.log(`  + ${stale.length} stale bookmark(s) whose tab is gone — \`list --all\` to see them, \`gc --sessions\` to clear them`)
    }
    if (sessions.length) consola.log('')
    consola.log(`# open tabs (${targets.length}) — address with -t <id> or -m <substr>`)
    for (const t of targets) {
      const owner = sessions.find((s) => s.targetId === t.id)
      const title = (t.title ?? '').replace(/\s+/g, ' ').slice(0, 28)
      consola.log(`  ${t.id.slice(0, 12)}  ${owner ? `(${owner.name}) ` : ''}${title.padEnd(28)}  ${(t.url ?? '').slice(0, 70)}`)
    }
    if (ctx.values.frames) {
      consola.log('')
      consola.log(`# cross-origin iframes (${frames.length}) — address with -F <substr> or -t <id>`)
      for (const f of frames) {
        const title = (f.title ?? '').replace(/\s+/g, ' ').slice(0, 28)
        consola.log(`  ${f.id.slice(0, 12)}  ${title.padEnd(28)}  ${(f.url ?? '').slice(0, 70)}`)
      }
    }
  },
})
