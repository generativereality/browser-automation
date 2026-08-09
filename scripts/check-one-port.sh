#!/usr/bin/env bash
#
# One place decides the CDP port. This fails the build if a second one appears.
#
# The formula (base + uid offset) has now been copied out of `cdpPort()` twice:
# into the launch script within an hour of being written, and into a downstream
# app the same day. Both copies carried a comment promising to keep them in
# step, which is the tell rather than the plan — and the second time, the
# comment outlived the fix that removed the duplication and sat there inviting a
# third copy in good faith.
#
# A comment cannot enforce this. A grep can, and it costs nothing: there is no
# test runner in this package and this needs none.
#
# What is allowed to name the number:
#   - src/core/cdp.ts        the definition
#   - src/commands/doctor.ts a historical note about the bug, in a comment
# Everything else asks: `browser-automation port`, or `--port` from the CLI.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0

# The base port, anywhere it could be executed.
while IFS= read -r hit; do
  echo "✗ $hit" >&2
  fail=1
done < <(
  grep -rn --include='*.ts' --include='*.sh' -- '9223' src scripts 2>/dev/null \
    | grep -v '^src/core/cdp.ts:' \
    | grep -v '^src/commands/doctor.ts:.*\*' \
    | grep -v '^scripts/check-one-port.sh:' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|#)' || true
)

# Shell ARITHMETIC on the uid — the shape a re-derivation takes when somebody
# does not want to shell out to node.
#
# Deliberately narrow: `$(( … ))` or `expr`, not "a line mentioning id -u".
# The first version matched `pgrep -u "$(id -u)" -f -- "--remote-debugging-port=…"`
# — the ownership probe, which uses the port it was GIVEN — and a checker whose
# first run cries wolf is how the one real finding gets skimmed past.
while IFS= read -r hit; do
  echo "✗ $hit" >&2
  fail=1
done < <(
  grep -rnE --include='*.sh' '\$\(\([^)]*id -u|expr[^|]*id -u' scripts 2>/dev/null \
    | grep -v '^scripts/check-one-port.sh:' || true
)

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

The CDP port is decided in exactly one place: cdpPort() in src/core/cdp.ts.
Ask for it instead of recomputing it:

  TypeScript   import { cdpPort } from '../core/cdp.js'
  shell        browser-automation port
  a subprocess pass --port, as `launch` does

Why this is enforced rather than requested: 127.0.0.1 is machine-wide and the
DevTools protocol has no authentication, so two answers to "which port" means
one account silently driving another account's browser — which on a real task
is somebody's signed-in bank session. Found 2026-08-08; not a hypothetical.
MSG
  exit 1
fi

echo "✓ one place decides the port"
