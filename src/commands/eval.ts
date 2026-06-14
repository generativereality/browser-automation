import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { evaluate } from '../core/cdp.js'

export const evalCommand = define({
  name: 'eval',
  description: 'Evaluate a JS expression in the tab and print the result (power-user escape hatch)',
  args: {
    ...targetArgs,
    expr: { type: 'positional', description: 'JS expression to evaluate' },
  },
  async run(ctx) {
    const expr = ctx.positionals[1]
    if (!expr) { consola.error('A JS expression is required'); process.exit(1) }
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const v = await evaluate(targetId, expr)
    process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n')
  },
})
