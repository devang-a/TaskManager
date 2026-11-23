#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_PATH="/Applications/NITC HQ Tasks.app"

echo "Building Rust release backend..."
cargo build --release --manifest-path "$PROJECT_DIR/backend-rs/Cargo.toml"

echo "Building native macOS shell..."
swiftc -O "$PROJECT_DIR/macos-app/main.swift" -framework Cocoa -framework WebKit -o "$PROJECT_DIR/macos-app/nitc-hq-app"

echo "Assembling $APP_PATH..."
rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"

cp "$PROJECT_DIR/macos-app/nitc-hq-app" "$APP_PATH/Contents/MacOS/NITC HQ Tasks"
cp "$PROJECT_DIR/backend-rs/target/release/nitc-hq-backend" "$APP_PATH/Contents/MacOS/nitc-hq-backend"
cp "$PROJECT_DIR/assets/nitc-hq-tasks.icns" "$APP_PATH/Contents/Resources/AppIcon.icns"

cat > "$APP_PATH/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>NITC HQ Tasks</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.nitc-hq-tasks.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>NITC HQ Tasks</string>
  <key>CFBundleDisplayName</key>
  <string>NITC HQ Tasks</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>NITC HQ Tasks connects to Apple Music to show now-playing artwork and relay playback controls during study sessions.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
echo "Installed $APP_PATH"
ls -lh "$APP_PATH/Contents/MacOS/"
