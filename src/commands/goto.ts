import { define } from 'gunshi'
import { consola } from 'consola'
import { loadSession, saveSession, defaultSessionName } from '../core/session.js'
import { normalizeUrl } from '../core/target.js'
import { resolveOrCreateTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { navigate } from '../core/cdp.js'
import { withRendererDiagnosis } from '../core/renderer-health.js'

export const gotoCommand = define({
  name: 'goto',
  description: 'Navigate a tab to a URL. Targets a session tab (created if needed), or an existing tab via -m/-t',
  args: {
    ...targetArgs,
    url: { type: 'positional', description: 'URL to navigate to' },
  },
  async run(ctx) {
    const url = ctx.positionals[1]
    if (!url) { consola.error('URL is required'); process.exit(1) }
    const target = normalizeUrl(url)
    const opts = targetOpts(ctx.values)

    // Both halves are wrapped: creating the session's tab is itself a renderer
    // launch, and it fails the same silent way a cross-origin navigation does.
    const { targetId, created } = await withRendererDiagnosis(() => resolveOrCreateTargetId(opts))
    await withRendererDiagnosis(() => navigate(targetId, target))

    // Persist the binding only in pure session mode (no explicit -m/-t).
    if (!opts.match && !opts.target) {
      const name = opts.session || defaultSessionName()
      const prev = loadSession(name)
      saveSession({ name, targetId, url: target, createdAt: prev?.createdAt ?? new Date().toISOString() })
      consola.success(`[${name}] ${created ? 'opened tab + ' : ''}navigated → ${target}`)
    } else {
      consola.success(`[${targetId.slice(0, 12)}…] navigated → ${target}`)
    }
  },
})
