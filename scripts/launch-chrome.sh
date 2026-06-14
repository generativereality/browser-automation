#!/usr/bin/env bash
# Launch the canonical long-running headed Chrome that the browser-automation CLI drives via per-target CDP.
#
# Usage:
#   ./scripts/launch-chrome.sh          # launch if not already running
#   ./scripts/launch-chrome.sh --status # exit 0 if a CDP browser is listening on :9223, else 1
#
# Why this script exists:
#   The `browser-automation` skill prefers to drive a real, persistent Chrome
#   profile (so logins survive reboots) over a Playwright-managed one. The
#   convention is: one Chrome listening on --remote-debugging-port=9223 with
#   a dedicated user-data-dir. The browser-automation CLI then drives it over per-target CDP. This script is the single source of truth for how
#   to start that Chrome.
set -euo pipefail

PORT=9223
PROFILE="${BROWSER_AUTOMATION_PROFILE:-$HOME/Library/Application Support/Google/Chrome/browser-automation}"
LOG="${BROWSER_AUTOMATION_LOG:-/tmp/chrome-9223.log}"

is_up() {
  curl -fs -o /dev/null "http://localhost:${PORT}/json/version"
}

if [ "${1:-}" = "--status" ]; then
  if is_up; then
    echo "Chrome CDP on :${PORT} is up"
    exit 0
  fi
  echo "Chrome CDP on :${PORT} is NOT running"
  exit 1
fi

if is_up; then
  echo "Already running on :${PORT} — nothing to do."
  echo "Drive it with: browser-automation goto -s <session> <url>"
  exit 0
fi

# Resolve Chrome binary across macOS / Linux.
case "$(uname -s)" in
  Darwin)
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ;;
  Linux)
    CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)"
    ;;
  *)
    echo "Error: unsupported OS $(uname -s). Launch Chrome manually with --remote-debugging-port=${PORT} --user-data-dir=\"${PROFILE}\"." >&2
    exit 1
    ;;
esac

if [ ! -x "$CHROME" ]; then
  echo "Error: Chrome not found. Install it (or set CHROME=... if it lives elsewhere)." >&2
  exit 1
fi

mkdir -p "$(dirname "$PROFILE")"

nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  'about:blank' >"$LOG" 2>&1 &
disown

# Wait briefly for CDP to come up so the caller can attach immediately.
for _ in $(seq 1 20); do
  if is_up; then
    echo "Chrome launched on :${PORT} (profile: ${PROFILE}, log: ${LOG})"
    echo "Drive it with: browser-automation goto -s <session> <url>"
    exit 0
  fi
  sleep 0.25
done

echo "Error: Chrome did not start within 5s. Check ${LOG}." >&2
exit 1
