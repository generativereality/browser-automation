import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { evaluateUntil } from '../core/cdp.js'
import { SNAPSHOT_EXPR, type SnapshotResult } from '../core/dom.js'

export const snapshotCommand = define({
  name: 'snapshot',
  description: 'List interactive elements with refs (e1, e2, …) for click/fill',
  args: {
    ...targetArgs,
    json: { type: 'boolean', description: 'Output raw JSON' },
  },
  async run(ctx) {
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    // Auto-wait: retry until at least one interactive element is present.
    const snap = await evaluateUntil<SnapshotResult>(
      targetId,
      SNAPSHOT_EXPR,
      (s) => !!s && s.count > 0,
    )

    if (ctx.values.json) {
      process.stdout.write(JSON.stringify(snap, null, 2) + '\n')
      return
    }
    consola.log(`# ${snap.title}\n# ${snap.url}\n# ${snap.count} interactive elements`)
    for (const el of snap.elements) {
      const label = el.type ? `${el.role}[${el.type}]` : el.role
      const st = el.state ? `[${el.state}] ` : ''
      consola.log(`${el.ref.padEnd(5)} ${label.padEnd(18)} ${st}${el.name}`)
    }
  },
})
