import { define } from 'gunshi'
import { consola } from 'consola'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef, normalizeUrl } from '../core/target.js'
import { captureNetwork } from '../core/network.js'

export const networkCommand = define({
  name: 'network',
  description: 'Capture network requests in a tab (find the API behind a page, headers, bodies)',
  args: {
    ...targetArgs,
    filter: { type: 'string', description: 'Only show requests whose URL contains this substring' },
    duration: { type: 'number', description: 'Capture window in ms (default 6000)' },
    reload: { type: 'boolean', description: 'Reload the page to capture its requests' },
    click: { type: 'string', description: 'Click this ref to trigger, then capture' },
    nav: { type: 'string', description: 'Navigate to this URL to trigger, then capture' },
    all: { type: 'boolean', description: 'Include all resource types (default: XHR/Fetch/Document/WS only)' },
    body: { type: 'boolean', description: 'Fetch response bodies for the shown requests' },
    headers: { type: 'boolean', description: 'Show request + response headers for the shown requests' },
    json: { type: 'boolean', description: 'Output raw JSON' },
  },
  async run(ctx) {
    const click = ctx.values.click as string | undefined
    if (click && !isValidRef(click)) { consola.error('--click expects a ref like e42'); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const entries = await captureNetwork(targetId, {
      durationMs: (ctx.values.duration as number | undefined) ?? 6000,
      filter: ctx.values.filter as string | undefined,
      all: ctx.values.all as boolean | undefined,
      wantBody: (ctx.values.body as boolean | undefined) || undefined,
      reload: ctx.values.reload as boolean | undefined,
      clickRef: click,
      gotoUrl: ctx.values.nav ? normalizeUrl(ctx.values.nav as string) : undefined,
    })

    if (ctx.values.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + '\n')
      return
    }

    consola.log(`# ${entries.length} requests`)
    for (const e of entries) {
      consola.log(`${(e.method ?? '').padEnd(5)} ${String(e.status ?? '—').padEnd(4)} ${(e.type ?? '').padEnd(9)} ${e.url.slice(0, 100)}`)
      if (ctx.values.headers) {
        if (e.postData) consola.log(`      ↑ body: ${e.postData.slice(0, 200)}`)
        for (const [k, v] of Object.entries(e.requestHeaders ?? {})) {
          if (/^(authorization|cookie|x-|content-type)/i.test(k)) consola.log(`      ↑ ${k}: ${String(v).slice(0, 120)}`)
        }
      }
      if (ctx.values.body && e.body) consola.log(`      ↓ ${e.body.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  },
})
