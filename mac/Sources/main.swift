// MacWake: menu-bar setup app + root background daemon (same binary, `--daemon`).
// The daemon arms an RTC wake every `interval` minutes. Each wake is a short dark wake;
// the daemon notices it within a second, holds the Mac awake just long enough to ask the
// web console, and keeps it awake (lighting the screen if the lid is open) when a wake
// request is pending.
import AppKit
import Foundation
import IOKit
import IOKit.pwr_mgt
import CoreImage
import Security
import CryptoKit

let label = "io.macwake.daemon"
// powerd (AutoWakeScheduler.c, wakeTimerExpiredCallout): an owner containing "com.apple.alarm"
// gets a 5 s InternalPreventSleep when its wake fires (screen stays off); any other owner gets
// UserIsActive, which turns a dark wake into a full wake with the display on.
let darkOwner = "com.apple.alarm.MacWake"
let fullOwner = "MacWake"
let supportDir = "/Library/Application Support/MacWake"
let configPath = ProcessInfo.processInfo.environment["MACWAKE_CONFIG"] ?? supportDir + "/config.json"   // env override for testing
let plistPath = "/Library/LaunchDaemons/\(label).plist"
let logPath = "/Library/Logs/MacWake.log"

struct Config: Codable { var url: String; var token: String }

func log(_ s: String) {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    print("\(f.string(from: Date())) \(s)"); fflush(stdout)
}

