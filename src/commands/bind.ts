import { define } from 'gunshi'
import { consola } from 'consola'
import { defaultSessionName, saveSession } from '../core/session.js'
import { matchOne, resolveTargetIdArg } from '../core/resolve.js'
import { targetArgs } from '../core/args.js'
import { listPageTargets } from '../core/cdp.js'

export const bindCommand = define({
  name: 'bind',
  description: 'Adopt an already-open tab into a session name (pick it with -m <substr> or -t <id>)',
  args: { ...targetArgs },
  async run(ctx) {
    const name = ctx.values.session || defaultSessionName()
    const match = ctx.values.match as string | undefined
    const target = ctx.values.target as string | undefined
    if (!match && !target) {
      consola.error('Pick the tab to adopt with -m <url/title substr> or -t <targetId>. See `browser-automation list`.')
      process.exit(1)
    }

    let targetId: string
    let url: string | undefined
    if (target) {
      targetId = await resolveTargetIdArg(target)
      url = (await listPageTargets()).find((p) => p.id === targetId)?.url
    } else {
      const hit = await matchOne(match!, ctx.values.first as boolean | undefined)
      targetId = hit.id
      url = hit.url
    }

    saveSession({ name, targetId, url, createdAt: new Date().toISOString() })
    consola.success(`Bound session "${name}" → ${url ?? targetId}`)
  },
})
