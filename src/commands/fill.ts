import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate, withPage } from '../core/cdp.js'
import { fillExpr, focusAndSelectExpr, readValueAndTrackerExpr } from '../core/dom.js'

// Cross-platform select-all modifier: Meta on macOS, Control everywhere else.
// CDP Input.dispatchKeyEvent modifier bits: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift.
const SELECT_ALL_MOD = process.platform === 'darwin' ? 4 : 2

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
        // Belt-and-braces select-all over the field via the CDP key command,
        // in case `.select()` didn't apply (e.g. contenteditable). Modifier
        // is platform-aware so the key chord matches what the browser binds
        // selectAll to natively.
        await s.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          modifiers: SELECT_ALL_MOD,
          commands: ['selectAll'],
        })
        await s.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          modifiers: SELECT_ALL_MOD,
        })
        // insertText replaces the selected text with the new value.
        await s.send('Input.insertText', { text: value })

        if (submit) {
          await s.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          })
          await s.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
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
