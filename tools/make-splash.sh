#!/bin/sh
# Regenerates the iOS launch screen assets: SplashMark (@1x-@3x) and SplashBackground. Dark only, like the app.
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d)
swiftc -O tools/make-splash.swift -o "$T/mk"
A=mobile/ios/MacWake/Images.xcassets
M="$A/SplashMark.imageset"
rm -f "$M"/mark-*.png
mkdir -p "$M" "$A/SplashBackground.colorset"
for s in 1 2 3; do "$T/mk" "$M/mark@${s}x.png" $s mobile/assets/fonts/Onest-SemiBold.ttf; done

cat > "$M/Contents.json" <<'EOF'
{
  "images" : [
    { "idiom" : "universal", "scale" : "1x", "filename" : "mark@1x.png" },
    { "idiom" : "universal", "scale" : "2x", "filename" : "mark@2x.png" },
    { "idiom" : "universal", "scale" : "3x", "filename" : "mark@3x.png" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
EOF

# The app's background token: night indigo.
cat > "$A/SplashBackground.colorset/Contents.json" <<'EOF'
{
  "colors" : [
    { "idiom" : "universal", "color" : { "color-space" : "srgb", "components" : { "red" : "0x12", "green" : "0x14", "blue" : "0x2B", "alpha" : "1.000" } } }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
EOF
rm -rf "$T"
echo "splash written"
