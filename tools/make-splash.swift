// Renders the launch-screen mark (closed lid edge, glowing sleep light, "MacWake") for the iOS app.
// Geometry and colors match Splash in mobile/App.tsx, so the native launch screen hands off to it seamlessly.
// The app is dark only, so is its launch screen.
// swift tools/make-splash.swift <out.png> <scale> <Onest-SemiBold.ttf>
import AppKit
import CoreText

let args = CommandLine.arguments
let out = args[1], scale = CGFloat(Double(args[2])!)
CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: args[3]) as CFURL, .process, nil)

func rgb(_ hex: Int, _ a: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}
let lidColor = rgb(0x4d5294)
let ledColor = rgb(0xfff7e8)
let glow = rgb(0xfff7e8, 0.6)
let ink = NSColor(cgColor: rgb(0xe9e7f3))!

// Canvas in points (220 x 170), drawn at `scale`. Top-left coordinates below, flipped for CoreGraphics.
let W: CGFloat = 220, H: CGFloat = 170
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale), bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext
ctx.scaleBy(x: scale, y: scale)
func box(_ x: CGFloat, _ top: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: H - top - h, width: w, height: h) }
func pill(_ r: CGRect, _ c: CGColor) {
  ctx.setFillColor(c)
  ctx.addPath(CGPath(roundedRect: r, cornerWidth: r.height / 2, cornerHeight: r.height / 2, transform: nil))
  ctx.fillPath()
}

pill(box((W - 150) / 2, 34, 150, 16), lidColor)            // the closed lid, edge-on
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 20 * scale, color: glow) // the sleep light (shadow blur ignores the CTM)
pill(box((W - 46) / 2, 64, 46, 13), ledColor)
ctx.restoreGState()

// "MacWake" in a 48 pt line box at top 104, glyphs centred in the box the way React Native lays out text.
let font = NSFont(name: "Onest-SemiBold", size: 40)!
let word = NSAttributedString(string: "MacWake", attributes: [.font: font, .foregroundColor: ink, .kern: -1.8])
let baseline = 104 + (48 - (font.ascender - font.descender)) / 2 + font.ascender
word.draw(at: CGPoint(x: (W - word.size().width) / 2, y: H - baseline + font.descender))

NSGraphicsContext.current?.flushGraphics()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
