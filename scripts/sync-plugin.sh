#!/usr/bin/env bash
# Sync browser-automation plugin files to the generativereality/plugins marketplace repo.
#
# Usage:
#   ./scripts/sync-plugin.sh          # sync + commit + push
#   ./scripts/sync-plugin.sh --check  # just verify
#
# Expects the plugins repo at ../plugins (alongside this repo).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Where the payload is copied FROM. Defaults to this checkout; `release.sh
# finish` points it at the released tag, so what ships is what was tagged —
# while still running THIS copy of the script (an old tag's copy lacks fixes).
REPO_ROOT="${BA_PLUGIN_SOURCE:-$(dirname "$SCRIPT_DIR")}"
PLUGINS_DIR="${BA_PLUGINS_DIR:-$(dirname "$SCRIPT_DIR")/../plugins}"   # override for tests
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

if [ ! -d "$PLUGINS_DIR/.git" ]; then
  echo "Error: plugins repo not found at $PLUGINS_DIR"
  echo "Clone it:  git clone <plugins-repo-url> $(cd "$REPO_ROOT/.." && pwd)/plugins"
  exit 1
fi

ERRORS=0

# Files that ship inside the plugin payload. Relative to repo root.
PAYLOAD_FILES=(
  "skills/browser/SKILL.md"
  ".claude-plugin/plugin.json"
  "scripts/launch-chrome.sh"
)

for rel in "${PAYLOAD_FILES[@]}"; do
  if ! diff -q "$REPO_ROOT/$rel" "$PLUGINS_DIR/plugins/browser-automation/$rel" >/dev/null 2>&1; then
    echo "MISMATCH: $rel differs from plugins repo"
    ERRORS=1
  fi
done

if [ "$CHECK_ONLY" = true ]; then
  if [ "$ERRORS" -ne 0 ]; then
    echo ""
    echo "Run: ./scripts/sync-plugin.sh"
    exit 1
  fi
  echo "Plugins repo in sync"
  exit 0
fi

# Sync files
for rel in "${PAYLOAD_FILES[@]}"; do
  mkdir -p "$(dirname "$PLUGINS_DIR/plugins/browser-automation/$rel")"
  cp -p "$REPO_ROOT/$rel" "$PLUGINS_DIR/plugins/browser-automation/$rel"
done

# Remove .mcp.json from plugins repo if it lingers from an older sync (the plugin no longer ships an MCP server).
rm -f "$PLUGINS_DIR/plugins/browser-automation/.mcp.json"

cd "$PLUGINS_DIR"
if git diff --quiet -- plugins/browser-automation && [ -z "$(git ls-files --others --exclude-standard -- plugins/browser-automation)" ]; then
  echo "Plugins repo already up to date"
  exit 0
fi

# **Other plugins publish to this repo too.** The 0.4.14 sync was rejected
# because a cctabs sync had landed on origin/main in between — the marketplace
# is shared, so "behind origin" is the normal state, not an error. Commit ONLY
# our directory, then replay it on top of whatever arrived and push; our
# commit touches nothing outside plugins/browser-automation, so the rebase
# cannot conflict with another plugin's sync. It can conflict with a sync of
# THIS plugin from another checkout — then stop rather than guess.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "Error: plugins repo is on '$BRANCH', not main. Not syncing into a branch." >&2
  exit 1
fi
VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo '?')"
git add plugins/browser-automation
git commit -q -m "chore: sync browser-automation plugin to $VERSION"
for attempt in 1 2 3; do
  git fetch -q origin main
  if ! git rebase -q origin/main; then
    git rebase --abort
    echo "Error: rebasing the sync onto origin/main conflicted — something else changed" >&2
    echo "       plugins/browser-automation. Resolve in $PLUGINS_DIR, then push." >&2
    exit 1
  fi
  git push -q origin main && break
  [ "$attempt" = 3 ] && { echo "Error: push kept being rejected; see $PLUGINS_DIR." >&2; exit 1; }
done

echo "Synced browser-automation to plugins repo"
