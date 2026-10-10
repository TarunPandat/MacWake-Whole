// Live screen for paired viewers. Menu-bar app only: the root daemon has no screen session and never runs this.
// The console relays one WebRTC offer and one answer; the video then flows straight from this Mac to the viewer.
import AppKit
import Foundation

/// Watches the console for viewer offers and answers them.
final class ScreenShare {
    let url: String
    let token: String
    /// Main queue: true while a viewer is connected (the menu bar shows an eye).
    var onLive: (Bool) -> Void = { _ in }
    /// The menu's "Allow screen viewing".
    var allowed: () -> Bool = { true }

    private let lock = NSLock()
    private var pushServer: String?     // read by the push listener thread
    private var handled = ""            // id of the last offer answered
    private var checking = false, again = false

    init(url: String, token: String) { self.url = url; self.token = token }

    func start() {
        listenForPushes(topic: pushTopic(token) + "-screen", server: { [weak self] in
            guard let self else { return nil }
            self.lock.lock(); defer { self.lock.unlock() }
            return self.pushServer
        }) { [weak self] in DispatchQueue.main.async { self?.check() } }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self?.check() }   // Wi-Fi needs a moment after wake
        }
        // ponytail: without a push server (NTFY_URL=off) poll every 10 s while awake; offers stay valid for 60 s.
        Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.lock.lock(); let push = self.pushServer; self.lock.unlock()
            if push == nil { self.check() }
        }
        check()
    }

    struct Ice: Decodable { var urls: [String]; var username: String?; var credential: String? }
    struct Offer: Decodable { var id: String; var sdp: String }
    struct Reply: Decodable { var ice: [Ice]; var push: String?; var offer: Offer? }

    /// Asks the console for a pending offer (it only returns offers younger than 60 s) and answers a new one.
    /// A push that lands while a check is in flight runs one more check, so an offer written meanwhile isn't missed.
    func check() {
        guard !checking else { again = true; return }
        checking = true
        call(nil) { [weak self] data in
            guard let self else { return }
            self.checking = false
            defer { if self.again { self.again = false; self.check() } }
            guard let data, let r = try? JSONDecoder().decode(Reply.self, from: data) else { return }
            self.lock.lock(); self.pushServer = r.push; self.lock.unlock()
            guard let offer = r.offer, offer.id != self.handled else { return }
            self.handled = offer.id
            self.answer(offer, ice: r.ice)
        }
    }

    func answer(_ offer: Offer, ice: [Ice]) {
        guard allowed() else { return post(offer.id, ["error": "disabled"]) }
        guard CGPreflightScreenCaptureAccess() else { return post(offer.id, ["error": "permission"]) }
        post(offer.id, ["error": "failed"])
    }

    func post(_ id: String, _ fields: [String: String]) {
        call(fields.merging(["id": id]) { a, _ in a }) { _ in }
    }

    /// GET /api/screen (body nil) or POST it. `done` runs on the main queue with the body, or nil on any failure.
    func call(_ body: [String: String]?, done: @escaping (Data?) -> Void) {
        guard let u = URL(string: url + "/api/screen") else { return done(nil) }
        var req = URLRequest(url: u, timeoutInterval: 10)
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok ? data : nil) }
        }.resume()
    }
}
