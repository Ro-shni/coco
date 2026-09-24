#!/usr/bin/env bash
# Build the brain and the body, then (re)launch Coco.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/brain" && npm run build)
"$ROOT/body/scripts/bundle.sh"
pkill -x CocoBody 2>/dev/null || true
open "$ROOT/body/build/Coco.app"
echo "Coco launched. Logs: ~/Library/Logs/Coco/{body,brain}.log"
