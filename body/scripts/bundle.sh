#!/usr/bin/env bash
# Builds CocoBody in release mode and wraps it in a signed .app so macOS privacy
# permissions attach to Coco itself (not to Terminal).
# Optional: COCO_SIGN_IDENTITY="Coco Dev" signs with a self-signed certificate so
# permissions survive rebuilds (ad-hoc signatures change every build).
#
# The scratch path is redirected out of the repo (which lives under ~/Downloads here):
# a build.db under Downloads intermittently throws "disk I/O error" (App Sandbox/Downloads
# access churn), which a scratch path elsewhere avoids. Override with COCO_SWIFT_SCRATCH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BODY="$ROOT/body"
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

cat > "$APP/Contents/Resources/CocoPaths.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>brainDir</key><string>$ROOT/brain</string>
  <key>configDir</key><string>$ROOT/config</string>
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
