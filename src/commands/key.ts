import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { evaluate } from '../core/cdp.js'
import { keyExpr } from '../core/dom.js'

export const keyCommand = define({
  name: 'key',
  description: 'Press one key on an element by ref: focus it, then dispatch keydown + keyup (Enter, Escape, ArrowDown, Space, a character…), without bringing the tab to the front',
  args: {
    ...targetArgs,
    ref: { type: 'positional', description: 'Element ref, e.g. e7' },
    key: { type: 'positional', description: 'An event.key name: Enter, Escape, Tab, ArrowDown, Space, or one character' },
  },
  async run(ctx) {
    const ref = ctx.positionals[1]
    const key = ctx.positionals[2]
    if (!ref || !isValidRef(ref)) { consola.error('A ref like "e7" is required (run `browser-automation snapshot` first)'); process.exit(1) }
    if (!key) { consola.error('A key is required, e.g. `browser-automation key e7 Enter`'); process.exit(1) }
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const r = await evaluate<{ ok?: boolean; tag?: string; err?: string }>(targetId, keyExpr(ref, key))
    if (r.err) { consola.error(r.err); process.exit(1) }
    consola.success(`pressed ${key} on ${ref} <${r.tag}>`)
  },
})
