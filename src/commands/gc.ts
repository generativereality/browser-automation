import { define } from 'gunshi'
import { consola } from 'consola'
import { listSessions, deleteSession } from '../core/session.js'
import { listPageTargets, closeTab } from '../core/cdp.js'
import { renderersAnswer } from '../core/renderer-health.js'

/**
 * Tidy up what accumulates when many sessions share one Chrome for weeks.
 *
 * Two different kinds of junk, and only one of them is a browser tab:
 *
 *  - **Stale session bookmarks** — a `~/.browser-automation/sessions/*.json`
 *    pointing at a targetId that no longer exists (its tab was closed, or
 *    Chrome restarted and reissued every id). Purely local; deleting one
 *    cannot affect anybody's browsing.
 *  - **Dead tabs** — page targets whose renderer does not answer. On a wedged
 *    Chrome these breed: every `new` that failed left a blank-titled corpse
 *    behind. They are unusable by definition — nothing can read, click or
 *    navigate them — so closing them takes nothing away.
 *
 * What it will NOT do without being asked twice is close a *working* tab it
 * merely cannot attribute to a session. Tabs are addressed by `-m` as often as
 * by `-s`, and the user opens tabs by hand in this same window, so "no session
 * claims it" is not evidence that nobody wants it. That lives behind
 * `--orphans`, and even then it lists everything first.
 *
 * **`gc` is not a fix for a Chrome that cannot launch renderers.** It is worth
 * being blunt about, because reaching for it is the obvious move once you have
 * been told there are 66 tabs open: the wedge has nothing to do with tab count
 * (a healthy Chrome runs fine at 421), so closing tabs changes nothing about
 * it. `doctor` says so, and so does the summary here when the probe fails.
 */
export const gcCommand = define({
  name: 'gc',
  description: 'Clean up stale session bookmarks and dead tabs. Use --dry first; --orphans also closes working tabs no session claims.',
  args: {
    dry: { type: 'boolean', description: 'Show what would be removed, change nothing' },
    orphans: { type: 'boolean', description: 'ALSO close live tabs that no session claims (includes tabs opened by hand — review the --dry output first)' },
    sessions: { type: 'boolean', description: 'Only prune stale session files; touch no tabs' },
  },
  async run(ctx) {
    const dry = !!ctx.values.dry
    const act = dry ? 'would remove' : 'removed'
    const actTab = dry ? 'would close' : 'closed'

    const sessions = listSessions()
    const pages = await listPageTargets()
    const liveIds = new Set(pages.map((t) => t.id))

    // 1. Stale session bookmarks — local files, always safe.
    const stale = sessions.filter((s) => !liveIds.has(s.targetId))
    for (const s of stale) {
      if (!dry) deleteSession(s.name)
      consola.log(`  session  ${act}  ${s.name}  (tab gone: ${s.targetId.slice(0, 12)}…)`)
    }

    if (ctx.values.sessions) {
      consola.success(`${stale.length} stale session bookmark(s) ${act}. No tabs touched.`)
      return
    }

    // 2. Dead tabs — a renderer that will not answer cannot be used by anyone.
    //    Probed in parallel; a wedged Chrome can have dozens and each costs a
    //    full timeout when done one at a time.
    const claimed = new Map(sessions.filter((s) => liveIds.has(s.targetId)).map((s) => [s.targetId, s.name]))
    const probes = await Promise.all(
      pages.map(async (t) => ({ t, dead: await renderersAnswer(t.id, 4000).catch(() => 'probe failed') })),
    )
    const dead = probes.filter((p) => p.dead)
    for (const { t, dead: why } of dead) {
      const owner = claimed.get(t.id)
      if (!dry) await closeTab(t.id).catch(() => {})
      consola.log(`  dead tab ${actTab}  ${t.id.slice(0, 12)}…  ${owner ? `(${owner}) ` : ''}${(t.url ?? '').slice(0, 60) || '(no url)'}  — ${why}`)
    }

    // 3. Orphans — live, working, unclaimed. Opt-in only.
    const orphans = probes.filter((p) => !p.dead && !claimed.has(p.t.id))
    if (ctx.values.orphans) {
      for (const { t } of orphans) {
        if (!dry) await closeTab(t.id).catch(() => {})
        consola.log(`  orphan   ${actTab}  ${t.id.slice(0, 12)}…  ${(t.title ?? '').slice(0, 28).padEnd(28)}  ${(t.url ?? '').slice(0, 50)}`)
      }
    }

    consola.log('')
    consola.success(
      `${stale.length} stale bookmark(s) and ${dead.length} dead tab(s) ${dry ? 'would be removed' : 'removed'}`
      + (ctx.values.orphans ? `, ${orphans.length} orphan tab(s) ${actTab}` : '')
      + '.',
    )
    if (!ctx.values.orphans && orphans.length) {
      consola.log(`  ${orphans.length} live tab(s) no session claims were left alone — \`gc --orphans --dry\` to review them.`)
    }
    if (dead.length && dead.length === pages.length && pages.length > 0) {
      consola.warn(
        `Every open tab was dead. That is the shape of a Chrome that can no longer launch renderers, `
        + `which closing tabs does not fix — run \`browser-automation doctor\` for the diagnosis.`,
      )
    }
  },
})
