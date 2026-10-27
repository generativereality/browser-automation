import { define } from 'gunshi'
import { runBroker } from '../core/broker.js'
import { socketPath } from '../core/cdp.js'

// Started by `launch`, detached; not for typing. It holds Chrome's DevTools pipe
// for as long as Chrome runs, and serves it on this user's socket (core/broker.ts).
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
      socket: socketPath(),
    })
  },
})
