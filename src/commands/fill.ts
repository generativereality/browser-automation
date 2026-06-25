import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate, withPage } from '../core/cdp.js'
import { fillExpr, focusAndSelectExpr, readValueAndTrackerExpr } from '../core/dom.js'

export const fillCommand = define({
  name: 'fill',
  description: 'Type a value into an input/textarea/contenteditable by ref',
  args: {
    ...targetArgs,
    submit: { type: 'boolean', description: 'Submit the form after filling (requestSubmit / Enter)' },
    native: { type: 'boolean', description: 'Use CDP Input.insertText for trusted keyboard events. Slower than the default JS-dispatched path, but reaches controlled React forms (RHF / Final Form / Formik Controller) that ignore synthetic input events.' },
    verify: { type: 'boolean', description: 'After filling, re-read the field and warn if its DOM value diverges from the value passed, or if React\'s internal _valueTracker still holds the old value (signals controlled-form state stickiness — the next submit will serialize stale data).' },
    ref: { type: 'positional', description: 'Element ref, e.g. e3' },
    value: { type: 'positional', description: 'Value to type' },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    const value = ctx.positionals[2]
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e3" is required (run `browser-automation snapshot` first)'); process.exit(1) }
    if (value === undefined) { consola.error('A value is required'); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const native = ctx.values.native ?? false
    const submit = ctx.values.submit ?? false

    if (native) {
      // Trusted-event path: JS focuses + select-alls the field, then we drive
      // character insertion through the CDP Input domain. Input.insertText
      // fires an `isTrusted: true` `beforeinput`/`input` sequence that
      // controlled React forms (RHF, Final Form, Formik Controller) DO
      // subscribe to — whereas a dispatched `new Event('input')` is ignored.
      const focus = await evaluate<{ ok?: boolean; err?: string; tag?: string }>(
        targetId,
        focusAndSelectExpr(ref),
      )
      if (focus.err) { consola.error(focus.err); process.exit(1) }

      await withPage(targetId, async (s) => {
        // The field was already select-all'd in JS by focusAndSelectExpr above
        // (inputs/textareas via .select(), contenteditable via the Selection
        // API), so insertText REPLACES the existing value.
        //
        // ⚠️ We deliberately do NOT send a synthetic Cmd/Ctrl+A select-all key
        // chord here. On macOS an unhandled Meta-modified `dispatchKeyEvent`
        // (e.g. when the focused ref isn't a text field that consumes Cmd+A)
        // is mirrored to the native key pipeline and offered to the main menu
        // bar, which intermittently pops system UI — observed launching macOS
        // "About This Mac" (System Information.app) during automated fills.
        // JS select-all + insertText avoids dispatching any modified key event.
        await s.send('Input.insertText', { text: value })

        if (submit) {
          // Enter to submit — no modifier, and no nativeVirtualKeyCode (a bogus
          // platform keycode is what gets mis-mirrored natively; key/code/
          // windowsVirtualKeyCode are enough for the page to see a real Enter).
          await s.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
          await s.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
        }
      })
    }
    else {
      // Default: JS-dispatched. Native value setter + input/change events.
      // Works for ~95 % of forms; the failure mode is controlled React forms
      // that read state from a separate source — that's what --native exists for.
      const r = await evaluate<{ ok?: boolean; value?: string; err?: string }>(
        targetId,
        fillExpr(ref, value, submit),
      )
      if (r.err) { consola.error(r.err); process.exit(1) }
    }

    if (ctx.values.verify) {
      const v = await evaluate<{ value?: string; trackerValue?: string | null; hasReactFiber?: boolean; err?: string }>(
        targetId,
        readValueAndTrackerExpr(ref),
      )
      if (v.err) {
        consola.warn(`verify failed to re-read field: ${v.err}`)
      }
      else {
        const domMatches = v.value === value
        const trackerKnown = v.trackerValue !== null && v.trackerValue !== undefined
        const trackerMatches = !trackerKnown || v.trackerValue === value
        if (!domMatches) {
          consola.warn(`verify: DOM value is "${v.value}" but you requested "${value}" — wrong element selected, or the page rewrote it.`)
        }
        else if (!trackerMatches) {
          consola.warn(`verify: DOM shows "${value}" but React's _valueTracker still holds "${v.trackerValue}". The form library will likely submit the stale value. Try --native, or capture the form's PUT endpoint and call it directly (see SKILL.md "Controlled-form state stickiness").`)
        }
        else if (v.hasReactFiber && !trackerKnown && !native) {
          // No tracker but a React fiber is attached — could be a controlled
          // input bound through a Controller wrapper (Final Form, Formik). We
          // can't prove staleness here, but it's worth a soft heads-up.
          consola.info(`verify: field has a React fiber but no _valueTracker — if the next submit serializes the old value, try --native.`)
        }
      }
    }

    consola.success(`filled ${ref} = "${value}"${native ? ' [native]' : ''}${submit ? ' + submitted' : ''}`)
  },
})
