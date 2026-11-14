#!/usr/bin/env bash
# Runs Swift Testing with Command Line Tools only (no Xcode): the Testing framework
# lives outside the default search paths, so point the compiler and linker at it.
#
# The scratch path is redirected out of the repo (which lives under ~/Downloads here):
# a build.db under Downloads intermittently throws "disk I/O error" (App Sandbox/Downloads
# access churn), which a scratch path elsewhere avoids. Override with COCO_SWIFT_SCRATCH.
set -euo pipefail
cd "$(dirname "$0")/.."
SCRATCH="${COCO_SWIFT_SCRATCH:-$HOME/Library/Caches/coco-swift-build}"
mkdir -p "$SCRATCH"
DEV="$(xcode-select -p)"
FLAGS=()
for dir in "$DEV/Library/Developer/Frameworks" "$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks"; do
  if [ -d "$dir" ]; then
    FLAGS+=(-Xswiftc -F -Xswiftc "$dir" -Xlinker -F -Xlinker "$dir" -Xlinker -rpath -Xlinker "$dir")
  fi
done
LIB="$DEV/Library/Developer/usr/lib"
if [ -d "$LIB" ]; then FLAGS+=(-Xlinker -rpath -Xlinker "$LIB"); fi
exec swift test --scratch-path "$SCRATCH" "${FLAGS[@]}" "$@"
