// Remote control: turns a viewer's data-channel messages into mouse and keyboard events on the captured display.
// Menu-bar app only (the root daemon has no user session). The viewer decides gestures; this file only injects.
// Wire format: docs/superpowers/specs/2026-10-11-remote-control-design.md.
import AppKit
import ApplicationServices

/// Asks macOS for Accessibility, which posting input events needs. Shows the system prompt only while it's missing.
func askAccessibility() {
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
}

/// Posts one viewer's input on one display. Main queue only. `releaseAll()` leaves nothing held.
final class Injector {
    let display: CGDirectDisplayID
    private let source = CGEventSource(stateID: .hidSystemState)
    private var pos: CGPoint
    private var buttons: Set<Int> = []        // held: 0 left, 1 right
    private var keys: Set<String> = []        // held, by wire name
    private var flags: CGEventFlags = []      // from held modifier keys
    private var click = (button: -1, at: Date.distantPast, pos: CGPoint.zero, count: 0)
    private var scrollRest = (x: 0.0, y: 0.0)

    init(display: CGDirectDisplayID) {
        self.display = display
        pos = CGEvent(source: nil)?.location ?? .zero
    }

    /// The display in global points (top-left origin), read fresh so a resolution change mid-session still maps.
    var bounds: CGRect { CGDisplayBounds(display) }

    /// One parsed message. Anything malformed or unknown does nothing.
    func handle(_ msg: [String: Any]) {
        let b = bounds
        if let p = pair(msg["m"]) {
            moveTo(CGPoint(x: b.minX + min(max(p.x, 0), 1) * b.width, y: b.minY + min(max(p.y, 0), 1) * b.height))
        } else if let d = pair(msg["r"]) {
            moveTo(CGPoint(x: pos.x + d.x * b.width, y: pos.y + d.y * b.height))
        } else if let n = msg["b"] as? Int, n == 0 || n == 1, let d = msg["d"] as? Int {
            button(n, down: d == 1)
        } else if let s = pair(msg["s"]) {
            scroll(s.x, s.y)
        } else if let code = msg["k"] as? String, let d = msg["d"] as? Int {
            key(code, down: d == 1)
        } else if let t = msg["t"] as? String {
            type(t)
        }
    }

    /// Lets go of every button and key this viewer holds (connection lost, control off, session over).
    func releaseAll() {
        for n in buttons.sorted() { button(n, down: false) }
        for code in keys { key(code, down: false) }
        flags = []
    }

    private func moveTo(_ p: CGPoint) {
        let b = bounds
        pos = CGPoint(x: min(max(p.x, b.minX), b.maxX - 1), y: min(max(p.y, b.minY), b.maxY - 1))
        let type: CGEventType = buttons.contains(0) ? .leftMouseDragged : buttons.contains(1) ? .rightMouseDragged : .mouseMoved
        post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: pos, mouseButton: type == .rightMouseDragged ? .right : .left))
    }

    /// Down/up at the pointer. A down soon after the last one, nearby, counts up so taps make double and triple clicks.
    private func button(_ n: Int, down: Bool) {
        guard down != buttons.contains(n) else { return }   // no double downs, no stray ups
        if down {
            let now = Date()
            let again = click.button == n && now.timeIntervalSince(click.at) <= NSEvent.doubleClickInterval
                && hypot(pos.x - click.pos.x, pos.y - click.pos.y) <= 4
            click = (n, now, pos, again ? click.count + 1 : 1)
            buttons.insert(n)
        } else {
            buttons.remove(n)
        }
        let type: CGEventType = n == 0 ? (down ? .leftMouseDown : .leftMouseUp) : (down ? .rightMouseDown : .rightMouseUp)
        let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: pos, mouseButton: n == 0 ? .left : .right)
        e?.setIntegerValueField(.mouseEventClickState, value: Int64(click.count))
        post(e)
    }

    /// Pixel scrolling. Wire: +dy scrolls down; CoreGraphics: +wheel scrolls up. Sub-point remainders carry over.
    private func scroll(_ dx: Double, _ dy: Double) {
        scrollRest.x -= dx; scrollRest.y -= dy
        let x = scrollRest.x.rounded(.towardZero), y = scrollRest.y.rounded(.towardZero)
        scrollRest.x -= x; scrollRest.y -= y
        guard x != 0 || y != 0 else { return }
        post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(clamping: Int(y)), wheel2: Int32(clamping: Int(x)), wheel3: 0))
    }

    private func key(_ code: String, down: Bool) {
        guard let vk = keyCodes[code] else { return }
        let repeated = down && keys.contains(code)
        if down { keys.insert(code) } else if keys.remove(code) == nil { return }   // stray up
        let flag = modifierFlags[code]
        if let flag {
            if down { flags.insert(flag) } else if !keys.contains(where: { modifierFlags[$0] == flag }) { flags.remove(flag) }
        }
        guard let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down) else { return }
        if flag != nil { e.type = .flagsChanged }
        if repeated { e.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        post(e, flags: flags.union(keyMarks[code] ?? []))
    }

    /// Text from a phone keyboard, any language: Unicode key events of at most 20 UTF-16 units, never splitting a character.
    private func type(_ text: String) {
        var chunk: [UniChar] = []
        func flush() {
            guard !chunk.isEmpty else { return }
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                post(e, flags: [])
            }
            chunk = []
        }
        for ch in text {
            let u = Array(String(ch).utf16)
            if chunk.count + u.count > 20 { flush() }
            chunk += u
        }
        flush()
    }

    private func post(_ e: CGEvent?, flags f: CGEventFlags? = nil) {
        guard let e else { return }
        e.flags = f ?? flags
        e.post(tap: .cghidEventTap)
    }

    private func pair(_ v: Any?) -> CGPoint? {
        guard let a = v as? [Double], a.count == 2, a.allSatisfy({ $0.isFinite && abs($0) < 1e5 }) else { return nil }
        return CGPoint(x: a[0], y: a[1])
    }
}

