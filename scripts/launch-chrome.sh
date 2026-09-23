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
#   navigation ever will again. Restarting is the only recovery FROM THAT ONE
#   CONDITION — and plain `launch` cannot do it, because it is idempotent by
#   design and correctly reports "already running". Without an explicit flag the
#   only way out was to go and kill Chrome by hand, which is how a diagnosis
#   ends up unactionable.
#
#   It is a flag and not an automatic step because it closes every tab of every
#   session sharing this browser. That condition is confirmed by ONE thing: the
#   Mach bootstrap name being absent from `launchctl print gui/$UID`. A new tab
#   whose renderer is merely slow to answer looks identical and is not it — for
#   three weeks it was reported as it, and restarting for it twice destroyed
#   another session's unrecoverable work. `browser-automation doctor` now prints
#   which of the two it is; nothing here can tell them apart.
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
PROFILE=""
RESTART=0
STOP_ONLY=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --restart) RESTART=1; shift ;;
    # Quit our Chrome and stop there. `launch --restart` uses it so the profile
    # can be moved while nothing has it open, before the relaunch.
    --stop) RESTART=1; STOP_ONLY=1; shift ;;
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

# **Asked for, never hardcoded** — same reason as the port. `resolveProfile()`
# in src/core/profile.ts decides it (and knows about the move out of Chrome's
# own folder); the CLI passes it with --profile, and a person running this by
# hand gets the same answer from `browser-automation profile`.
ask_cli_for_profile() {
  local dist="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/index.js"
  if [ -f "$dist" ] && command -v node >/dev/null 2>&1; then
    node "$dist" profile 2>/dev/null && return 0
  fi
  command -v browser-automation >/dev/null 2>&1 && browser-automation profile 2>/dev/null
}
PROFILE="${PROFILE:-$(ask_cli_for_profile || true)}"
if [ -z "${PROFILE}" ]; then
  echo "Error: could not work out which profile to use — pass --profile, or set" >&2
  echo "       BROWSER_AUTOMATION_PROFILE." >&2
  exit 1
fi
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
if [ "$RESTART" = "1" ] && port_is_ours; then
  if ! port_is_ours; then
    echo "Error: refusing to restart a Chrome this account did not start." >&2
    exit 1
  fi
  if is_up; then
    TABS="$(curl -fs "http://localhost:${PORT}/json/list" 2>/dev/null | grep -c '"type": "page"' || true)"
    echo "Restarting Chrome on :${PORT} — closing ${TABS:-?} open tab(s)."
  fi
  pkill -u "$(id -u)" -f -- "--remote-debugging-port=${PORT}" 2>/dev/null || true
  # **Wait for Chrome to let go of the PROFILE, not for the port to close.**
  #
  # Chrome shuts its DevTools listener and helpers early in shutdown, so a
  # closed port says nothing. Waiting on it relaunched on top of a Chrome still
  # holding the profile: two browsers with one profile open, the corruption
  # Chrome's SingletonLock exists to prevent.
  #
  # Nor can we wait for the process to exit. Measured 2026-09-23 on macOS 27 /
  # Chrome 153: after SIGTERM or CDP Browser.close the browser process NEVER
  # exits — still asleep after a minute, every restart, however launched. It has
  # done the part that matters, though: SingletonLock is gone, i.e. the profile
  # is flushed and released, and what is left is a Mac app with no windows.
  # Ending that is harmless. Ending a Chrome that still holds the lock is not.
  profile_released() {
    # Only if we can actually SEE the profile. A host macOS has refused
    # Chrome's folder cannot, and "no lock visible" would then read as
    # "released" and kill a Chrome mid-flush.
    ls "$PROFILE" >/dev/null 2>&1 || return 1
    [ ! -L "$PROFILE/SingletonLock" ] && [ ! -e "$PROFILE/SingletonLock" ]
  }
  for _ in $(seq 1 40); do
    port_is_ours || break
    profile_released && break
    sleep 0.25
  done
  if port_is_ours; then
    if profile_released; then
      echo "Chrome released its profile but left its process running (normal on macOS); ending it."
    elif ! ls "$PROFILE" >/dev/null 2>&1; then
      # Not evidence of a hung Chrome — we simply cannot look. It has had 10s
      # since being asked to quit, which is ample for a release we cannot see.
      echo "Cannot see ${PROFILE} from this app (macOS keeps Chrome's folder from it), so cannot confirm it was released; ending Chrome after 10s." >&2
    else
      echo "Chrome still held its profile after 10s; sending SIGKILL." >&2
    fi
    pkill -9 -u "$(id -u)" -f -- "--remote-debugging-port=${PORT}" 2>/dev/null || true
    for _ in $(seq 1 20); do
      port_is_ours || break
      sleep 0.25
    done
  fi
  if port_is_ours; then
    echo "Error: Chrome on :${PORT} would not exit, even on SIGKILL. Not relaunching on top of it." >&2
    exit 1
  fi
  # Chrome unregisters its bootstrap names and releases the port on the way out;
  # relaunching before that finishes produces a second browser that cannot serve
  # CDP. A short settle beats a confusing race.
  sleep 1
