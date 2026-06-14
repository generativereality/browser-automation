import { define } from 'gunshi'
import { consola } from 'consola'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolveExistingTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { captureScreenshot, listPageTargets } from '../core/cdp.js'

const DEFAULT_DIR = join(homedir(), '.browser-automation', 'screenshots')

export const screenshotCommand = define({
  name: 'screenshot',
  description: 'Save a PNG screenshot of a tab (--full for the whole page)',
  args: {
    ...targetArgs,
    out: { type: 'string', short: 'o', description: 'Output file path (default: ~/.browser-automation/screenshots/<ts>.png)' },
    full: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport' },
  },
  async run(ctx) {
    const targetId = await resolveExistingTargetId(targetOpts(ctx.values))
    const png = await captureScreenshot(targetId, { fullPage: ctx.values.full as boolean | undefined })

    let out = ctx.values.out as string | undefined
    if (!out) {
      mkdirSync(DEFAULT_DIR, { recursive: true })
      const t = (await listPageTargets()).find((p) => p.id === targetId)
      const slug = (t?.title || 'page').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page'
      out = join(DEFAULT_DIR, `${slug}.png`)
    }
    writeFileSync(out, png)
    consola.success(`Saved screenshot (${png.length} bytes)`)
    process.stdout.write(out + '\n')
  },
})
