// Live screen for paired viewers. Menu-bar app only: the root daemon has no screen session and never runs this.
// The console relays one WebRTC offer and one answer; the video then flows straight from this Mac to the viewer.
import AppKit
import CoreMedia
import Foundation
import IOKit.pwr_mgt
import ScreenCaptureKit
import WebRTC

/// Watches the console for viewer offers and runs at most one viewing session (the newest viewer wins).
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
    private var session: ViewSession?

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

    /// Ends the current session, e.g. when "Allow screen viewing" is turned off.
    func endSession() { session?.stop() }

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
        session?.stop()
        let s = ViewSession(ice: ice)
        session = s
        s.onState = { [weak self, weak s] live in
            guard let self, let s, self.session === s else { return }
            if !live { self.session = nil }
            self.onLive(live)
        }
        s.start(offer: offer.sdp) { [weak self] result in
            switch result {
            case .success(let sdp): self?.post(offer.id, ["answer": sdp])
            case .failure(let e): self?.post(offer.id, ["error": e.code]); s.stop()
            }
        }
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

/// A refusal the viewer can explain: one of the console's codes (permission, no-display, failed).
struct ShareError: Error { let code: String }

/// One viewer: captures the main display with ScreenCaptureKit and sends it over a WebRTC peer connection.
/// Everything except the ScreenCaptureKit callbacks runs on the main queue.
final class ViewSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate, SCStreamOutput, SCStreamDelegate {
    static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    /// Main queue: true once the viewer is connected, false once the session has ended.
    var onState: (Bool) -> Void = { _ in }
    private let ice: [ScreenShare.Ice]
    private let source: RTCVideoSource
    private let capturer: RTCVideoCapturer
    private var pc: RTCPeerConnection?
    private var stream: SCStream?
    private var channel: RTCDataChannel?
    private var assertions: [IOPMAssertionID] = []
    private var lockTimer: Timer?
    private var sentLocked: Bool?
    private var dropTimer: DispatchWorkItem?
    private var connected = false
    private var stopped = false
    private let frames = DispatchQueue(label: "io.macwake.screen")
    private var lastFrame: CVPixelBuffer?        // frames queue only
    private var lastFrameAt = CMTime.zero        // frames queue only
    private var repeater: DispatchSourceTimer?

    init(ice: [ScreenShare.Ice]) {
        self.ice = ice
        let src = ViewSession.factory.videoSource()
        source = src
        capturer = RTCVideoCapturer(delegate: src)
        super.init()
    }

