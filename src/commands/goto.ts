import { define } from 'gunshi'
import { consola } from 'consola'
import { loadSession, saveSession, defaultSessionName } from '../core/session.js'
import { normalizeUrl } from '../core/target.js'
import { resolveOrCreateTargetId } from '../core/resolve.js'
import { targetArgs, targetOpts } from '../core/args.js'
import { navigate } from '../core/cdp.js'
import { ensureRenderer } from '../core/renderer-wake.js'
import { withRendererDiagnosis } from '../core/renderer-health.js'
import { wantsShow, showTab, describeNotShown } from '../core/show.js'

export const gotoCommand = define({
  name: 'goto',
  description: 'Navigate a tab to a URL. Targets a session tab (created if needed), or an existing tab via -m/-t',
  args: {
    ...targetArgs,
    url: { type: 'positional', description: 'URL to navigate to' },
    show: {
      type: 'boolean',
      description: 'Make this the SELECTED tab in its Chrome window, so someone watching Chrome sees it — only when the automation Chrome is already the frontmost app, so it never brings Chrome over another app. Default on with BAC_SHOW_TAB=1.',
    },
  },
  async run(ctx) {
    const url = ctx.positionals[1]
    if (!url) { consola.error('URL is required'); process.exit(1) }
    const target = normalizeUrl(url)
    const opts = targetOpts(ctx.values)

    // Both halves are wrapped: creating the session's tab is itself a renderer
    // launch, and it fails the same silent way a cross-origin navigation does.
    const { targetId, created } = await withRendererDiagnosis(() => resolveOrCreateTargetId(opts))
    // A tab we just created may not have a renderer yet — measured median 367ms
    // and a tail past 30s for a BACKGROUND target (core/renderer-wake.ts). The
    // navigation below would hit that as `Page.enable timed out`, which used to
    // be diagnosed as a permanently broken browser. Wait for it properly first;
    // an existing tab already has one and pays nothing.
    if (created) {
      const r = await ensureRenderer(targetId)
      if (r.woke) {
        consola.warn(
          `The new tab's renderer did not start on its own, so the tab was activated briefly `
          + `to force one. The Chrome window was raised and handed straight back.`,
        )
      }
    }
    const nav = await withRendererDiagnosis(() => navigate(targetId, target))
    // Say so when the load event never arrived. The navigation itself may be
    // perfectly fine — a page that never fires `load` is legal — but "we waited
    // and gave up" must not print the same line as "it loaded".
    if (!nav.loaded) {
      consola.warn(
        `No load event arrived, so the page may still be loading. The navigation `
        + `itself was accepted; this is a statement about what could not be confirmed.`,
      )
    }

    // After the navigation, so the tab someone sees is the page, not a blank
    // one about to change. See core/show.ts for why only when Chrome is in front.
    if (wantsShow(ctx.values.show)) {
      const note = describeNotShown(await showTab(targetId).catch(() => 'unsupported' as const))
      if (note) consola.info(note)
    }

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
