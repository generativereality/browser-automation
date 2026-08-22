#!/usr/bin/env bash
# Launch the canonical long-running headed Chrome that the browser-automation CLI drives via per-target CDP.
#
# Usage:
#   ./scripts/launch-chrome.sh              # launch if not already running
#   ./scripts/launch-chrome.sh --status     # exit 0 if a CDP browser is listening, else 1
#   ./scripts/launch-chrome.sh --port 9224  # explicit port (the CLI always passes this)
#   ./scripts/launch-chrome.sh --restart    # quit a running Chrome first, then launch
#
# Why --restart exists:
#   A browser process can permanently lose the ability to launch renderers (see
#   src/core/renderer-health.ts for the mechanism). Every existing tab keeps
#   working, so the browser looks fine, but no new tab or cross-origin
#   navigation ever will again. Restarting is the ONLY recovery — and plain
#   `launch` cannot do it, because it is idempotent by design and correctly
#   reports "already running". Without an explicit flag the only way out was to
#   go and kill Chrome by hand, which is how a diagnosis ends up unactionable.
#
# Why this script exists:
#   The `browser-automation` skill prefers to drive a real, persistent Chrome
#   profile (so logins survive reboots) over a Playwright-managed one. The
#   convention is: one Chrome per user listening on --remote-debugging-port with
#   a dedicated user-data-dir. The browser-automation CLI then drives it over
#   per-target CDP. This script is the single source of truth for how to start
#   that Chrome.
#
# ONE CHROME PER USER, NOT PER MACHINE:
#   127.0.0.1 is machine-wide and CDP has no authentication, so a single
#   hardcoded port means the first macOS account to launch owns it and every
#   other account's automation silently drives that account's browser. The port
#   is therefore derived from the uid, by `cdpPort()` in src/core/cdp.ts — the
#   one place that decides it. This script is told, or asks.
set -euo pipefail

# --- port ------------------------------------------------------------------
# **Asked for, never recomputed.** `cdpPort()` in src/core/cdp.ts is the only
# place the port is decided; the CLI passes it here with --port, and a person
# running this script by hand gets the same number by asking the CLI that ships
# beside it. A second copy of the formula is a second answer waiting to happen.
ask_cli_for_port() {
  local dist="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/index.js"
  if [ -f "$dist" ] && command -v node >/dev/null 2>&1; then
    node "$dist" port 2>/dev/null && return 0
  fi
  command -v browser-automation >/dev/null 2>&1 && browser-automation port 2>/dev/null
}

PORT=""
RESTART=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --restart) RESTART=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"
PORT="${PORT:-$(ask_cli_for_port || true)}"
if [ -z "${PORT}" ]; then
  echo "Error: could not work out which port to use — pass --port, or set" >&2
  echo "       BROWSER_AUTOMATION_PORT. (This script asks the CLI beside it;" >&2
  echo "       see cdpPort() in src/core/cdp.ts, the only place it is decided.)" >&2
  exit 1
fi

PROFILE="${BROWSER_AUTOMATION_PROFILE:-$HOME/Library/Application Support/Google/Chrome/browser-automation}"
# Under the caller's OWN temp dir: /tmp is shared and sticky, so with a
# machine-global name the second user cannot write the first user's log.
LOG="${BROWSER_AUTOMATION_LOG:-${TMPDIR:-/tmp}/chrome-${PORT}.log}"

is_up() {
  curl -fs -o /dev/null "http://localhost:${PORT}/json/version"
}

# Is the browser answering on this port OURS?
#
# Note the question is "is it mine", not "whose is it". `lsof` tells a
# non-root user NOTHING about another user's socket — it prints an empty
# result and exits 0, which reads exactly like a free port. Measured
# 2026-08-08: as the second account, `lsof -iTCP:9223 -sTCP:LISTEN` returned
# nothing while the first account's Chrome was plainly listening. You can
# always see your OWN processes, so ask that instead.
port_is_ours() {
  pgrep -u "$(id -u)" -f -- "--remote-debugging-port=${PORT}" >/dev/null 2>&1
}

if [ "${1:-}" = "--status" ]; then
  if is_up; then
    echo "Chrome CDP on :${PORT} is up"
    exit 0
  fi
  echo "Chrome CDP on :${PORT} is NOT running"
  exit 1
fi

# Something is answering on our port and it is not ours. Refuse loudly rather
# than drive it: "already running" here used to mean "another macOS account's
# browser, and you will never be told".
if is_up && ! port_is_ours; then
  echo "Error: something else on this Mac is already serving CDP on port ${PORT}," >&2
  echo "       and it is not a Chrome this account started. Driving it would act in" >&2
  echo "       ANOTHER user's browser — quit Chrome in that account, or set" >&2
  echo "       BROWSER_AUTOMATION_PORT to a free port for this one." >&2
  exit 1
fi

# Restart: quit the Chrome we own, wait for the port to go quiet, fall through
# to the normal launch. Deliberately SIGTERM, not SIGKILL — Chrome flushes its
# profile (cookies, extension state, session) on a clean quit, and that profile
# is the whole reason this browser is long-lived. Only escalate if it will not
# go, and say so when it happens.
if [ "$RESTART" = "1" ] && is_up; then
  if ! port_is_ours; then
    echo "Error: refusing to restart a Chrome this account did not start." >&2
    exit 1
  fi
  TABS="$(curl -fs "http://localhost:${PORT}/json/list" 2>/dev/null | grep -c '"type": "page"' || true)"
  echo "Restarting Chrome on :${PORT} — closing ${TABS:-?} open tab(s)."
  pkill -u "$(id -u)" -f -- "--remote-debugging-port=${PORT}" 2>/dev/null || true
  for _ in $(seq 1 40); do
    is_up || break
    sleep 0.25
  done
  if is_up; then
    echo "Chrome did not quit on SIGTERM after 10s; sending SIGKILL." >&2
    pkill -9 -u "$(id -u)" -f -- "--remote-debugging-port=${PORT}" 2>/dev/null || true
    sleep 2
  fi
  # Chrome unregisters its bootstrap names and releases the port on the way out;
  # relaunching before that finishes produces a second browser that cannot serve
  # CDP. A short settle beats a confusing race.
  sleep 1
fi

if is_up; then
  echo "Already running on :${PORT} — nothing to do."
  echo "Drive it with: browser-automation goto -s <session> <url>"
  echo "(To force a fresh browser process — the only fix for a Chrome that can no"
  echo " longer launch renderers — use: browser-automation launch --restart)"
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

# Keep one generation of the previous log. Chrome's stdout is the only place
# the reason for a renderer failure is ever written, and truncating it on
# relaunch destroys the evidence at exactly the moment somebody restarted
# BECAUSE of that failure. (Done during this fix, to this author's own
# evidence.) One generation, not a rotation scheme: the interesting log is
# always the one from the browser that just misbehaved.
if [ -s "$LOG" ]; then
  mv -f "$LOG" "${LOG}.prev" 2>/dev/null || true
fi

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
