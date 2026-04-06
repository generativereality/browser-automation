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
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PLUGINS_DIR="$REPO_ROOT/../plugins"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

if [ ! -d "$PLUGINS_DIR/.git" ]; then
  echo "Error: plugins repo not found at $PLUGINS_DIR"
  echo "Clone it:  git clone <plugins-repo-url> $(cd "$REPO_ROOT/.." && pwd)/plugins"
  exit 1
fi

ERRORS=0

# Check skill file match
if ! diff -q "$REPO_ROOT/skills/browser/SKILL.md" "$PLUGINS_DIR/plugins/browser-automation/skills/browser/SKILL.md" >/dev/null 2>&1; then
  echo "MISMATCH: skills/browser/SKILL.md differs from plugins repo"
  ERRORS=1
fi

# Check plugin.json match
if ! diff -q "$REPO_ROOT/.claude-plugin/plugin.json" "$PLUGINS_DIR/plugins/browser-automation/.claude-plugin/plugin.json" >/dev/null 2>&1; then
  echo "MISMATCH: .claude-plugin/plugin.json differs from plugins repo"
  ERRORS=1
fi

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
mkdir -p "$PLUGINS_DIR/plugins/browser-automation/.claude-plugin" "$PLUGINS_DIR/plugins/browser-automation/skills/browser"
cp "$REPO_ROOT/.claude-plugin/plugin.json" "$PLUGINS_DIR/plugins/browser-automation/.claude-plugin/plugin.json"
cp "$REPO_ROOT/skills/browser/SKILL.md" "$PLUGINS_DIR/plugins/browser-automation/skills/browser/SKILL.md"

cd "$PLUGINS_DIR"
if git diff --quiet; then
  echo "Plugins repo already up to date"
  exit 0
fi

git add plugins/browser-automation
git commit -m "chore: sync browser-automation plugin"
git push

echo "Synced browser-automation to plugins repo"
