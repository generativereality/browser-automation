import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate } from '../core/cdp.js'
import { clickExpr } from '../core/dom.js'

export const clickCommand = define({
  name: 'click',
  description: 'Click an element by ref (from the latest snapshot)',
  args: {
    ...targetArgs,
    ref: { type: 'positional', description: 'Element ref, e.g. e7' },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e7" is required (run `browser-automation snapshot` first)'); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const r = await evaluate<{ ok?: boolean; tag?: string; err?: string }>(targetId, clickExpr(ref))
    if (r.err) { consola.error(r.err); process.exit(1) }
    consola.success(`clicked ${ref} <${r.tag}>`)
  },
})
