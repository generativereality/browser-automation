import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate } from '../core/cdp.js'
import { fillExpr } from '../core/dom.js'

export const fillCommand = define({
  name: 'fill',
  description: 'Type a value into an input/textarea/contenteditable by ref',
  args: {
    ...targetArgs,
    submit: { type: 'boolean', description: 'Submit the form after filling (requestSubmit / Enter)' },
    ref: { type: 'positional', description: 'Element ref, e.g. e3' },
    value: { type: 'positional', description: 'Value to type' },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    const value = ctx.positionals[2]
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e3" is required (run `browser-automation snapshot` first)'); process.exit(1) }
    if (value === undefined) { consola.error('A value is required'); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const r = await evaluate<{ ok?: boolean; value?: string; err?: string }>(
      targetId,
      fillExpr(ref, value, ctx.values.submit ?? false),
    )
    if (r.err) { consola.error(r.err); process.exit(1) }
    consola.success(`filled ${ref} = "${r.value}"${ctx.values.submit ? ' + submitted' : ''}`)
  },
})
