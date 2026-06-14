#!/usr/bin/env bash
# Install browser-automation — daemonless per-tab browser automation CLI
set -euo pipefail

echo "Installing browser-automation..."

if command -v npm &>/dev/null; then
    npm install -g @generativereality/browser-automation
elif command -v bun &>/dev/null; then
    bun install -g @generativereality/browser-automation
else
    echo "Error: npm or bun required" >&2
    exit 1
fi

echo ""
echo "✓ browser-automation installed"
echo ""
echo "Prerequisites:"
echo "  • Google Chrome installed"
echo "  • Node >= 22 (for the global WebSocket CDP client)"
echo ""
echo "Quick start:"
echo "  browser-automation launch                       # start the shared Chrome on :9223"
echo "  browser-automation doctor                       # verify"
echo "  browser-automation goto -s work https://example.com"
echo "  browser-automation snapshot -s work"
echo ""
echo "Claude Code skill:"
echo "  mkdir -p .claude/skills/browser"
echo "  curl -fsSL https://raw.githubusercontent.com/generativereality/browser-automation/main/skills/browser/SKILL.md \\"
echo "    -o .claude/skills/browser/SKILL.md"
