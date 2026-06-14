import { define } from 'gunshi'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { evaluateUntil } from '../core/cdp.js'
import { readExpr } from '../core/dom.js'

export const readCommand = define({
  name: 'read',
  description: 'Print visible text of the page. Optional positional: a CSS selector (default: whole body)',
  args: {
    ...targetArgs,
  },
  async run(ctx) {
    // selector is an optional positional — args-tokens makes declared
    // positionals required, so we read it off ctx.positionals directly.
    const selector = ctx.positionals[1]
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    // Auto-wait: SPA content often renders after load. Retry until non-empty.
    const text = await evaluateUntil<string>(
      targetId,
      readExpr(selector),
      (t) => typeof t === 'string' && t.trim().length > 0,
    )
    process.stdout.write((text ?? '') + '\n')
  },
})
