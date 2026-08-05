#!/usr/bin/env bash
set -euo pipefail

# Deploys MUST run from WSL, not native Windows -- node_modules here has
# platform-native binaries (workerd, etc.); the Windows-mounted /mnt/c copy
# fails outright ("installed workerd on another platform"). That's why a
# second, WSL-native checkout of this repo exists at all.
#
# This script exists because that split copy caused two real production
# near-misses on 2026-08-05: individual files were manually `cp`'d from
# Windows into the WSL copy before each deploy, and it was easy to forget
# one. The second time, a stale wrangler.jsonc got redeployed with the
# Cloudflare Cron Trigger still in it, silently re-arming a trigger that had
# just been deliberately removed (see wrangler.jsonc's own comment on that
# block, and alpha_full_app_review_2026-08-05.md in Claude's memory).
#
# Fix: never hand-copy files again. Always fetch + hard-reset this WSL
# checkout to exactly match origin/master -- the same commit GitHub Actions
# and everyone else treats as truth -- immediately before every deploy.
# Run this from WSL (~/alpha), not the /mnt/c path:
#
#   bash scripts/deploy-from-wsl.sh
#
# Commit and push from Windows first. This will NOT deploy uncommitted
# local changes -- that's deliberate, not a bug: this repo's convention is
# push-then-deploy, and hand-resetting to origin/master is exactly what
# closes the "config says X, deployed reality says Y" gap this script fixes.

cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  echo "error: $(pwd) is not a git repo. This script expects a real WSL-native clone" >&2
  echo "(not the /mnt/c mount). See this file's own header comment." >&2
  exit 1
fi

echo "==> Syncing WSL checkout to origin/master..."
git fetch origin master --quiet
before="$(git rev-parse HEAD)"
git reset --hard origin/master --quiet
after="$(git rev-parse HEAD)"

if [ "$before" != "$after" ]; then
  echo "    Updated $before -> $after"
else
  echo "    Already up to date at $after"
fi

echo "==> Deploying (npm run cf:deploy)..."
npm run cf:deploy