@discardableResult
func sh(_ cmd: String) -> (status: Int32, out: String) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", cmd]
    let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
    do { try p.run() } catch { return (1, "\(error)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func assertion(_ type: String, _ reason: String) -> IOPMAssertionID {
    var id: IOPMAssertionID = 0
    let rc = IOPMAssertionCreateWithName(type as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
    if rc != kIOReturnSuccess { log("assertion \(type) failed: \(rc)") }
    return id
}

func power() -> (ac: Bool, battery: Int?) {
    let out = sh("/usr/bin/pmset -g batt").out
    let pct = out.range(of: #"(\d+)%"#, options: .regularExpression).map { Int(out[$0].dropLast()) } ?? nil
    return (out.contains("AC Power"), pct)
}

/// Seconds since epoch of the last system wake. Changes on dark wakes too, unlike IORegisterForSystemPower.
func wakeTime() -> Int {
    var tv = timeval(); var len = MemoryLayout<timeval>.size
    sysctlbyname("kern.waketime", &tv, &len, nil, 0)
    return tv.tv_sec
}

func rootDomainFlag(_ key: String) -> Bool {
    let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    defer { IOObjectRelease(svc) }
    return (IORegistryEntryCreateCFProperty(svc, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Bool) ?? false
}
func lidClosed() -> Bool { rootDomainFlag("AppleClamshellState") }
/// Lid closed and nothing (external display) keeps the Mac running in clamshell mode.
func lidWouldSleep() -> Bool { lidClosed() && rootDomainFlag("AppleClamshellCausesSleep") }

// MARK: - Daemon

final class Daemon {
    let cfg: Config
    var interval: TimeInterval = 5 * 60
    var holdUntil: Date?
    var holdIDs: [IOPMAssertionID] = []
    var scheduled: (date: Date, owner: String)?
    var lastWake = wakeTime()
    var lastPoll = Date.distantPast
    var instant = false          // console setting: stay listening while on charger
    var onAC = false
    var checkingIn = false
    // Written by the push listener thread, read by the main loop.
    let pushLock = NSLock()
    var pushServer: String?
    var poked = false
    lazy var topic = "macwake-" + SHA256.hash(data: Data(cfg.token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(40)

    init(cfg: Config) {
        var c = cfg
        while c.url.hasSuffix("/") { c.url.removeLast() }
        self.cfg = c
    }

    // instant/push are optional so older consoles (e.g. the Cloudflare worker) keep working.
    struct Reply: Decodable { var wake: Bool; var hold: Bool; var interval: Double; var holdMinutes: Double; var instant: Bool?; var push: String? }

    /// Instant mode on charger keeps the Mac out of idle sleep (screen still turns off), so pushes arrive in seconds.
    var listening: Bool { instant && onAC }
    var listenIDs: [IOPMAssertionID] = []

    /// `disablesleep` also greys out Sleep in the Apple menu and blocks `pmset sleepnow`, so it is held only while
    /// checking in after a wake, or while holding/listening with the lid closed (assertions can't beat lid-close sleep).
    /// With the lid open, assertions keep the Mac up and Sleep still works; listening resumes at the next wake.
    func updateLock() {
        lockSleep(checkingIn || ((holdUntil != nil || listening) && lidWouldSleep()))
        guard listening != !listenIDs.isEmpty else { return }
        listenIDs.forEach { IOPMAssertionRelease($0) }
        listenIDs = listening ? Daemon.keepAwake.map { assertion($0, "MacWake listening") } : []
    }

    /// Long-lived stream from the push relay; every message means "check in now".
    func startPushListener() {
        Thread.detachNewThread { [self] in
            while true {
                pushLock.lock(); let server = pushServer; pushLock.unlock()
                guard let server else { Thread.sleep(forTimeInterval: 5); continue }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
                p.arguments = ["-sN", "--max-time", "3600", "\(server)/\(topic)/raw"]
                let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
                guard (try? p.run()) != nil else { Thread.sleep(forTimeInterval: 10); continue }
                var buf = Data()
                while true {
                    let chunk = out.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    buf.append(chunk)
                    while let nl = buf.firstIndex(of: 10) {
                        let line = buf[buf.startIndex..<nl]; buf.removeSubrange(buf.startIndex...nl)
                        // ntfy sends empty lines as keepalives
                        if line.contains(where: { $0 != 32 && $0 != 13 }) { pushLock.lock(); poked = true; pushLock.unlock() }
                    }
                }
                p.waitUntilExit()
                Thread.sleep(forTimeInterval: 3)
            }
        }
    }

    func takePoke() -> Bool { pushLock.lock(); defer { poked = false; pushLock.unlock() }; return poked }

    // Assertions that keep a dark wake alive (PreventUserIdleSystemSleep does not). AC power only.
    static let keepAwake = [kIOPMAssertionTypePreventSystemSleep as String, kIOPMAssertNetworkClientActive as String]

    /// `pmset disablesleep` is the only switch that beats lid-close sleep and works on battery
    /// (app assertions are ignored in both cases). See updateLock for when it is held.
    var sleepLocked = false
    func lockSleep(_ on: Bool, force: Bool = false) {
        guard force || on != sleepLocked else { return }
        sh("/usr/bin/pmset -a disablesleep \(on ? 1 : 0)")
        sleepLocked = on
    }

    func run() -> Never {
        log("daemon start uid=\(getuid()) url=\(cfg.url)")
        if getuid() != 0 { log("WARNING: not root, scheduling wakes will fail") }
        lockSleep(false, force: true)   // never leave sleep disabled after a crash or restart
        cancelOwnWakes()
        startPushListener()
        while true {
            let now = Date()
            let w = wakeTime()
            let justWoke = w != lastWake
            lastWake = w
            if let until = holdUntil, now > until { release(); log("hold expired") }
            updateLock()          // follows the lid
            let pushed = takePoke()
            if pushed { log("push received, checking in") }
            if justWoke || pushed || now.timeIntervalSince(lastPoll) >= 60 {
                // Grab the dark wake immediately: it only lasts a few seconds on its own.
                let guards = Daemon.keepAwake.map { assertion($0, "MacWake check-in") }
                if justWoke { log("woke up, checking in (lid \(lidClosed() ? "closed" : "open"))"); checkingIn = true; updateLock() }
                let p = power()
                onAC = p.ac
                checkIn(power: p, within: justWoke ? 45 : 0)     // Wi-Fi needs a few seconds after wake
                lastPoll = Date()
                arm(power: p)
                guards.forEach { IOPMAssertionRelease($0) }
                checkingIn = false
                updateLock()          // nothing requested and not listening: let the Mac go back to sleep
            }
            Thread.sleep(forTimeInterval: 1)
        }
    }

    /// Tries once, then keeps retrying until `within` seconds have passed.
    func checkIn(power p: (ac: Bool, battery: Int?), within: TimeInterval) {
        let deadline = Date().addingTimeInterval(within)
        var attempt = 0
        repeat {
            attempt += 1
            if let r = heartbeat(power: p) { apply(r); return }
            log("check-in failed (attempt \(attempt))")
            if Date() < deadline { Thread.sleep(forTimeInterval: 3) }
        } while Date() < deadline
    }

    func heartbeat(power p: (ac: Bool, battery: Int?)) -> Reply? {
        guard let url = URL(string: cfg.url + "/api/heartbeat") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("Bearer " + cfg.token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["ac": p.ac, "battery": p.battery as Any, "host": Host.current().localizedName ?? "", "holding": holdUntil != nil, "lid": lidClosed(), "listening": listening]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        var reply: Reply?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err = err { log("http error: \(err.localizedDescription)"); return }
            guard let code = (resp as? HTTPURLResponse)?.statusCode, code == 200, let data = data else {
                log("http status \((resp as? HTTPURLResponse)?.statusCode ?? -1)"); return
            }
            reply = try? JSONDecoder().decode(Reply.self, from: data)
        }.resume()
        sem.wait()
        return reply
    }

    func apply(_ r: Reply) {
        interval = max(60, r.interval * 60)
        if (r.instant ?? false) != instant { log("instant mode \((r.instant ?? false) ? "on" : "off")") }
        instant = r.instant ?? false
        pushLock.lock(); pushServer = r.push; pushLock.unlock()
        if r.wake { hold(minutes: r.holdMinutes) }
        else if !r.hold, holdUntil != nil { release(); log("released by console") }
    }

    func hold(minutes: Double) {
        dropAssertions()
        holdUntil = Date().addingTimeInterval(minutes * 60)
        updateLock()
        holdIDs = (Daemon.keepAwake + [kIOPMAssertionTypePreventUserIdleSystemSleep as String, kIOPMAssertionTypePreventUserIdleDisplaySleep as String])
            .map { assertion($0, "MacWake remote wake") }
        if lidClosed() {
            log("wake requested: lid closed, staying awake \(Int(minutes)) min with the screen off (SSH / Screen Sharing OK)")
        } else {
            var id: IOPMAssertionID = 0
            IOPMAssertionDeclareUserActivity(fullOwner as CFString, kIOPMUserActiveLocal, &id)   // full wake, display on
            holdIDs.append(id)
            log("wake requested: holding awake for \(Int(minutes)) min, display on")
        }
    }

    func dropAssertions() {
        holdIDs.forEach { IOPMAssertionRelease($0) }
        holdIDs = []
    }

    /// End a hold. With the lid closed nothing else would put the Mac back to sleep, so do it explicitly.
    func release() {
        dropAssertions()
        holdUntil = nil
        updateLock()
        if !listening && lidWouldSleep() { log("lid closed, going back to sleep"); sh("/usr/bin/pmset sleepnow") }
    }

    /// Keep exactly one pending RTC wake of ours, at most `interval` ahead.
    func arm(power p: (ac: Bool, battery: Int?)) {
        // Dark (screen-off) wakes everywhere: lockSleep keeps them alive even on battery with the lid closed.
        // ponytail: on battery check in at most every 10 min to save charge.
        let owner = darkOwner
        let every = p.ac ? interval : max(interval, 10 * 60)
        if let s = scheduled, s.owner == owner, s.date.timeIntervalSinceNow > 30 { return }
        if let s = scheduled { IOPMCancelScheduledPowerEvent(s.date as CFDate, s.owner as CFString, kIOPMAutoWake as CFString) }
        let date = Date().addingTimeInterval(every)
        let rc = IOPMSchedulePowerEvent(date as CFDate, owner as CFString, kIOPMAutoWake as CFString)
        scheduled = rc == kIOReturnSuccess ? (date, owner) : nil
        if rc != kIOReturnSuccess { log("schedule wake failed: \(rc)") }
    }

    func cancelOwnWakes() {   // leftovers from a previous daemon run
        guard let events = IOPMCopyScheduledPowerEvents()?.takeRetainedValue() as? [[String: Any]] else { return }
        for e in events where [darkOwner, fullOwner].contains(e[kIOPMPowerEventAppNameKey] as? String ?? "") {
            if let t = e[kIOPMPowerEventTimeKey] as? Date, let type = e[kIOPMPowerEventTypeKey] as? String, let o = e[kIOPMPowerEventAppNameKey] as? String {
                IOPMCancelScheduledPowerEvent(t as CFDate, o as CFString, type as CFString)
            }
        }
    }
}

// MARK: - Menu bar app

/// HTTP call that blocks the caller; fine for the few one-off requests the menu-bar app makes.
func request(_ method: String, _ url: String, token: String, timeout: TimeInterval = 10) -> (status: Int, error: String?) {
    guard let u = URL(string: url) else { return (0, "invalid URL") }
    var req = URLRequest(url: u, timeoutInterval: timeout)
    req.httpMethod = method
    req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    var out: (Int, String?) = (0, "no response")
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, resp, err in
        out = ((resp as? HTTPURLResponse)?.statusCode ?? 0, err?.localizedDescription)
        sem.signal()
    }.resume()
    sem.wait()
    return out
}

/// The user's copy of the token, so the menu can show it. Readable only by this user (0600).
enum Token {
    static let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MacWake/token").path
    static func load() -> String? {
        (try? String(contentsOfFile: path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
    static func save(_ t: String) {
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: Data(t.utf8), attributes: [.posixPermissions: 0o600])
    }
    static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

func qrImage(_ text: String, size: CGFloat) -> NSImage? {
    guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    f.setValue(Data(text.utf8), forKey: "inputMessage")
    f.setValue("M", forKey: "inputCorrectionLevel")
    guard let ci = f.outputImage else { return nil }
    let scaled = ci.transformed(by: CGAffineTransform(scaleX: size / ci.extent.width, y: size / ci.extent.height))
    guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: size, height: size))
}

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    /// Console URL baked in at build time (build.sh CONSOLE_URL=...), unless the user picked another one.
    var consoleURL: String {
        get { UserDefaults.standard.string(forKey: "url") ?? (Bundle.main.object(forInfoDictionaryKey: "MacWakeConsoleURL") as? String) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "url") }
    }
    var installed: Bool { FileManager.default.fileExists(atPath: plistPath) }
    var serviceRunning: Bool { sh("pgrep -f '[M]acWake --daemon'").status == 0 }
    /// Link for the phone. A phone can't open "localhost", so swap in this Mac's Wi-Fi address.
    var phoneLink: String? {
        guard let t = Token.load() else { return nil }
        var base = consoleURL
        if let lan = sh("/usr/sbin/ipconfig getifaddr en0").out.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            for local in ["localhost", "127.0.0.1"] { base = base.replacingOccurrences(of: "//\(local)", with: "//\(lan)") }
        }
        return "\(base)/#token=\(t)"
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        item.button?.image = NSImage(systemSymbolName: "powersleep", accessibilityDescription: "MacWake")
        if item.button?.image == nil { item.button?.title = "MW" }
        menu.delegate = self; item.menu = menu
        rebuild()
        if !installed || Token.load() == nil { DispatchQueue.main.async { self.setup() } }
        else if CommandLine.arguments.contains("--setup") { DispatchQueue.main.async { self.setup() } }
        else if CommandLine.arguments.contains("--pair") { DispatchQueue.main.async { self.showPairing() } }
        // A newer app than the installed background service: reinstall it (same token, asks for the password once).
        else if !FileManager.default.contentsEqual(atPath: Bundle.main.executablePath!, andPath: supportDir + "/MacWake") { DispatchQueue.main.async { self.setup() } }
    }

    func menuWillOpen(_ menu: NSMenu) { rebuild() }

    func rebuild() {
        menu.removeAllItems()
        let status = !installed ? "Not set up" : serviceRunning ? "Running, checking in with the console" : "Installed, but not running"
        menu.addItem(withTitle: status, action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        if installed && Token.load() != nil {
            add("Pair phone…", #selector(showPairing))
            add("Copy token", #selector(copyToken))
            add("Open console", #selector(openConsole))
        } else {
            add("Set up…", #selector(setup))
        }
        menu.addItem(.separator())
        add("Change console URL…", #selector(changeURL))
        add("Show log", #selector(showLog))
        add("Sleep now", #selector(sleepNow))
        menu.addItem(.separator())
        add("Uninstall…", #selector(uninstall)).isEnabled = installed
        menu.addItem(withTitle: "Quit MacWake", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    @discardableResult
    func add(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = menu.addItem(withTitle: title, action: sel, keyEquivalent: ""); i.target = self; return i
    }

    func alert(_ msg: String, _ info: String = "") {
        let a = NSAlert(); a.messageText = msg; a.informativeText = info; NSApp.activate(ignoringOtherApps: true); a.runModal()
    }

    /// One-line text prompt. Fixed frames: NSAlert sizes its accessory view from the frame, not Auto Layout.
    func prompt(_ title: String, _ info: String, value: String = "", placeholder: String, secure: Bool = false, ok: String = "Continue") -> String? {
        let a = NSAlert(); a.messageText = title; a.informativeText = info
        let f: NSTextField = secure ? NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)) : NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        f.stringValue = value; f.placeholderString = placeholder
        a.accessoryView = f
        a.addButton(withTitle: ok); a.addButton(withTitle: "Cancel")
        a.layout(); a.window.initialFirstResponder = f
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return nil }
        let v = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.isEmpty ? nil : v
    }

    /// Install flow: URL from the build (or ask once), token generated here, paired with the console, then the root service.
    @objc func setup() {
        let bp = Bundle.main.bundlePath
        if bp.hasPrefix("/Volumes/") || bp.contains("/AppTranslocation/") || bp.contains("/dist/") {
            alert("Move MacWake to Applications first", "Drag MacWake.app into the Applications folder, then open it from there."); return
        }
        if consoleURL.isEmpty {
            guard let u = prompt("Where is your MacWake console?", "Enter the web address of the console you deployed.", placeholder: "https://your-console.vercel.app") else { return }
            consoleURL = normalized(u)
        }
        guard let token = pair() else { return }
        Token.save(token)
        let r = runAdmin(App.installScript(Config(url: consoleURL, token: token), exe: Bundle.main.executablePath!))
        guard r.ok else { alert("MacWake couldn't install its background service", r.out); return }
        rebuild()
        showPairing()
    }

    /// Returns a token the console accepts: this Mac's own (registered on first run) or one the user pastes.
    func pair() -> String? {
        let token = Token.load() ?? Token.generate()
        let r = request("POST", consoleURL + "/api/register", token: token)
        switch r.status {
        case 200, 201: return token
        case 500...599:
            alert("The console couldn't save the pairing", "\(consoleURL) answered with status \(r.status). On Vercel, check that Upstash for Redis is connected under Storage, then redeploy and choose Set up… again.")
            return nil
        case 0:
            alert("MacWake can't reach the console", "\(consoleURL) did not answer (\(r.error ?? "no response")). Check the address with Change console URL…, and that this Mac is online.")
            return nil
        default:
            // 409: the console is already paired with another token. 404/405: older console without pairing.
            let why = r.status == 409 ? "This console is already paired with a different token." : "This console doesn't support automatic pairing."
            guard let pasted = prompt("Enter the console's token", "\(why) Paste the token you used before, or the ADMIN_TOKEN set on the server.", placeholder: "token", secure: true, ok: "Use token") else { return nil }
            let check = request("GET", consoleURL + "/api/state", token: pasted)
            if check.status == 200 { return pasted }
            alert("The console didn't accept that token", "It answered with status \(check.status). Check the token and try Set up… again.")
            return nil
        }
    }

    func normalized(_ u: String) -> String {
        var s = u.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.hasPrefix("http") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    @objc func changeURL() {
        guard let u = prompt("Change console URL", "MacWake will pair with this console and restart its background service.", value: consoleURL, placeholder: "https://your-console.vercel.app") else { return }
        consoleURL = normalized(u)
        setup()
    }

    /// QR code that opens the console on a phone already signed in, plus the token for pasting.
    @objc func showPairing() {
        guard let link = phoneLink, let token = Token.load() else { setup(); return }
        var copied = false
        while true {
            let a = NSAlert()
            a.messageText = copied ? "Token copied" : "Pair your phone"
            a.informativeText = "Scan this with your phone camera to open the console signed in. Then use Add to Home Screen.\n\nOr paste this token on the sign-in screen:\n\(token)"
            if let img = qrImage(link, size: 220) {
                let v = NSImageView(frame: NSRect(x: 0, y: 0, width: 220, height: 220)); v.image = img
                a.accessoryView = v
            }
            a.addButton(withTitle: "Done"); a.addButton(withTitle: "Copy token"); a.addButton(withTitle: "Open console")
            NSApp.activate(ignoringOtherApps: true)
            switch a.runModal() {
            case .alertSecondButtonReturn: copyToken(); copied = true; continue
            case .alertThirdButtonReturn: openConsole()
            default: break
            }
            return
        }
    }

    @objc func copyToken() {
        guard let t = Token.load() else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string)
    }

    static func installScript(_ cfg: Config, exe: String) -> String {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
        <key>Label</key><string>\(label)</string>
        <key>ProgramArguments</key><array><string>\(supportDir)/MacWake</string><string>--daemon</string></array>
        <key>RunAtLoad</key><true/>
        <key>KeepAlive</key><true/>
        <key>ThrottleInterval</key><integer>10</integer>
        <key>StandardOutPath</key><string>\(logPath)</string>
        <key>StandardErrorPath</key><string>\(logPath)</string>
        </dict></plist>
        """
        let cfgData = try! JSONEncoder().encode(cfg)
        return """
        set -e
        mkdir -p '\(supportDir)'
        launchctl bootout system/\(label) 2>/dev/null || true
        install -m 755 -o root -g wheel '\(exe)' '\(supportDir)/MacWake.tmp' && mv -f '\(supportDir)/MacWake.tmp' '\(supportDir)/MacWake'
        xattr -c '\(supportDir)/MacWake' 2>/dev/null || true
        echo '\(cfgData.base64EncodedString())' | base64 -d > '\(configPath)'
        chown root:wheel '\(configPath)'; chmod 600 '\(configPath)'
        echo '\(plist.data(using: .utf8)!.base64EncodedString())' | base64 -d > '\(plistPath)'
        chown root:wheel '\(plistPath)'; chmod 644 '\(plistPath)'
        launchctl bootstrap system '\(plistPath)'
        """
    }

    @objc func uninstall() {
        let r = runAdmin("launchctl bootout system/\(label) 2>/dev/null || true; rm -f '\(plistPath)'; rm -rf '\(supportDir)'")
        if r.ok { try? FileManager.default.removeItem(atPath: Token.path) }
        alert(r.ok ? "MacWake's background service was removed" : "MacWake couldn't remove its background service", r.ok ? "You can now move MacWake to the Trash." : r.out)
    }

    func runAdmin(_ script: String) -> (ok: Bool, out: String) {
        let esc = script.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        var err: NSDictionary?
        let out = NSAppleScript(source: "do shell script \"\(esc)\" with administrator privileges")?.executeAndReturnError(&err)
        return (err == nil, out?.stringValue ?? (err?["NSAppleScriptErrorMessage"] as? String ?? "unknown error"))
    }

    @objc func openConsole() { if let u = URL(string: phoneLink ?? consoleURL) { NSWorkspace.shared.open(u) } }
    @objc func showLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }
    @objc func sleepNow() { sh("/usr/bin/pmset sleepnow") }
}

// MARK: - Entry

// Terminal install, bypasses the setup dialog:  sudo /Applications/MacWake.app/Contents/MacOS/MacWake --install <url> <token>
if let i = CommandLine.arguments.firstIndex(of: "--install") {
    let args = Array(CommandLine.arguments.dropFirst(i + 1))
    guard args.count == 2, args[0].hasPrefix("http") else { print("usage: sudo MacWake --install <console-url> <admin-token>"); exit(2) }
    guard getuid() == 0 else { print("run with sudo"); exit(1) }
    var u = args[0]; while u.hasSuffix("/") { u.removeLast() }
    let r = sh(App.installScript(Config(url: u, token: args[1]), exe: Bundle.main.executablePath!))
    print(r.status == 0 ? "installed: service io.macwake.daemon is running, log at \(logPath)" : "install failed:\n\(r.out)")
    exit(r.status)
}

if CommandLine.arguments.contains("--daemon") {
    guard let data = FileManager.default.contents(atPath: configPath), let cfg = try? JSONDecoder().decode(Config.self, from: data) else {
        log("no config at \(configPath); run MacWake.app and choose Set up"); exit(1)
    }
    Daemon(cfg: cfg).run()
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
// Menu-bar apps have no Edit menu, so Cmd+V would not paste into the setup dialog without this.
let edit = NSMenu(title: "Edit")
for (t, s, k) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] {
    edit.addItem(withTitle: t, action: s, keyEquivalent: k)
}
let mainMenu = NSMenu(); let editItem = NSMenuItem(); editItem.submenu = edit; mainMenu.addItem(editItem); app.mainMenu = mainMenu
app.run()
