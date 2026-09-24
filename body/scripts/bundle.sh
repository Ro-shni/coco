#!/usr/bin/env bash
# Builds CocoBody in release mode and wraps it in a signed .app so macOS privacy
# permissions attach to Coco itself (not to Terminal). The bundle is self-contained:
# it stages brain/dist + prod-only node_modules into Resources/brain and repo config/
# into Resources/config-defaults, so nothing Coco runs at runtime depends on a path in
# the source repo (which macOS can sandbox — e.g. no Downloads access for a stably
# signed app — causing EPERM when the brain lives under ~/Downloads).
# Optional: COCO_SIGN_IDENTITY="Coco Dev" signs with a self-signed certificate so
# permissions survive rebuilds (ad-hoc signatures change every build).
#
# The scratch path is redirected out of the repo (which lives under ~/Downloads here):
# a build.db under Downloads intermittently throws "disk I/O error" (App Sandbox/Downloads
# access churn), which a scratch path elsewhere avoids. Override with COCO_SWIFT_SCRATCH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BODY="$ROOT/body"
BRAIN="$ROOT/brain"
APP="$BODY/build/Coco.app"
SCRATCH="${COCO_SWIFT_SCRATCH:-$HOME/Library/Caches/coco-swift-build}"
NODE="${COCO_NODE:-$(command -v node || true)}"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; install Node 26+ or set COCO_NODE" >&2; exit 1; }

# Check if COCO_SIGN_IDENTITY is set and valid before building
if [ -n "${COCO_SIGN_IDENTITY:+x}" ] && [ -n "$COCO_SIGN_IDENTITY" ] && [ "$COCO_SIGN_IDENTITY" != "-" ]; then
  # Search for the identity without -v (so self-signed certs are accepted)
  if ! security find-identity -p codesigning | grep -q "\"$COCO_SIGN_IDENTITY\""; then
    {
      echo "Error: Code signing identity \"$COCO_SIGN_IDENTITY\" not found in Keychain."
      echo ""
      echo "To create a self-signed certificate:"
      echo "  1. Open Keychain Access"
      echo "  2. Go to Keychain Access → Certificate Assistant → Create a Certificate…"
      echo "  3. Name: \"Coco Dev\""
      echo "  4. Identity Type: \"Self Signed Root\""
      echo "  5. Certificate Type: \"Code Signing\""
      echo "  6. Click Create"
      echo ""
      echo "Or run without COCO_SIGN_IDENTITY for an ad-hoc build (permissions reset on every rebuild)."
    } >&2
    exit 1
  fi
fi

mkdir -p "$SCRATCH"
(cd "$BODY" && swift build -c release --scratch-path "$SCRATCH")
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SCRATCH/release/CocoBody" "$APP/Contents/MacOS/CocoBody"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>CocoBody</string>
  <key>CFBundleIdentifier</key><string>com.roshni.coco</string>
  <key>CFBundleName</key><string>Coco</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# Stage the brain: dist + package manifests, then install prod-only deps (ws, yaml, zod)
# into the staging dir so nothing pulled in for tests/build tooling ships in the app.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/coco-brain-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$BRAIN/dist" "$STAGE/dist"
cp "$BRAIN/package.json" "$STAGE/package.json"
cp "$BRAIN/package-lock.json" "$STAGE/package-lock.json"
if ! (cd "$STAGE" && npm ci --omit=dev --ignore-scripts); then
  echo "Note: npm ci failed (offline?) — falling back to a copy of brain/node_modules (may include dev deps)." >&2
  rm -rf "$STAGE/node_modules"
  cp -R "$BRAIN/node_modules" "$STAGE/node_modules"
fi
rm -rf "$APP/Contents/Resources/brain"
cp -R "$STAGE" "$APP/Contents/Resources/brain"

# Config defaults: seeded into the user's ~/Library/Application Support/Coco/config on first
# launch (CocoCore/ConfigSeeder.swift), never overwriting a file the user already has.
rm -rf "$APP/Contents/Resources/config-defaults"
cp -R "$ROOT/config" "$APP/Contents/Resources/config-defaults"

# brainDir/configDir are no longer written here: CocoPaths.load() derives them at runtime
# (Resources/brain, ~/Library/Application Support/Coco/config), with COCO_BRAIN_DIR /
# COCO_CONFIG_DIR env overrides for development. Only nodePath still comes from this plist.
cat > "$APP/Contents/Resources/CocoPaths.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>nodePath</key><string>$NODE</string>
</dict></plist>
PLIST

codesign --force --sign "${COCO_SIGN_IDENTITY:--}" --identifier com.roshni.coco "$APP"

if [ -n "${COCO_SIGN_IDENTITY:+x}" ] && [ -n "$COCO_SIGN_IDENTITY" ] && [ "$COCO_SIGN_IDENTITY" != "-" ]; then
  echo "Signed with: $COCO_SIGN_IDENTITY"
else
  echo "Signed with: ad-hoc"
  echo "Warning: macOS permissions will need re-granting after each rebuild. Use a persistent identity (COCO_SIGN_IDENTITY) to avoid this."
fi
echo "Built $APP"
