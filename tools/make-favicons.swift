// Rasterizes tools/tab-icon.svg into PNGs and packs a favicon.ico (PNG entries) for both Next.js apps.
// swift tools/make-favicons.swift <icon.svg> <favicon.ico> <apple-icon.png>
import AppKit

let args = CommandLine.arguments
guard let svg = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else { fatalError("can't read \(args[1])") }

func png(_ px: Int, bleed: Bool = false) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  if bleed { // no transparent corners: iOS applies its own mask
    NSColor(srgbRed: 0x1e / 255.0, green: 0x21 / 255.0, blue: 0x50 / 255.0, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: px, height: px).fill()
  }
  svg.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

// ICO: 6-byte header, 16-byte directory entry per image, then the PNG bytes.
let sizes = [16, 32, 48]
let images = sizes.map { png($0) }
var ico = Data([0, 0, 1, 0, UInt8(sizes.count), 0])
var offset = 6 + 16 * sizes.count
func le16(_ v: Int) -> [UInt8] { [UInt8(v & 255), UInt8(v >> 8 & 255)] }
func le32(_ v: Int) -> [UInt8] { le16(v & 0xffff) + le16(v >> 16) }
for (size, data) in zip(sizes, images) {
  ico.append(contentsOf: [UInt8(size), UInt8(size), 0, 0] + le16(1) + le16(32) + le32(data.count) + le32(offset))
  offset += data.count
}
images.forEach { ico.append($0) }
try! ico.write(to: URL(fileURLWithPath: args[2]))

// Apple touch icon: full-bleed, iOS rounds the corners itself.
try! png(180, bleed: true).write(to: URL(fileURLWithPath: args[3]))
