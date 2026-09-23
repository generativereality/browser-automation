#!/usr/bin/env bash
# Cut a release. Two halves, with the human approval gate between them.
#
#   scripts/release.sh plan                 # what would ship since the last tag; changes nothing
#   scripts/release.sh cut <patch|minor|X.Y.Z> [--dry-run]
#                                           # bump, check, commit onto master, tag, push the tag
#   scripts/release.sh finish               # after the run is APPROVED: wait for npm, sync the
#                                           # plugin, update this machine's install
#
# Why a script: every release in September 2026 was improvised from CLAUDE.md
# prose, and each one hit something the prose did not say — local master
# checked out in another worktree, a plugin sync rejected because another plugin
# had synced first, `npm view` reporting the old version for minutes after a
# successful publish. The steps are mechanical; the JUDGEMENT (which version,
# whether to approve) is not, so the script does the first and refuses to do
# the second.
#
# It never approves the gated CI run. Approval belongs to the maintainer, and
# `gh api .../pending_deployments` CAN do it from here — which is exactly why
# a script must not: see CLAUDE.md, "Releasing".
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# What gets released. Only ever origin/master for real; overridable so a dry run
# can be tested against a branch that has something unreleased on it.
BASE="${BA_RELEASE_BASE:-origin/master}"
REPO=generativereality/browser-automation
PKG=@generativereality/browser-automation