fi

if [ "$STOP_ONLY" = "1" ]; then
  port_is_ours && { echo "Error: Chrome on :${PORT} is still running." >&2; exit 1; }
  exit 0
fi

# A held port is the ONLY thing this branch establishes. It is emphatically not
# a health check: a Chrome that can no longer give a new tab a renderer keeps
# serving this port, answering /json/version and listing targets, while every
# goto fails. Only a round-trip through a renderer tells the two apart, and
# that lives in the CLI (src/core/renderer-health.ts) -- `browser-automation
# launch` runs it right after this script returns and prints the real verdict.
#
# This used to print a standing "use --restart if renderers are broken" hint
# here. It was correct advice and it did not work: printed on every launch,
# directly under the words "nothing to do", it read as boilerplate rather than
# as a diagnosis, and an operator burned many minutes on 25-30s `goto`s in
# 2026-09 without it registering. Advice that is always on screen carries no
# information. The verdict now appears only when it is true.
if is_up; then
  echo "Already running on :${PORT} — the port is held."
  echo "Drive it with: browser-automation goto -s <session> <url>"
  echo "(Port held is not health. Check it works: browser-automation doctor)"
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

# On macOS, launch the .app through open(1), never by exec'ing the binary inside
# it. macOS protects an application's own data directory under
# ~/Library/Application Support, and the default profile lives under
# .../Google/Chrome. A process started from a terminal is refused there — for
# reads as well as writes — so a directly exec'd Chrome cannot even create its
# own SingletonLock and aborts with "Failed to create a ProcessSingleton for
# your profile directory". The message names the lock, so it reads as a stale
# lock from a crashed Chrome; it is not. Measured 2026-09-18 on Darwin 27.0.0
# with Chrome 153: the profile dir was mode 0700, owned by the user, carried no
# BSD flags and held no Singleton* files, while ~/Library/Application Support
# and .../Google both accepted writes from the same shell. LaunchServices gives
# Chrome its own identity, and the same binary, profile and flags then start.
#
# -n: a new instance even when the user's everyday Chrome is running.
# -g: do not bring it to the front. Chrome's stdout/stderr still reach $LOG via
# --stdout/--stderr (a healthy start writes "DevTools listening on ws://…").
app_bundle_of() {
  case "$1" in
    *.app/Contents/MacOS/*) printf '%s.app\n' "${1%%.app/Contents/MacOS/*}" ;;
    *) return 1 ;;
  esac
}

CHROME_FLAGS=(
  --remote-debugging-port="$PORT"
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  'about:blank'
)
if [ "$(uname -s)" = "Darwin" ] && APP="$(app_bundle_of "$CHROME")"; then
  open -n -g -a "$APP" --stdout "$LOG" --stderr "$LOG" --args "${CHROME_FLAGS[@]}"
else
  nohup "$CHROME" "${CHROME_FLAGS[@]}" >"$LOG" 2>&1 &
  disown
fi

# Wait for CDP so the caller can attach immediately. A cold start against a
# long-lived profile (extensions, logins, restored session) measured 10.6s and
# 16.4s through open(1), so a 5s window reported failure over a browser that
# was still coming up. The elapsed time is printed so a window that is too
# short again is visible rather than guessed at.
START="$(date +%s)"
for _ in $(seq 1 240); do
  if is_up; then
    echo "Chrome launched on :${PORT} in $(( $(date +%s) - START ))s (profile: ${PROFILE}, log: ${LOG})"
    echo "Drive it with: browser-automation goto -s <session> <url>"
    exit 0
  fi
  sleep 0.25
done

echo "Error: Chrome did not serve CDP on :${PORT} within 60s. Last lines of ${LOG}:" >&2
tail -n 8 "$LOG" 2>/dev/null | sed 's/^/  /' >&2
if grep -qE 'Failed to create a ProcessSingleton|SingletonLock: Operation not permitted' "$LOG" 2>/dev/null; then
  echo "" >&2
  echo "macOS refused this Chrome its own profile directory — not a stale lock." >&2
  echo "Chrome was exec'd directly rather than launched through open(1); see the" >&2
  echo "comment above app_bundle_of in this script." >&2
fi
exit 1