private let modifierFlags: [String: CGEventFlags] = [
    "MetaLeft": .maskCommand, "MetaRight": .maskCommand, "ShiftLeft": .maskShift, "ShiftRight": .maskShift,
    "AltLeft": .maskAlternate, "AltRight": .maskAlternate, "ControlLeft": .maskControl, "ControlRight": .maskControl,
]

/// Real keyboards mark arrows (fn + keypad) and the other navigation and F-keys (fn). macOS's own shortcuts, such as
/// ⌃← / ⌃→ for switching Spaces and ⌃↑ for Mission Control, only match key events that carry those marks.
private let keyMarks: [String: CGEventFlags] = {
    var m: [String: CGEventFlags] = [:]
    for k in ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] { m[k] = [.maskSecondaryFn, .maskNumericPad] }
    for k in ["Home", "End", "PageUp", "PageDown", "Delete", "Insert"] + (1...12).map({ "F\($0)" }) { m[k] = .maskSecondaryFn }
    return m
}()

/// Browser KeyboardEvent.code -> macOS virtual key code (HIToolbox kVK_*), ANSI positions.
private let keyCodes: [String: CGKeyCode] = [
    "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05, "KeyZ": 0x06, "KeyX": 0x07,
    "KeyC": 0x08, "KeyV": 0x09, "IntlBackslash": 0x0A, "KeyB": 0x0B, "KeyQ": 0x0C, "KeyW": 0x0D, "KeyE": 0x0E,
    "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11, "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15,
    "Digit6": 0x16, "Digit5": 0x17, "Equal": 0x18, "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B, "Digit8": 0x1C,
    "Digit0": 0x1D, "BracketRight": 0x1E, "KeyO": 0x1F, "KeyU": 0x20, "BracketLeft": 0x21, "KeyI": 0x22, "KeyP": 0x23,
    "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26, "Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29, "Backslash": 0x2A,
    "Comma": 0x2B, "Slash": 0x2C, "KeyN": 0x2D, "KeyM": 0x2E, "Period": 0x2F, "Tab": 0x30, "Space": 0x31,
    "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35, "MetaRight": 0x36, "MetaLeft": 0x37, "ShiftLeft": 0x38,
    "CapsLock": 0x39, "AltLeft": 0x3A, "ControlLeft": 0x3B, "ShiftRight": 0x3C, "AltRight": 0x3D, "ControlRight": 0x3E,
    "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumLock": 0x47, "NumpadDivide": 0x4B,
    "NumpadEnter": 0x4C, "NumpadSubtract": 0x4E, "NumpadEqual": 0x51, "Numpad0": 0x52, "Numpad1": 0x53,
    "Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56, "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59,
    "Numpad8": 0x5B, "Numpad9": 0x5C, "F5": 0x60, "F6": 0x61, "F7": 0x62, "F3": 0x63, "F8": 0x64, "F9": 0x65,
    "F11": 0x67, "F10": 0x6D, "F12": 0x6F, "Insert": 0x72, "Home": 0x73, "PageUp": 0x74, "Delete": 0x75, "F4": 0x76,
    "End": 0x77, "F2": 0x78, "PageDown": 0x79, "F1": 0x7A, "ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D,
    "ArrowUp": 0x7E,
]