    func start(offer: String, done: @escaping (Result<String, ShareError>) -> Void) {
        holdAwake()
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, !self.connected else { return }
            self.stop()   // the viewer never showed up (closed, or its network can't reach this Mac)
        }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            DispatchQueue.main.async {
                guard !self.stopped else { return done(.failure(ShareError(code: "failed"))) }
                if let error = error as NSError? {
                    return done(.failure(ShareError(code: error.code == SCStreamError.userDeclined.rawValue ? "permission" : "failed")))
                }
                let displays = content?.displays ?? []
                guard let display = displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? displays.first else {
                    return done(.failure(ShareError(code: "no-display")))
                }
                self.capture(display) { ok in
                    guard ok else { return done(.failure(ShareError(code: "failed"))) }
                    self.negotiate(offer, done: done)
                }
            }
        }
    }

    /// Keeps the display on and the Mac awake while someone watches; the daemon's own sleep logic is untouched.
    private func holdAwake() {
        assertions = [kIOPMAssertionTypePreventUserIdleDisplaySleep, kIOPMAssertionTypePreventUserIdleSystemSleep].map { assertion($0 as String, "MacWake screen viewing") }
        var id: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("MacWake screen viewing" as CFString, kIOPMUserActiveLocal, &id)   // turns the display on
        assertions.append(id)
    }

    private func capture(_ display: SCDisplay, done: @escaping (Bool) -> Void) {
        let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID }
        let scale = screen?.backingScaleFactor ?? 1
        let w = Double(display.width) * scale, h = Double(display.height) * scale
        let k = min(1, 1920 / max(w, h))   // long edge at most 1920 px
        let cfg = SCStreamConfiguration()
        cfg.width = Int(w * k) / 2 * 2; cfg.height = Int(h * k) / 2 * 2   // even sizes for the encoder
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        cfg.showsCursor = true
        cfg.queueDepth = 6
        let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
        do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: frames) } catch { return done(false) }
        stream = s
        s.startCapture { error in DispatchQueue.main.async { done(error == nil && !self.stopped) } }
        startRepeater()
    }

    private func negotiate(_ offer: String, done: @escaping (Result<String, ShareError>) -> Void) {
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceServers = ice.map { RTCIceServer(urlStrings: $0.urls, username: $0.username, credential: $0.credential) }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = ViewSession.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            return done(.failure(ShareError(code: "failed")))
        }
        self.pc = pc
        let fail = { DispatchQueue.main.async { done(.failure(ShareError(code: "failed"))) } }
        pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offer)) { error in
            if error != nil { return fail() }
            // After the offer, so the track takes the viewer's recvonly video slot.
            pc.add(ViewSession.factory.videoTrack(with: self.source, trackId: "screen"), streamIds: ["screen"])
            pc.answer(for: constraints) { sdp, error in
                guard let sdp, error == nil else { return fail() }
                pc.setLocalDescription(sdp) { error in
                    if error != nil { return fail() }
                    self.whenGathered {
                        guard let local = pc.localDescription?.sdp, !self.stopped else { return done(.failure(ShareError(code: "failed"))) }
                        done(.success(local))
                    }
                }
            }
        }
    }

    /// Non-trickle signaling: wait until every ICE candidate is in the SDP, at most 3 s. Calls back on main.
    private func whenGathered(_ then: @escaping () -> Void) {
        let deadline = Date().addingTimeInterval(3)
        func poll() {
            if pc?.iceGatheringState == .complete || Date() > deadline { return then() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
        }
        DispatchQueue.main.async(execute: poll)
    }

    // MARK: Frames (frames queue)

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              (info[.status] as? Int).flatMap({ SCFrameStatus(rawValue: $0) }) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        send(pb, at: CMSampleBufferGetPresentationTimeStamp(sb))
    }

    private func send(_ pb: CVPixelBuffer, at t: CMTime) {
        lastFrame = pb; lastFrameAt = t
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pb), rotation: ._0, timeStampNs: Int64(CMTimeGetSeconds(t) * 1e9))
        source.capturer(capturer, didCapture: frame)
    }

    /// ScreenCaptureKit sends nothing while the screen is still. Repeat the last frame every 0.5 s so a viewer that
    /// just joined (or lost a packet) gets a picture without waiting for something to move.
    private func startRepeater() {
        let t = DispatchSource.makeTimerSource(queue: frames)
        t.schedule(deadline: .now() + 0.5, repeating: 0.5)
        t.setEventHandler { [weak self] in
            guard let self, let pb = self.lastFrame else { return }
            let now = CMClockGetTime(CMClockGetHostTimeClock())   // same clock as ScreenCaptureKit's timestamps
            if CMTimeGetSeconds(CMTimeSubtract(now, self.lastFrameAt)) >= 0.5 { self.send(pb, at: now) }
        }
        t.resume()
        repeater = t
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { DispatchQueue.main.async { self.stop() } }

    // MARK: Peer connection (WebRTC's signaling thread; hop to main)

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        DispatchQueue.main.async {
            switch newState {
            case .connected:
                self.dropTimer?.cancel(); self.dropTimer = nil
                if !self.stopped { self.connected = true; self.onState(true) }
            case .disconnected:
                let w = DispatchWorkItem { self.stop() }   // a blip can recover; a closed lid or tab won't
                self.dropTimer?.cancel(); self.dropTimer = w
                DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: w)
            case .failed, .closed: self.stop()
            default: break
            }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        DispatchQueue.main.async {
            self.channel = dataChannel
            dataChannel.delegate = self
            self.lockTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.sendLocked() }
        }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) { DispatchQueue.main.async { self.sentLocked = nil; self.sendLocked() } }
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {}   // control comes later

    /// Tells the viewer when the Mac is at the lock screen (view-only can't unlock it).
    private func sendLocked() {
        guard let c = channel, c.readyState == .open else { return }
        let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
        guard locked != sentLocked else { return }
        if c.sendData(RTCDataBuffer(data: Data("{\"locked\":\(locked)}".utf8), isBinary: false)) { sentLocked = locked }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    /// Ends everything once: capture, connection, keep-awake assertions, icon. Main queue.
    func stop() {
        guard !stopped else { return }
        stopped = true
        dropTimer?.cancel(); lockTimer?.invalidate(); repeater?.cancel()
        stream?.stopCapture { _ in }
        channel?.close(); pc?.close()
        stream = nil; channel = nil; pc = nil
        assertions.forEach { IOPMAssertionRelease($0) }
        assertions = []
        frames.async { self.lastFrame = nil }
        onState(false)
    }
}
