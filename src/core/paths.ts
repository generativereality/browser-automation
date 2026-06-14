import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// dist/index.js -> package root. Works for both `npm link` (symlinked into the
// repo) and a real global install (the `files` array ships `scripts/`).
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

export function launchScriptPath(): string {
  return join(packageRoot(), 'scripts', 'launch-chrome.sh')
}
