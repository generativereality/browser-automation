import { define } from 'gunshi'
import { consola } from 'consola'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { isValidRef } from '../core/target.js'
import { captureDownload, clickTriggerExpr, urlTriggerExpr } from '../core/download.js'

const DEFAULT_DIR = join(homedir(), '.browser-automation', 'downloads')

export const downloadCommand = define({
  name: 'download',
  description: 'Capture a file download (e.g. a CSV export): trigger it with --click <ref> or --url, wait for completion',
  args: {
    ...targetArgs,
    click: { type: 'string', description: 'Ref of the element to click to start the download (e.g. e42)' },
    url: { type: 'string', description: 'Direct download URL to fetch (via an <a download> click in the page)' },
    dir: { type: 'string', short: 'd', description: `Directory to save into (default: ${DEFAULT_DIR})` },
    timeout: { type: 'number', description: 'Max ms to wait for completion (default 30000)' },
  },
  async run(ctx) {
    const click = ctx.values.click as string | undefined
    const url = ctx.values.url as string | undefined
    if (!click && !url) { consola.error('Provide --click <ref> or --url <url> to trigger the download'); process.exit(1) }
    if (click && !isValidRef(click)) { consola.error(`--click expects a ref like e42 (run snapshot first)`); process.exit(1) }

    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const dir = (ctx.values.dir as string | undefined) || DEFAULT_DIR
    const triggerExpr = click ? clickTriggerExpr(click) : urlTriggerExpr(url!)

    const r = await captureDownload(targetId, dir, triggerExpr, (ctx.values.timeout as number | undefined) ?? 30000)
    consola.success(`Downloaded ${r.filename} (${r.bytes} bytes)`)
    process.stdout.write(r.path + '\n')
  },
})
