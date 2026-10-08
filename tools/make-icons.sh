#!/bin/sh
# Regenerates every icon: PWA PNGs in console-next/public and mac/AppIcon.icns.
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d)
swiftc -O tools/make-icons.swift -o "$T/mk"
P=console-next/public
mkdir -p "$P"
"$T/mk" "$P/icon-512.png" 512 maskable
"$T/mk" "$P/icon-192.png" 192 maskable
# Browser tabs (console + website): icon.svg, favicon.ico and apple-icon.png from tools/tab-icon.svg.
swiftc -O tools/make-favicons.swift -o "$T/fav"
for app in console-next website; do
  cp tools/tab-icon.svg "$app/app/icon.svg"
  "$T/fav" tools/tab-icon.svg "$app/app/favicon.ico" "$app/app/apple-icon.png"
done
# React Native app (mobile/): one 1024 icon, iOS rounds it; App Store icons must have no alpha channel.
"$T/mk" "$T/ios.png" 1024 maskable
sips -s format jpeg "$T/ios.png" --out "$T/ios.jpg" >/dev/null
sips -s format png "$T/ios.jpg" --out mobile/ios/MacWake/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png >/dev/null
R=mobile/android/app/src/main/res
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d=${pair%%:*}; n=${pair##*:}
  "$T/mk" "$R/mipmap-$d/ic_launcher.png" $n
  "$T/mk" "$R/mipmap-$d/ic_launcher_round.png" $n
done
S="$T/AppIcon.iconset"; mkdir "$S"
for n in 16 32 128 256 512; do
  "$T/mk" "$S/icon_${n}x${n}.png" $n
  "$T/mk" "$S/icon_${n}x${n}@2x.png" $((n * 2))
done
iconutil -c icns "$S" -o mac/AppIcon.icns
rm -rf "$T"
echo "icons written"
