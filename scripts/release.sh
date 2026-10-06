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

# HTTP status of one version on the registry: 200 published, 404 not.
registry_code() { curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/${PKG/\//%2F}/$1"; }

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
  # A tag is never moved or re-pushed, and a version is never re-used: on
  # 2026-09-23 v0.4.15 was re-created on another commit after it had published,
  # so npm's 0.4.15 and the git tag still name different commits. Ask the remote
  # and the registry, not just this clone's tags.
  git rev-parse -q --verify "refs/tags/v$next" >/dev/null && die "v$next already exists"
  [ -z "$(git ls-remote origin "refs/tags/v$next")" ] || die "v$next already exists on origin"
  [ "$(registry_code "$next")" = 404 ] || die "$next is already on npm (or the registry did not answer 404) — pick another version"
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
  # GitHub's run LISTING lags the run: at 0.4.18 `gh run list --branch <tag>`
  # answered nothing for minutes while `gh run view <id>` said success — so
  # finish died "no release run" twice on a release that had shipped. Retry.
  # The run for the tag's CURRENT commit: a tag that was ever re-pushed has a
  # run per push (v0.4.15 had two), and the newest is not necessarily it.
  local sha; sha="$(git rev-parse "$tag^{commit}")"
  local run=""
  for _ in $(seq 1 18); do
    run="$(gh run list --repo "$REPO" --workflow release.yml --branch "$tag" --limit 10 --json databaseId,headSha --jq "[.[] | select(.headSha == \"$sha\")][0].databaseId // empty")"
    [ -n "$run" ] && break
    sleep 10
  done
  [ -n "$run" ] || die "no release run for $tag after 3 minutes"

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
  for _ in $(seq 1 60); do
    [ "$(registry_code "$v")" = 200 ] && break
    sleep 10
  done
  [ "$(registry_code "$v")" = 200 ] || die "$v not on the registry after 10 minutes"
  # And it is the tag's commit: npm records the commit it packed as gitHead.
  # This is how 0.4.15's mismatch was found, two weeks late.
  local head
  head="$(curl -s "https://registry.npmjs.org/${PKG/\//%2F}/$v" | node -pe 'JSON.parse(require("fs").readFileSync(0)).gitHead')"
  [ "$head" = "$sha" ] || die "npm's $v was packed from $head, but $tag is $sha — stop and tell the maintainer"
  echo "  $PKG@$v is live, packed from $tag ($(git rev-parse --short "$sha"))"

  say "Plugin marketplace"
  # Sync from the released tag, not from whatever this checkout has.
  RELEASE_WT="$(mktemp -d "${TMPDIR:-/tmp}/ba-finish.XXXXXX")"
  git worktree add -q --detach "$RELEASE_WT" "$tag"
  trap 'cd "$ROOT"; git worktree remove --force "$RELEASE_WT" >/dev/null 2>&1 || true' EXIT
  # This checkout's script (an old tag's copy lacks its fixes), the tag's files.
  BA_PLUGIN_SOURCE="$RELEASE_WT" bash "$ROOT/scripts/sync-plugin.sh"

  say "This machine"
  # --prefer-online: npm caches the package's metadata, so right after a
  # publish `npm install -g pkg@<new>` answers ETARGET "No matching version"
  # for a version the registry is already serving (0.4.17: the version
  # endpoint said 200, install said notarget). And say when it fails — this
  # line used to swallow that and print nothing.
  if npm install -g --prefer-online "$PKG@$v" >/dev/null 2>&1; then
    echo "  installed $(browser-automation --version)"
  else
    echo "  ⚠ could not install $PKG@$v globally — run: npm install -g --prefer-online $PKG@$v" >&2
  fi

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
