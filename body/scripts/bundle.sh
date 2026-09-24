#!/usr/bin/env bash
# Builds CocoBody in release mode and wraps it in a signed .app so macOS privacy
# permissions attach to Coco itself (not to Terminal).
# Optional: COCO_SIGN_IDENTITY="Coco Dev" signs with a self-signed certificate so
# permissions survive rebuilds (ad-hoc signatures change every build).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BODY="$ROOT/body"
APP="$BODY/build/Coco.app"
NODE="${COCO_NODE:-$(command -v node || true)}"
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "node not found; install Node 26+ or set COCO_NODE" >&2; exit 1; }

(cd "$BODY" && swift build -c release)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BODY/.build/release/CocoBody" "$APP/Contents/MacOS/CocoBody"

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
echo "Built $APP"
