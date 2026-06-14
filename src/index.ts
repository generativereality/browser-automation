#!/usr/bin/env node
import { run } from './commands/index.js'

// Don't crash when our stdout is piped into something that exits early
// (e.g. `… | head`). Agents pipe constantly.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
