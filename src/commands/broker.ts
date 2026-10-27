import { define } from 'gunshi'
import { runBroker, windowsPipeName } from '../core/broker.js'
import { brokerDir, socketPath } from '../core/cdp.js'

// Started by `launch`, detached; not for typing. It holds Chrome's DevTools pipe
// for as long as Chrome runs, and serves it on this user's socket (core/broker.ts).
// A login context's broker is the same command with `--context <name>`, which
// `launch` passes: brokerDir() and socketPath() then answer for that context.
export const brokerCommand = define({
  name: 'broker',
  description: "Internal: hold Chrome's DevTools pipe and serve it on this user's socket. `launch` starts it.",
  args: {
    chrome: { type: 'string', description: 'Chrome binary', required: true },
    profile: { type: 'string', description: '--user-data-dir', required: true },
    log: { type: 'string', description: "Chrome's stdout/stderr", required: true },
  },
  async run(ctx) {
    await runBroker({
      chrome: ctx.values.chrome!,
      profile: ctx.values.profile!,
      log: ctx.values.log!,
      dir: brokerDir(),
      socket: process.platform === 'win32' ? windowsPipeName() : socketPath(),
    })
  },
})
