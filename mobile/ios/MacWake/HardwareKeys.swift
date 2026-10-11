// iPad hardware keyboards (Magic Keyboard etc.) for remote control. While the viewer is open, a hidden view holds
// first responder, so every key press, ⌘ shortcuts included, arrives here instead of UIKit's defaults.
// iPadOS still keeps its own shortcuts (⌘Tab, ⌘Space, Globe); the app's keys row covers those.
import GameController
import React
import UIKit

@objc(HardwareKeys)
final class HardwareKeys: RCTEventEmitter {
  private let catcher = KeyCatcher()
  private var listening = false
  private var observers: [NSObjectProtocol] = []

  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String] { ["key", "keyboard"] }
  override func startObserving() { listening = true }
  override func stopObserving() { listening = false }

  private func emit(_ name: String, _ body: [String: Any]) {
    if listening { sendEvent(withName: name, body: body) }
  }

  /// Viewer open, or the phone keyboard just closed: take first responder and report keys.
  @objc func start() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.catcher.onKey = { [weak self] usage, down in self?.emit("key", ["usage": usage, "down": down]) }
      if self.catcher.window == nil,
         let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first {
        window.addSubview(self.catcher)
      }
      self.catcher.becomeFirstResponder()
      if self.observers.isEmpty {
        let report: (Notification) -> Void = { [weak self] _ in self?.emit("keyboard", ["connected": GCKeyboard.coalesced != nil]) }
        self.observers = [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect].map {
          NotificationCenter.default.addObserver(forName: $0, object: nil, queue: .main, using: report)
        }
      }
      self.emit("keyboard", ["connected": GCKeyboard.coalesced != nil])
    }
  }

  /// Viewer closed: give first responder back.
  @objc func stop() {
    DispatchQueue.main.async {
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers = []
      self.catcher.resignFirstResponder()
      self.catcher.removeFromSuperview()
    }
  }
}

/// Invisible first responder that turns presses into (HID usage, down) and swallows them.
final class KeyCatcher: UIView {
  var onKey: (Int, Bool) -> Void = { _, _ in }
  override var canBecomeFirstResponder: Bool { true }
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) { report(presses, true) }
  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) { report(presses, false) }
  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) { report(presses, false) }
  private func report(_ presses: Set<UIPress>, _ down: Bool) {
    for p in presses { if let k = p.key { onKey(k.keyCode.rawValue, down) } }
  }
}
