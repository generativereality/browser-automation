import { define } from 'gunshi'
import consola from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { activateTab, forceForeground, withPage } from '../core/cdp.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Make a tab believe it is the visible one.
 *
 * # Why this exists
 *
 * A backgrounded tab is not merely unwatched — it reports itself hidden, and
 * pages act on that. Measured 2026-09-14 on an ordinary tab this CLI had opened:
 *
 *     {"visibility":"hidden","hasFocus":false,"hidden":true}
 *
 * Anything gated on `document.visibilityState` behaves differently there:
 * deferred rendering, paused polling and animation, charts that never draw,
 * carousels and videos that never start. `core/renderer-wake.ts` measures the
 * same deprioritisation one layer down — a background target's renderer answers
 * in a median 367ms against 19ms once activated, with a tail past 12s.
 *
 * Until now nothing exposed this. `click --trusted` and `drop` both force it as
 * a side effect of needing trusted input to land, so the capability was in the
 * codebase and reachable only by clicking something.
 *
 * # The two ways, and why the quiet one is the default
 *
 * `Emulation.setFocusEmulationEnabled` makes the renderer treat itself as
 * focused and visible whatever the real window is doing — no window moves, and
 * the operator's frontmost app is undisturbed. That is what this does by
 * default, and it is how Playwright drives backgrounded pages.
 *
 * `--raise` additionally calls `Target.activateTarget`, which genuinely brings
 * the tab to the front and **takes the operator's screen** — measured in
 * renderer-wake.ts: every route to a real activation moved the frontmost app
 * from the terminal to Chrome, and there is no quiet variant. Use it when a
 * person needs to SEE the tab, not to make a page render.
 *
 * # It reports the outcome, not the acceptance
 *
 * All three CDP commands are best-effort — an older Chrome may not expose one —
 * so "sent" says nothing. This reads `document.hasFocus()` and
 * `visibilityState` back afterwards and prints what it actually achieved,
 * naming what it could not confirm rather than printing a tick over it.
 */
export const focusCommand = define({
  name: 'focus',
  description:
    'Make a tab report itself focused + visible, so pages that defer work while hidden (rendering, polling, charts, video) behave as if watched. Quiet by default — no window moves and the operator keeps their frontmost app. Add --raise to genuinely bring the tab to the front, which DOES take the screen.',
  args: {
    ...targetArgs,
    raise: {
      type: 'boolean',
      short: 'r',
      description:
        'Also bring the tab to the front for real (Target.activateTarget). This takes the operator\'s screen — Chrome comes forward over whatever they are using. Only for when a person needs to see the tab.',
    },
  },
  async run(ctx) {
    const raise = ctx.values.raise as boolean | undefined
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))

    if (raise) await activateTab(targetId)

    const state = await withPage(targetId, async (s) => {
      await forceForeground(s)
      // The renderer reflects it a beat later, exactly as the trusted-click path
      // waits rather than assuming. Poll briefly rather than sleeping a fixed
      // guess; a tab that is already foreground answers on the first pass.
      const deadline = Date.now() + 2000
      let last = { focused: false, visibility: 'unknown' as string }
      while (Date.now() < deadline) {
        const r = await s.send('Runtime.evaluate', {
          expression: '({focused:document.hasFocus(),visibility:document.visibilityState})',
          returnByValue: true,
        })
        last = (r.result?.value as typeof last) ?? last
        if (last.focused && last.visibility === 'visible') break
        await sleep(50)
      }
      return last
    })

    const how = raise ? 'raised to the front' : 'no window focus taken'
    if (state.focused && state.visibility === 'visible') {
      consola.success(`[${targetId.slice(0, 12)}…] focused + visible (${how})`)
      return
    }
    // Do not dress a partial result as a success. Say which half is missing —
    // a page that is `visible` but not focused still renders, and that is the
    // usual reason to run this at all.
    consola.warn(
      `[${targetId.slice(0, 12)}…] hasFocus=${state.focused} visibilityState=${state.visibility} (${how}). `
      + `The page may still defer work it gates on focus. `
      + (raise ? '' : 'If the page needs a genuinely front tab, re-run with --raise.'),
    )
  },
})
