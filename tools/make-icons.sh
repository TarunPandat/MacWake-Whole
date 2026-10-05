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
"$T/mk" "$P/apple-touch-icon.png" 180 maskable
"$T/mk" console-next/app/icon.png 64
S="$T/AppIcon.iconset"; mkdir "$S"
for n in 16 32 128 256 512; do
  "$T/mk" "$S/icon_${n}x${n}.png" $n
  "$T/mk" "$S/icon_${n}x${n}@2x.png" $((n * 2))
done
iconutil -c icns "$S" -o mac/AppIcon.icns
rm -rf "$T"
echo "icons written"
