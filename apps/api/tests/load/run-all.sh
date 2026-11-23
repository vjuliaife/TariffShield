#!/usr/bin/env bash
# Runs the full k6 benchmark suite (issue #265) against a running API
# instance and writes a JSON summary per script to tests/load/results/.
#
# Usage: API_BASE_URL=http://localhost:3002 ./run-all.sh
# (or just `npm run benchmark` from apps/api, which sets the default URL)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

export API_BASE_URL="${API_BASE_URL:-http://localhost:3002}"

SCRIPTS=(
  "get-importers.js"
  "get-importer-detail.js"
  "post-deposit.js"
  "post-withdraw.js"
  "post-auto-top-up.js"
  "post-erasure-request.js"
  "post-accept-tos.js"
)

overall_status=0

for script in "${SCRIPTS[@]}"; do
  name="${script%.js}"
  echo "=== running $script against $API_BASE_URL ==="
  if ! k6 run --summary-export "$RESULTS_DIR/$name.json" "$SCRIPT_DIR/$script"; then
    overall_status=1
    echo "!!! $script exceeded its thresholds (exit code non-zero) !!!"
  fi
done

echo ""
echo "Results written to $RESULTS_DIR/*.json"
exit $overall_status
