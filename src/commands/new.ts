import { define } from 'gunshi'
import { consola } from 'consola'
import { defaultSessionName, saveSession, loadSession } from '../core/session.js'
import { normalizeUrl } from '../core/target.js'
import { createTab } from '../core/cdp.js'

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
    const targetId = await createTab(url)
    saveSession({ name, targetId, url, createdAt: new Date().toISOString() })
    consola.success(`[${name}] opened background tab ${targetId.slice(0, 12)}… → ${url}`)
  },
})
