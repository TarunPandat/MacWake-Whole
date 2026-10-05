// Renders the MacWake icon (night-indigo tile, closed lid edge, glowing sleep light).
// swift tools/make-icons.swift <out.png> <size> [maskable]
import AppKit

let args = CommandLine.arguments
let out = args[1], size = CGFloat(Double(args[2])!), maskable = args.count > 3
// Exact pixel bitmap (NSImage.lockFocus would render at the screen's 2x scale).
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
let rect = CGRect(x: 0, y: 0, width: size, height: size)

// Tile: full bleed for maskable / PWA, macOS-style rounded square otherwise.
let inset = maskable ? 0 : size * 0.09
let tile = rect.insetBy(dx: inset, dy: inset)
let path = maskable ? CGPath(rect: tile, transform: nil)
                    : CGPath(roundedRect: tile, cornerWidth: tile.width * 0.225, cornerHeight: tile.width * 0.225, transform: nil)
ctx.addPath(path); ctx.clip()
let grad = CGGradient(colorsSpace: nil, colors: [NSColor(srgbRed: 0.17, green: 0.18, blue: 0.40, alpha: 1).cgColor,
                                                 NSColor(srgbRed: 0.07, green: 0.08, blue: 0.19, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])

// Closed lid seen edge-on.
let s = tile.width
let lid = CGRect(x: tile.midX - s * 0.32, y: tile.minY + s * 0.40, width: s * 0.64, height: s * 0.075)
ctx.setFillColor(NSColor(srgbRed: 0.30, green: 0.32, blue: 0.58, alpha: 1).cgColor)
ctx.addPath(CGPath(roundedRect: lid, cornerWidth: lid.height / 2, cornerHeight: lid.height / 2, transform: nil)); ctx.fillPath()

// Sleep light with glow, centred under the lid.
let led = CGRect(x: tile.midX - s * 0.06, y: lid.minY - s * 0.075, width: s * 0.12, height: s * 0.035)
ctx.setShadow(offset: .zero, blur: s * 0.07, color: NSColor(srgbRed: 1, green: 0.95, blue: 0.85, alpha: 0.9).cgColor)
ctx.setFillColor(NSColor(srgbRed: 0.97, green: 0.95, blue: 0.91, alpha: 1).cgColor)
ctx.addPath(CGPath(roundedRect: led, cornerWidth: led.height / 2, cornerHeight: led.height / 2, transform: nil)); ctx.fillPath()

NSGraphicsContext.current?.flushGraphics()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
