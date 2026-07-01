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

if [[ -f "$SCRIPT_DIR/deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/deploy.env"
fi

: "${CHARLIE_BAND_VPS_TARGET:?Set CHARLIE_BAND_VPS_TARGET, for example user@example.com:/var/www/charlie-band/}"

python3 "$SCRIPT_DIR/tools/export_performance.py" "$PERFORMANCE_ID" --export-dir "$EXPORT_DIR"

rsync -avz --delete \
  --exclude '.DS_Store' \
  "$EXPORT_DIR"/ \
  "$CHARLIE_BAND_VPS_TARGET"

echo
echo "Published: $PERFORMANCE_ID"
echo "Open: ${CHARLIE_BAND_PUBLIC_BASE_URL:-https://your-domain.example}/performance.html?id=$PERFORMANCE_ID"
