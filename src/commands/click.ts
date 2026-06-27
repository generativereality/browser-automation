import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate, withPage, forceForeground } from '../core/cdp.js'
import { clickExpr, actionabilityExpr } from '../core/dom.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const clickCommand = define({
  name: 'click',
  description: 'Click an element by ref (from the latest snapshot)',
  args: {
    ...targetArgs,
    ref: { type: 'positional', description: 'Element ref, e.g. e7' },
    trusted: {
      type: 'boolean',
      description:
        'Dispatch a real, genuinely-trusted CDP mouse click (Input.dispatchMouseEvent) at the element instead of the default JS-dispatched el.click(). Brings the tab to front and WAITS for it to be focused+visible (CDP input no-ops on a backgrounded tab), then waits for the element to be actionable (stable position + unoccluded hit-test) before pressing — mirroring Playwright. Use for widgets that demand isTrusted events AND animate in: artdeco dropdown menu items (LinkedIn More→Connect), Radix dropdown/popover triggers, cmdk comboboxes — which a default click, or an immediate trusted click on stale coordinates, only highlights without firing.',
    },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e7" is required (run `browser-automation snapshot` first)'); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const trusted = ctx.values.trusted ?? false

    if (trusted) {
      // Drive a real, genuinely-trusted mouse click through the CDP Input domain
      // — the only thing that activates widgets demanding `isTrusted` events that
      // a synthetic `el.click()` / dispatched pointer sequence won't (LinkedIn's
      // artdeco dropdown menu items being the canonical hard case). Two things
      // the old immediate dispatch got wrong, both reproduced + fixed here:
      //   1. Focus race — CDP input no-ops on a backgrounded tab, so after
      //      `Page.bringToFront` we WAIT until the tab actually reports focused +
      //      visible before pressing (the "sometimes no-op'd" flakiness).
      //   2. Actionability — coordinates resolved once, immediately, land on
      //      STALE positions while a menu/popover is still animating in (the item
      //      only highlights, never fires). We poll until the click-point is both
      //      hittable (unoccluded) and stable across two samples, then press at
      //      the settled point. This is Playwright's actionability model.
      const trustedTag = await withPage(targetId, async (s) => {
        const evalIn = async <T = unknown>(expr: string): Promise<T> => {
          const res = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
          if (res.exceptionDetails) {
            const e = res.exceptionDetails
            throw new Error('page JS exception: ' + (e.exception?.description || e.text || 'unknown'))
          }
          return res.result?.value as T
        }

        // Force focused+visible so CDP input lands even when the Chrome window
        // isn't the frontmost OS window (the usual case). See forceForeground.
        await forceForeground(s)
        // 1. Wait for the tab to actually be foreground (focused + visible).
        const focusDeadline = Date.now() + 2000
        while (Date.now() < focusDeadline) {
          const f = await evalIn<{ f: boolean; v: string }>(`({f:document.hasFocus(),v:document.visibilityState})`)
          if (f && f.f && f.v === 'visible') break
          await sleep(50)
        }

        // 2. Wait for the element to be actionable: stable position + unoccluded.
        let prev: { x: number; y: number } | null = null
        let point: { x: number; y: number; tag: string } | null = null
        let lastReason = 'never became actionable'
        const actDeadline = Date.now() + 5000
        while (Date.now() < actDeadline) {
          const a = await evalIn<{ err?: string; tag: string; x: number; y: number; hit: boolean }>(actionabilityExpr(ref))
          if (a?.err) { consola.error(a.err); process.exit(1) }
          const stable = prev !== null && Math.abs(prev.x - a.x) < 0.5 && Math.abs(prev.y - a.y) < 0.5
          if (a.hit && stable) { point = { x: a.x, y: a.y, tag: a.tag }; break }
          lastReason = a.hit ? 'position not yet stable (still animating)' : 'click-point occluded (hit-test miss)'
          prev = { x: a.x, y: a.y }
          await sleep(60)
        }
        if (!point) { consola.error(`<${ref}> not actionable for a trusted click: ${lastReason}`); process.exit(1) }

        const { x, y } = point
        // Full-fidelity sequence (matches Playwright's CR input): hover → settle
        // → press → release, with pointerType + force so pointer-event handlers
        // see a real mouse.
        await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' })
        await sleep(20) // let any hover side-effects (submenus/hovercards) settle
        await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse', force: 0.5 })
        await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
        return point.tag
      })
      consola.success(`clicked ${ref} <${trustedTag}> (trusted)`)
      return
    }

    const r = await evaluate<{ ok?: boolean; tag?: string; err?: string }>(targetId, clickExpr(ref))
    if (r.err) { consola.error(r.err); process.exit(1) }
    consola.success(`clicked ${ref} <${r.tag}>`)
  },
})
