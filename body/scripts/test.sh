#!/usr/bin/env bash
# Runs Swift Testing with Command Line Tools only (no Xcode): the Testing framework
# lives outside the default search paths, so point the compiler and linker at it.
set -euo pipefail
cd "$(dirname "$0")/.."
DEV="$(xcode-select -p)"
FLAGS=()
for dir in "$DEV/Library/Developer/Frameworks" "$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks"; do
  if [ -d "$dir" ]; then
    FLAGS+=(-Xswiftc -F -Xswiftc "$dir" -Xlinker -F -Xlinker "$dir" -Xlinker -rpath -Xlinker "$dir")
  fi
done
LIB="$DEV/Library/Developer/usr/lib"
if [ -d "$LIB" ]; then FLAGS+=(-Xlinker -rpath -Xlinker "$LIB"); fi
exec swift test "${FLAGS[@]}" "$@"
