#!/usr/bin/env bash
# Fetch WatDiv (scale 10, from comunica-performance-assets) and split it into the endpoint partitions.
set -euo pipefail
# Paths are relative to the repository root.
cd "$(dirname "$0")/../.."
WATDIV=data/generated/watdiv
PARTITIONS=data/generated/partitions
URL=${WATDIV_URL:-https://github.com/comunica/comunica-performance-assets/raw/master/watdiv-10.zip}

if [ ! -f "$WATDIV/dataset.nt" ]; then
  mkdir -p "$WATDIV"
  TMP=$(mktemp -d)
  curl -fL --retry 3 -o "$TMP/watdiv.zip" "$URL"
  unzip -o -q "$TMP/watdiv.zip" dataset.nt 'queries/*' -d "$WATDIV"
  rm -rf "$TMP"
fi
echo "WatDiv: $(wc -l < "$WATDIV/dataset.nt") triples, $(ls "$WATDIV/queries" | wc -l) query templates"

if [ ! -f "$PARTITIONS/counts.json" ]; then
  node data/split.mjs "$WATDIV/dataset.nt" "$PARTITIONS"
fi
echo "Partitions: $(tr -d '\n ' < "$PARTITIONS/counts.json")"
