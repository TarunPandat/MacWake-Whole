#!/bin/sh
# Builds dist/MacWake.app (universal) and dist/MacWake.dmg. Needs Xcode or Command Line Tools.
# CONSOLE_URL=https://your-console.vercel.app ./build.sh  bakes in the console address.
set -e
cd "$(dirname "$0")"
APP=dist/MacWake.app
rm -rf dist && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" -framework AppKit -framework IOKit Sources/main.swift -o "dist/MacWake-$arch"
done
lipo -create dist/MacWake-arm64 dist/MacWake-x86_64 -output "$APP/Contents/MacOS/MacWake" && rm dist/MacWake-*
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# Bake the console address in, so the app sets itself up with no typing:  CONSOLE_URL=https://you.vercel.app ./build.sh
if [ -n "$CONSOLE_URL" ]; then
  /usr/libexec/PlistBuddy -c "Add :MacWakeConsoleURL string ${CONSOLE_URL%/}" "$APP/Contents/Info.plist"
  echo "console URL baked in: ${CONSOLE_URL%/}"
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force -s - "$APP"
mkdir dist/dmg && cp -R "$APP" dist/dmg/ && ln -s /Applications dist/dmg/Applications
# diskutil image create is the non-deprecated tool on macOS 26+; older systems only have hdiutil.
diskutil image create from dist/dmg --volumeName MacWake --format UDZO dist/MacWake.dmg >/dev/null 2>&1 \
  || hdiutil create -volname MacWake -srcfolder dist/dmg -ov -format UDZO dist/MacWake.dmg >/dev/null
rm -rf dist/dmg
echo "built: $APP and dist/MacWake.dmg"
