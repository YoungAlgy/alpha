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
lockfile_before="$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)"
git reset --hard origin/master --quiet
after="$(git rev-parse HEAD)"
lockfile_after="$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1)"

if [ "$before" != "$after" ]; then
  echo "    Updated $before -> $after"
else
  echo "    Already up to date at $after"
fi

# alpha-drift-r22-01 (found+fixed 2026-08-14): this script hard-resets the
# CODE to match origin/master but never touched node_modules -- fine on an
# ordinary code-only deploy, but a commit that bumps package-lock.json (a
# dependency update, exactly what round 22 did) left this WSL checkout's
# node_modules silently stale relative to the code it now had to build.
# First real occurrence: lib/stripe.ts's pinned apiVersion literal type
# came from the NEW stripe package version, but the OLD stripe package was
# still installed here -- typecheck:worker failed mid-deploy with a type
# error that had already passed clean on the Windows side, purely because
# this checkout's dependencies hadn't caught up. Only reinstalls when the
# lockfile actually changed (or node_modules doesn't exist yet at all) --
# same "only announce/act when something changed" discipline as the reset
# check above, so an ordinary deploy doesn't pay a ~30s npm ci tax for no
# reason.
if [ "$lockfile_before" != "$lockfile_after" ] || [ ! -d node_modules ]; then
  echo "==> package-lock.json changed -- syncing node_modules (npm ci)..."
  npm ci
fi

echo "==> Deploying (npm run cf:deploy)..."
npm run cf:deploy
