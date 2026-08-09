import { define } from 'gunshi'
import { cdpPort } from '../core/cdp.js'

export const portCommand = define({
  name: 'port',
  description: "Print the CDP port this user's Chrome uses (one number, for scripts)",
  args: {},
  async run() {
    // **Bare, on stdout, nothing else.** This exists so that nothing else has
    // to reimplement `cdpPort()`. It had been copied into the launch script and
    // into a downstream app within an hour of being written, each copy with a
    // comment promising to keep it in step — which is the tell, not the plan.
    process.stdout.write(`${cdpPort()}\n`)
  },
})
