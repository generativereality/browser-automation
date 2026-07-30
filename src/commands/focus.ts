import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { withPage, forceForeground, evaluate } from '../core/cdp.js'

export const focusCommand = define({
  name: 'focus',
  description:
    'Make a tab report visible+focused, so SPAs that defer work while hidden actually render. Does not steal OS focus',
  args: {
    ...targetArgs,
  },
  async run(ctx) {
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    await withPage(targetId, (s) => forceForeground(s))

    // Report the resulting state rather than just claiming success: the three
    // CDP calls are best-effort (older Chrome builds may not expose all of
    // them), so "did it actually work" is the only useful output here.
    const state = await evaluate<{ visibility: string; hidden: boolean; focus: boolean }>(
      targetId,
      '({visibility: document.visibilityState, hidden: document.hidden, focus: document.hasFocus()})',
    )
    if (state?.visibility === 'visible') {
      consola.success(
        `[${targetId.slice(0, 12)}…] visible=${state.visibility} focused=${state.focus}`,
      )
    } else {
      consola.warn(
        `[${targetId.slice(0, 12)}…] still visibility=${state?.visibility} hidden=${state?.hidden} — this Chrome may not support focus emulation`,
      )
    }
  },
})
