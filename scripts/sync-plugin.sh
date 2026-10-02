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
  "LICENSE"
)
# SKILL.md links to these for its long reference material; a payload without
# them leaves the skill pointing at files that are not there.
for f in "$REPO_ROOT"/skills/browser/references/*.md; do
  [ -e "$f" ] && PAYLOAD_FILES+=("skills/browser/references/$(basename "$f")")
done

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

# **Start from the latest marketplace, then copy on top.** Never commit first and
# rebase after: the payload is generated from a release, so the only thing a
# rebase can conflict with is an OLDER sync of this same plugin made from another
# checkout — which is exactly what happened at 0.4.16 (0.4.15 had been synced
# elsewhere). Copying onto an up-to-date tree has nothing to conflict with.
cd "$PLUGINS_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "Error: plugins repo is on '$BRANCH', not main. Not syncing into a branch." >&2; exit 1; }
# Other plugins sync from here too. Their uncommitted or unpushed work is not
# ours to carry, drop or rebase — stop and say so.
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: $PLUGINS_DIR has uncommitted changes; not syncing on top of someone's work:" >&2
  git status --short >&2; exit 1
fi
git fetch -q origin main
if [ -n "$(git rev-list origin/main..HEAD)" ]; then
  echo "Error: $PLUGINS_DIR has commits not on origin/main — push or drop them first:" >&2
  git log --oneline origin/main..HEAD >&2; exit 1
fi

SRC_VERSION="$(node -p "require('$REPO_ROOT/.claude-plugin/plugin.json').version")"
sync_on_top() {
  git merge -q --ff-only origin/main
  # Never replace a newer published plugin with an older one.
  local have
  have="$(node -p "try{require('./plugins/browser-automation/.claude-plugin/plugin.json').version}catch{''}" 2>/dev/null)"
  if [ -n "$have" ] && [ "$(printf '%s\n%s\n' "$have" "$SRC_VERSION" | sort -V | tail -1)" != "$SRC_VERSION" ]; then
    echo "Error: the marketplace already has browser-automation $have, newer than $SRC_VERSION. Not downgrading." >&2
    exit 1
  fi
  for rel in "${PAYLOAD_FILES[@]}"; do
    mkdir -p "$(dirname "plugins/browser-automation/$rel")"
    cp -p "$REPO_ROOT/$rel" "plugins/browser-automation/$rel"
  done
  # Remove .mcp.json if it lingers from an older sync (no MCP server any more).
  rm -f "plugins/browser-automation/.mcp.json"
}

sync_on_top
if git diff --quiet -- plugins/browser-automation && [ -z "$(git ls-files --others --exclude-standard -- plugins/browser-automation)" ]; then
  echo "Plugins repo already up to date"
  exit 0
fi
git add plugins/browser-automation
git commit -q -m "chore: sync browser-automation plugin to $SRC_VERSION"

# Someone may push between our fetch and our push. Then drop OUR commit (we
# verified above that nothing else was local), take theirs, and copy again.
for attempt in 1 2 3; do
  git push -q origin main && break
  [ "$attempt" = 3 ] && { echo "Error: push kept being rejected; see $PLUGINS_DIR." >&2; exit 1; }
  git fetch -q origin main
  git reset -q --hard origin/main
  sync_on_top
  git diff --quiet -- plugins/browser-automation && { echo "Plugins repo already up to date"; exit 0; }
  git add plugins/browser-automation
  git commit -q -m "chore: sync browser-automation plugin to $SRC_VERSION"
done

echo "Synced browser-automation $SRC_VERSION to plugins repo"
