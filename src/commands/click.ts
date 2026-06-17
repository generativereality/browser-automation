import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate, withPage } from '../core/cdp.js'
import { clickExpr, rectExpr } from '../core/dom.js'

export const clickCommand = define({
  name: 'click',
  description: 'Click an element by ref (from the latest snapshot)',
  args: {
    ...targetArgs,
    ref: { type: 'positional', description: 'Element ref, e.g. e7' },
    trusted: {
      type: 'boolean',
      description:
        'Dispatch a real CDP mouse click (Input.dispatchMouseEvent) at the element instead of the default JS-dispatched el.click(). Brings the tab to front so the events land. Use for widgets that demand isTrusted events — Radix dropdown/popover triggers, cmdk comboboxes — which the default click silently no-ops.',
    },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e7" is required (run `browser-automation snapshot` first)'); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const trusted = ctx.values.trusted ?? false

    if (trusted) {
      // Resolve the element's viewport-center, then drive a real mouse click
      // through the CDP Input domain. Input events go to the focused page, so
      // bring the tab to front first (a deliberate trusted click is worth the
      // focus change — the default path stays background-safe).
      const r = await evaluate<{ ok?: boolean; tag?: string; err?: string; x?: number; y?: number }>(
        targetId,
        rectExpr(ref),
      )
      if (r.err) { consola.error(r.err); process.exit(1) }
      const x = r.x as number
      const y = r.y as number
      await withPage(targetId, async (s) => {
        await s.send('Page.bringToFront').catch(() => {})
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await s.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
        })
        await s.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
        })
      })
      consola.success(`clicked ${ref} <${r.tag}> (trusted)`)
      return
    }

    const r = await evaluate<{ ok?: boolean; tag?: string; err?: string }>(targetId, clickExpr(ref))
    if (r.err) { consola.error(r.err); process.exit(1) }
    consola.success(`clicked ${ref} <${r.tag}>`)
  },
})
