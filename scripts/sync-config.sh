#!/usr/bin/env bash
# Push repo config edits into the running app's config dir. Coco only *seeds* missing
# files into ~/Library/Application Support/Coco/config on launch (never overwriting what's
# there) — this script is the explicit "push my repo edits" action, and it does overwrite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${COCO_CONFIG_DIR:-$HOME/Library/Application Support/Coco/config}"
mkdir -p "$DEST"
for f in "$ROOT/config/"*; do
  name="$(basename "$f")"
  cp "$f" "$DEST/$name"
  echo "synced $name -> $DEST/$name"
done
