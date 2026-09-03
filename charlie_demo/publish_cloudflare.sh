#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 PERFORMANCE_ID"
  echo "Example: $0 bb0235e6345c"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERFORMANCE_ID="$1"
EXPORT_DIR="${CHARLIE_BAND_EXPORT_DIR:-$SCRIPT_DIR/public_export}"
CF_PAGES_PROJECT="${CHARLIE_BAND_CF_PROJECT:-charlie-band}"
PUBLIC_BASE_URL="${CHARLIE_BAND_PUBLIC_BASE_URL:-https://band.pos2.fun}"
export npm_config_cache="${npm_config_cache:-$SCRIPT_DIR/../.npm-cache}"

python3 "$SCRIPT_DIR/tools/export_performance.py" "$PERFORMANCE_ID" --export-dir "$EXPORT_DIR"

npx wrangler pages deploy "$EXPORT_DIR" \
  --project-name="$CF_PAGES_PROJECT" \
  --branch=main

echo
echo "Published: $PERFORMANCE_ID"
echo "Open: $PUBLIC_BASE_URL/performance.html?id=$PERFORMANCE_ID"
