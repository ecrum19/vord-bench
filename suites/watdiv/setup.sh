#!/usr/bin/env bash
# Set up the watdiv suite of vord-bench: build the Comunica fork, fetch and split WatDiv, load the stores,
# start the endpoints, generate the engines and queries, and compute the ground truth.
# Steps whose output already exists are skipped, so the script can be re-run.
#
# Environment:
#   COMUNICA_DIR   checkout of the Comunica fork (default: ../comunica-vord)
#   COMUNICA_REPO  repository to clone it from (default: https://github.com/ecrum19/comunica.git)
#   COMUNICA_REF   branch to use (default: feature/vord-restrictions)
# Options:
#   --force-stores reload the Oxigraph stores
set -euo pipefail
# Paths are relative to the repository root.
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
COMUNICA_DIR=$(realpath -m "${COMUNICA_DIR:-$ROOT/../comunica-vord}")
COMUNICA_REPO=${COMUNICA_REPO:-https://github.com/ecrum19/comunica.git}
COMUNICA_REF=${COMUNICA_REF:-feature/vord-restrictions}
HOST_UID=$(id -u)
HOST_GID=$(id -g)
export COMUNICA_DIR HOST_UID HOST_GID
FORCE_STORES=""
[ "${1:-}" = "--force-stores" ] && FORCE_STORES="--force"

step() { printf '\n== %s\n' "$*"; }

step "Checking tools"
docker compose version
node -e 'const [major] = process.versions.node.split("."); if (major < 20) { console.error(`Node ${process.version} is too old; use Node 20 or later`); process.exit(1); } console.log(`Node ${process.version}`)'
YARN=(yarn)
command -v yarn > /dev/null || YARN=(npx --yes yarn@1.22.22)

step "Comunica fork: $COMUNICA_REPO $COMUNICA_REF -> $COMUNICA_DIR"
if [ ! -d "$COMUNICA_DIR/.git" ]; then
  git clone --branch "$COMUNICA_REF" "$COMUNICA_REPO" "$COMUNICA_DIR"
fi
git -C "$COMUNICA_DIR" fetch --quiet origin "$COMUNICA_REF"
git -C "$COMUNICA_DIR" checkout --quiet "$COMUNICA_REF"
git -C "$COMUNICA_DIR" merge --ff-only --quiet "origin/$COMUNICA_REF"
COMMIT=$(git -C "$COMUNICA_DIR" rev-parse HEAD)
if [ "$(cat "$COMUNICA_DIR/.vord-bench-built" 2>/dev/null)" != "$COMMIT" ]; then
  (cd "$COMUNICA_DIR" && "${YARN[@]}" install --frozen-lockfile)
  echo "$COMMIT" > "$COMUNICA_DIR/.vord-bench-built"
fi
echo "Built $(git -C "$COMUNICA_DIR" log --oneline -1)"

step "WatDiv data"
bash suites/watdiv/fetch-data.sh

step "Oxigraph stores"
COMPOSE=(docker compose -f suites/watdiv/docker-compose.yml)
if [ -n "$FORCE_STORES" ]; then
  "${COMPOSE[@]}" down
fi
bash suites/watdiv/load-stores.sh $FORCE_STORES

step "Endpoints"
mkdir -p results/proxy
"${COMPOSE[@]}" up -d
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3099/health > /dev/null 2>&1 && curl -fsS 'http://localhost:7878/query?query=ASK%7B%7D' > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS http://localhost:3099/health && echo

step "Engines"
node harness/generate-engines.mjs --suite watdiv

step "Queries"
node harness/generate-queries.mjs --suite watdiv

step "Ground truth"
node harness/ground-truth.mjs --suite watdiv

step "Done"
echo "Check the setup with: npm run bench:dry, then npm run bench:smoke"
