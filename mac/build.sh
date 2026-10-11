#!/bin/sh
# Builds dist/MacWake.app (universal) and dist/MacWake.dmg. Needs Xcode or Command Line Tools.
# CONSOLE_URL=https://your-console.vercel.app ./build.sh  bakes in the console address.
set -e
cd "$(dirname "$0")"
APP=dist/MacWake.app

# Google's WebRTC for live screen viewing, prebuilt by github.com/stasel/WebRTC. Pinned and checksum-verified.
WEBRTC=153.0.0
WEBRTC_SHA256=3e3a8946f27510133e3feed04d05fa23505bbe366e977620503bfc7986c2b78f
FW=vendor/WebRTC.xcframework/macos-x86_64_arm64
if [ ! -d "$FW/WebRTC.framework" ]; then
  mkdir -p vendor
  curl -fsSL -o vendor/webrtc.zip "https://github.com/stasel/WebRTC/releases/download/$WEBRTC/WebRTC-M${WEBRTC%%.*}.xcframework.zip"
  echo "$WEBRTC_SHA256  vendor/webrtc.zip" | shasum -a 256 -c - >/dev/null
  rm -rf vendor/WebRTC.xcframework && unzip -q vendor/webrtc.zip -d vendor && rm vendor/webrtc.zip
fi

rm -rf dist && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
for arch in arm64 x86_64; do
  # WebRTC is weak-linked: the root daemon runs a lone copy of this binary with no Frameworks folder beside it.
  swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" -F "$FW" \
    -Xfrontend -disable-autolink-framework -Xfrontend WebRTC -Xlinker -weak_framework -Xlinker WebRTC \
    -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
    -framework AppKit -framework IOKit -framework ScreenCaptureKit -framework ServiceManagement \
    Sources/*.swift -o "dist/MacWake-$arch"
done
lipo -create dist/MacWake-arm64 dist/MacWake-x86_64 -output "$APP/Contents/MacOS/MacWake" && rm dist/MacWake-*
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R "$FW/WebRTC.framework" "$APP/Contents/Frameworks/"
# Bake the console address in, so the app sets itself up with no typing:  CONSOLE_URL=https://you.vercel.app ./build.sh
if [ -n "$CONSOLE_URL" ]; then
  /usr/libexec/PlistBuddy -c "Add :MacWakeConsoleURL string ${CONSOLE_URL%/}" "$APP/Contents/Info.plist"
  echo "console URL baked in: ${CONSOLE_URL%/}"
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"
# A stable signature keeps the Screen Recording permission across rebuilds and updates; an ad-hoc one is tied to a
# single build. Self-signed identity in its own keychain: nothing goes into your login keychain, nothing is trusted.
# ponytail: fixed keychain password, it only guards this local signing key. Keep the folder: a new key means every
# Mac has to allow Screen Recording once more.
ID="MacWake Local Signing"
KC="$HOME/Library/Application Support/MacWake Build/signing.keychain-db"
if [ ! -f "$KC" ]; then
  D=$(mktemp -d)
  printf '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=%s\n[ext]\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nbasicConstraints=critical,CA:false\n' "$ID" > "$D/cert.cnf"
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$D/cert.cnf" -keyout "$D/key.pem" -out "$D/cert.pem" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -name "$ID" -out "$D/id.p12" -passout pass:macwake
  mkdir -p "$(dirname "$KC")"
  security create-keychain -p macwake "$KC"
  security import "$D/id.p12" -k "$KC" -P macwake -T /usr/bin/codesign >/dev/null
  rm -rf "$D"
  echo "created signing key: $KC"
fi
security unlock-keychain -p macwake "$KC"
security set-key-partition-list -S apple-tool:,apple: -s -k macwake "$KC" >/dev/null 2>&1 || true
codesign --force --keychain "$KC" -s "$ID" "$APP/Contents/Frameworks/WebRTC.framework"
codesign --force --keychain "$KC" -s "$ID" "$APP"
mkdir dist/dmg && cp -R "$APP" dist/dmg/ && ln -s /Applications dist/dmg/Applications
# diskutil image create is the non-deprecated tool on macOS 26+; older systems only have hdiutil.
diskutil image create from dist/dmg --volumeName MacWake --format UDZO dist/MacWake.dmg >/dev/null 2>&1 \
  || hdiutil create -volname MacWake -srcfolder dist/dmg -ov -format UDZO dist/MacWake.dmg >/dev/null
rm -rf dist/dmg
echo "built: $APP and dist/MacWake.dmg"