die() { echo "Error: $*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

last_tag() { git -C "$ROOT" describe --tags --abbrev=0 "$BASE" 2>/dev/null || true; }

plan() {
  git fetch -q origin --tags
  local tag; tag="$(last_tag)"
  [ -n "$tag" ] || die "no release tag reachable from origin/master"
  say "Unreleased on $BASE since $tag"
  git log --format='  %h %s' "$tag..$BASE"
  [ -n "$(git log --format=%h "$tag..$BASE")" ] || { echo "  (nothing)"; return 0; }
  say "Files touched"
  git diff --stat "$tag..$BASE" | tail -n 25
  say "Decide the version (CLAUDE.md, Versioning policy)"
  cat <<'TXT'
  minor if ANY of these shipped, even inside a "fix":
    - where the CLI keeps or reads user data (profile, sessions, downloads), or a migration of it
    - a changed default, flag meaning, exit code, or output a script might parse
    - anything a user may need to act on after upgrading
  otherwise patch (fixes, and commands that complete the CLI).
  Name it to the maintainer with the reason, and get a yes, before `cut`.
TXT
}

cut() {
  local want="${1:-}" dry="${2:-}"
  [ -n "$want" ] || die "cut needs patch, minor or X.Y.Z — the version is a decision, not a default"
  git fetch -q origin --tags

  # Build the release from origin/master exactly, in a throwaway worktree:
  # this checkout is shared with other sessions and local master usually lives
  # in another worktree, so neither "the current branch" nor "master" is safe
  # to assume.
  # Global, not `local`: the EXIT trap runs after this function has returned.
  RELEASE_WT="$(mktemp -d "${TMPDIR:-/tmp}/ba-release.XXXXXX")"
  git worktree add -q --detach "$RELEASE_WT" "$BASE"
  trap 'cd "$ROOT"; git worktree remove --force "$RELEASE_WT" >/dev/null 2>&1 || true' EXIT
  cd "$RELEASE_WT"

  local cur; cur="$(node -p "require('./package.json').version")"
  local plug; plug="$(node -p "require('./.claude-plugin/plugin.json').version")"
  [ "$cur" = "$plug" ] || die "package.json ($cur) and plugin.json ($plug) disagree on origin/master"
  local next
  case "$want" in
    patch) next="$(node -p "v='$cur'.split('.').map(Number);v[2]++;v.join('.')")" ;;
    minor) next="$(node -p "v='$cur'.split('.').map(Number);v[1]++;v[2]=0;v.join('.')")" ;;
    [0-9]*.[0-9]*.[0-9]*) next="$want" ;;
    *) die "unknown version '$want'" ;;
  esac
  git rev-parse -q --verify "refs/tags/v$next" >/dev/null && die "v$next already exists"
  [ -z "$(git log --format=%h "$(last_tag)..HEAD")" ] && die "nothing unreleased since $(last_tag)"

  say "Releasing $cur -> $next"
  git log --format='  %h %s' "$(last_tag)..HEAD"

  node -e "
    const fs=require('fs');
    for (const f of ['package.json','.claude-plugin/plugin.json']) {
      const s=fs.readFileSync(f,'utf8'), t=s.replace(/(\"version\":\s*\")$cur(\")/, '\$1$next\$2');
      if (s===t) { console.error('no version to bump in '+f); process.exit(1) }
      fs.writeFileSync(f,t)
    }"
  npm install --package-lock-only --silent >/dev/null 2>&1 || true

  say "npm ci + npm run check"
  npm ci --silent >/dev/null
  local log; log="$(mktemp "${TMPDIR:-/tmp}/ba-check.XXXXXX")"
  npm run check >"$log" 2>&1 || {
    tail -n 30 "$log" >&2
    echo "" >&2
    echo "npm run check failed (full log: $log). If it is the renderer-health tests, a busy" >&2
    echo "Chrome on this user's port can fail them locally (CLAUDE.md, Dev gotchas) — compare" >&2
    echo "against master under the same conditions before believing it." >&2
    exit 1
  }

  git add package.json .claude-plugin/plugin.json package-lock.json
  git commit -q -m "release: v$next"
  git tag -a "v$next" -m "v$next"

  if [ "$dry" = "--dry-run" ]; then
    # Tags are shared by every worktree of this repo — leave none behind.
    git tag -d "v$next" >/dev/null
    say "Dry run: would push $(git rev-parse --short HEAD) to master and tag v$next. Nothing pushed, no tag kept."
    return 0
  fi
  [ "$BASE" = "origin/master" ] || die "BA_RELEASE_BASE is for --dry-run only"
  # Fast-forward only: if master moved while this ran, stop and re-plan rather
  # than release something nobody looked at.
  git push -q origin "HEAD:refs/heads/master" || die "master moved (push was not a fast-forward). Run plan again."
  git push -q origin "v$next"

  say "Tag v$next pushed. The release run is now WAITING FOR APPROVAL:"
  sleep 5
  gh run list --repo "$REPO" --workflow release.yml --limit 1 --json url,status --jq '.[0] | "  \(.url)  (\(.status))"' || true
  cat <<TXT

  Approving is the maintainer's call. Ask them to approve it there — or approve it
  yourself only if they told you to for THIS release. Then: scripts/release.sh finish
TXT
}

finish() {
  git fetch -q origin --tags
  local tag; tag="$(last_tag)"; local v="${tag#v}"
  local run; run="$(gh run list --repo "$REPO" --workflow release.yml --branch "$tag" --limit 1 --json databaseId --jq '.[0].databaseId')"
  [ -n "$run" ] || die "no release run for $tag"

  say "Waiting for the release run of $tag"
  local s
  for _ in $(seq 1 90); do
    s="$(gh run view "$run" --repo "$REPO" --json status,conclusion --jq '.status+" "+.conclusion')"
    case "$s" in
      "completed success") break ;;
      completed*) die "release run $run finished: $s — $(gh run view "$run" --repo "$REPO" --json url --jq .url)" ;;
      waiting*) echo "  still waiting for approval…" ;;
    esac
    sleep 10
  done
  [ "$s" = "completed success" ] || die "release run did not finish in 15 minutes"

  # The registry, not `npm view`: publishing reports success minutes before
  # the version is served (3.5 min for 0.4.13), and `npm view` also caches.
  say "Waiting for $v on the registry"
  local name="${PKG/\//%2F}"
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$name/$v")" = 200 ] && break
    sleep 10
  done
  [ "$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$name/$v")" = 200 ] || die "$v not on the registry after 10 minutes"
  echo "  $PKG@$v is live"

  say "Plugin marketplace"
  # Sync from the released tag, not from whatever this checkout has.
  RELEASE_WT="$(mktemp -d "${TMPDIR:-/tmp}/ba-finish.XXXXXX")"
  git worktree add -q --detach "$RELEASE_WT" "$tag"
  trap 'cd "$ROOT"; git worktree remove --force "$RELEASE_WT" >/dev/null 2>&1 || true' EXIT
  # This checkout's script (an old tag's copy lacks its fixes), the tag's files.
  BA_PLUGIN_SOURCE="$RELEASE_WT" bash "$ROOT/scripts/sync-plugin.sh"

  say "This machine"
  npm install -g "$PKG@$v" >/dev/null 2>&1 && echo "  installed $(browser-automation --version)"

  say "Downstream — not done by this script"
  cat <<TXT
  - rememberthis.ai vendors the skill: python3 scripts/sync-vendored-skills.py --update
    there, re-read its LOCAL block, commit that one file (other sessions work in that
    repo — do not sweep up their changes).
  - Tell the maintainer anything a user must act on (a moved profile, a changed default).
TXT
}

case "${1:-}" in
  plan) plan ;;
  cut) shift; cut "$@" ;;
  finish) finish ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
