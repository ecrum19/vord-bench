#!/usr/bin/env bash
# Load the full dataset and each partition into its own Oxigraph store (data/stores/<name>).
# Existing stores are kept, unless --force is given (stop the endpoints first: docker compose down).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
IMAGE=ghcr.io/oxigraph/oxigraph:0.5.13
FORCE=${1:-}

for name in all users products offers reviews; do
  if [ "$name" = all ]; then source=watdiv/dataset.nt; else source=partitions/$name.nt; fi
  store=data/stores/$name
  if [ -d "$store" ] && [ "$FORCE" != "--force" ]; then
    echo "Store $name exists"
    continue
  fi
  rm -rf "$store"
  mkdir -p "$store"
  echo "Loading $source into $store"
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$ROOT/$store:/data" -v "$ROOT/data/generated:/in:ro" \
    "$IMAGE" load --location /data --file "/in/$source"
done
