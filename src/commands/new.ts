import { define } from 'gunshi'
import { consola } from 'consola'
import { defaultSessionName, saveSession, loadSession } from '../core/session.js'
import { normalizeUrl } from '../core/target.js'
import { createTab } from '../core/cdp.js'
import { ensureRenderer } from '../core/renderer-wake.js'
import { probeRenderer, explainRendererFailure, withRendererDiagnosis } from '../core/renderer-health.js'

export const newCommand = define({
  name: 'new',
  description: 'Open a fresh background tab for a session (does not steal focus). Optional positional: URL (default: about:blank)',
  args: {
    session: { type: 'string', short: 's', description: 'Session name (default: $BAC_SESSION or "default")' },
    force: { type: 'boolean', short: 'f', description: 'Open a new tab even if the session already has one' },
  },
  async run(ctx) {
    const name = ctx.values.session || defaultSessionName()
    // url is an optional positional (args-tokens requires declared positionals).
    const url = ctx.positionals[1] ? normalizeUrl(ctx.positionals[1]) : 'about:blank'

    const existing = loadSession(name)
    if (existing && !ctx.values.force) {
      consola.warn(`Session "${name}" already maps to a tab. Use --force to open another, or just \`browser-automation goto -s ${name} <url>\`.`)
    }
    // `Target.createTarget` can HANG on a browser that cannot launch renderers,
    // rather than fail — so this half needs the diagnosis too, or the operator
    // gets a bare 30s timeout for the one failure that really is permanent.
    const targetId = await withRendererDiagnosis(() => createTab(url))
    saveSession({ name, targetId, url, createdAt: new Date().toISOString() })

    // `Target.createTarget` is a browser-level call and succeeds even when the
    // renderer behind the new tab is not ready — it returns a target id for a
    // tab that will not run a line of JavaScript for another 12 seconds, or
    // ever. Reporting success here and letting the caller discover it two
    // commands later, as a `Page.enable` timeout they will read as the site's
    // fault, is the failure this check exists for.
    const r = await ensureRenderer(targetId)
    if (r.woke) {
      consola.warn(
        `[${name}] the new tab's renderer did not start on its own, so the tab was activated `
        + `briefly to force one. The Chrome window was raised and handed straight back.`,
      )
    }
    if (!r.ok) {
      const health = await probeRenderer().catch(() => null)
      if (health && !health.ok) {
        consola.error(`[${name}] tab ${targetId.slice(0, 12)}… was created but has no working renderer.\n\n${explainRendererFailure(health)}`)
        process.exit(1)
      }
      // The probe disagrees with this one tab: the browser can still make
      // renderers, so this is about this tab, not about Chrome.
      consola.warn(`[${name}] tab ${targetId.slice(0, 12)}… did not answer yet (${r.reason ?? r.outcome}). Chrome can still create renderers, so this is likely transient — retry the next command.`)
    }
    consola.success(`[${name}] opened background tab ${targetId.slice(0, 12)}… → ${url}`)
  },
})
