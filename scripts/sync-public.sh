#!/usr/bin/env bash
set -euo pipefail

# Sync this private repo to the public repo, excluding private content.
#
# Replaces the retired .github/workflows/sync-public.yml. That workflow needed a
# long-lived PAT stored as a repo secret, which expired silently and left the two
# repos diverged for months. This script uses your local `gh` OAuth credentials
# instead, so there is no secret to store and nothing to expire.
#
# Usage:
#   ./scripts/sync-public.sh            # show what would change, then confirm
#   ./scripts/sync-public.sh --dry-run  # show what would change and stop
#
# Prerequisites:
#   - gh CLI authenticated with push access to the public repo (`gh auth status`)

PUBLIC_REPO="microbrewerGM/infinite-craft"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRIVATE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

command -v gh >/dev/null || { echo "ERROR: gh CLI not found"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated. Run: gh auth login"; exit 1; }

if [ -n "$(git -C "${PRIVATE_DIR}" status --porcelain)" ]; then
  echo "ERROR: private repo has uncommitted changes. Commit or stash first."
  git -C "${PRIVATE_DIR}" status --short
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "Cloning ${PUBLIC_REPO}..."
gh repo clone "${PUBLIC_REPO}" "${WORK_DIR}/public" -- --quiet

# ── Divergence guard ────────────────────────────────────────────────
# The rsync below uses --delete, so any commit that landed on the public repo
# but was never backported to private gets silently reverted. This is not
# hypothetical: PR #1 on the public repo (worker BFS fix, 2026-07-18) was staged
# for exactly that erasure before it was caught.
#
# Content comparison is useless as an alarm here — private is legitimately ahead
# on almost every sync, so it would fire every time and get click-throughed. The
# two repos also have unrelated histories (this script rewrites commits), so
# `git log A..B` says nothing either. Instead the last successful sync leaves a
# `last-sync` tag on the public repo; anything committed after it is public-only
# work that this sync would destroy.
echo "Checking for public-only commits..."
if git -C "${WORK_DIR}/public" rev-parse -q --verify refs/tags/last-sync >/dev/null 2>&1; then
  AHEAD="$(git -C "${WORK_DIR}/public" rev-list --count last-sync..HEAD)"
  if [ "${AHEAD}" -gt 0 ]; then
    echo ""
    echo "WARNING: the public repo has ${AHEAD} commit(s) since the last sync:"
    git -C "${WORK_DIR}/public" log --oneline last-sync..HEAD
    echo ""
    echo "Pushing will DESTROY this work. Backport it first:"
    echo "  git -C ${PRIVATE_DIR} fetch public main"
    echo "  git -C ${PRIVATE_DIR} cherry-pick -x <sha>"
    echo ""
    read -r -p "Continue anyway and discard the above? [y/N] " reply
    [ "${reply}" = "y" ] || { echo "Aborted."; exit 1; }
  else
    echo "  none — public is unchanged since last sync."
  fi
else
  echo ""
  echo "NOTE: no 'last-sync' tag on the public repo (first run of this script)."
  echo "Confirm nothing landed there that isn't in private:"
  echo "  https://github.com/${PUBLIC_REPO}/commits/main"
  echo ""
  read -r -p "Continue? [y/N] " reply
  [ "${reply}" = "y" ] || { echo "Aborted."; exit 1; }
fi

# Build the exclude list from .gitignore.public, same as the retired workflow.
EXCLUDES="${WORK_DIR}/excludes.txt"
grep -v '^\s*#' "${PRIVATE_DIR}/.gitignore.public" | grep -v '^\s*$' > "${EXCLUDES}"
printf '%s\n' ".gitignore.public" ".github/" ".env" ".claude/" "CLAUDE.md" >> "${EXCLUDES}"

rsync -a --delete --exclude-from="${EXCLUDES}" --exclude='.git/' \
  "${PRIVATE_DIR}/" "${WORK_DIR}/public/"
cp "${PRIVATE_DIR}/.gitignore.public" "${WORK_DIR}/public/.gitignore"

cd "${WORK_DIR}/public"

# Commit as the GitHub noreply identity, not the local git config. These are
# synthetic mirror commits, and pushing the real address would publish it —
# GitHub's email privacy protection rejects the push outright when it would.
# Derived rather than hardcoded so this works for whoever runs it.
NOREPLY="$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
git config user.name "$(gh api user --jq '.login')"
git config user.email "${NOREPLY}"

git add -A

if git diff --cached --quiet; then
  echo "No changes to sync."
  exit 0
fi

echo ""
echo "Changes to publish:"
git diff --cached --stat

if [ "${DRY_RUN}" = "1" ]; then
  echo ""
  echo "(--dry-run: stopping without pushing)"
  exit 0
fi

echo ""
read -r -p "Push these to ${PUBLIC_REPO}? [y/N] " reply
[ "${reply}" = "y" ] || { echo "Aborted."; exit 1; }

# Subject line only (%s, not %B). Commit bodies are a leak channel the file
# exclusions do not cover: they carry internal ticket IDs, session URLs, and
# review notes straight into public history. The retired workflow copied the
# full message and did exactly that — commit 9cde03c on the public repo still
# has a `Claude-Session:` URL in its body.
COMMIT_MSG="$(git -C "${PRIVATE_DIR}" log -1 --pretty=%s)"
git commit -q -m "${COMMIT_MSG}"
git push -q origin main

# Move the marker the divergence guard reads on the next run. Anything committed
# to the public repo after this point is work that did not come from here.
git tag -f last-sync >/dev/null
git push -q --force origin refs/tags/last-sync

echo "Synced to https://github.com/${PUBLIC_REPO}"
