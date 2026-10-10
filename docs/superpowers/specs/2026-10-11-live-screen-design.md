# Live screen viewing — design

Date: 2026-10-11
Status: approved in chat, awaiting spec review

## Goal

A paired phone (mobile app) or browser (Next.js console) can watch the Mac's screen live. Today both can only wake
the Mac. Viewing is view-only for now; mouse and keyboard control is planned later, so the transport must carry it.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Purpose | View now, control later: build on WebRTC from the start (video track + data channel). |
| Who can watch | Anyone holding that Mac's token (the existing pairing: QR or paste). Same check as wake. |
| Cost | Fully free. Public STUN by default; optional TURN credentials via env vars (e.g. Metered Open Relay free tier). No paid service is built in. |
| Consent on the Mac | No prompt per session. Viewing starts automatically when a paired viewer presses Watch. The Mac shows only an icon (MacWake menu bar icon becomes an eye; macOS shows its own recording indicator, which we never hide). No MacWake notifications. Menu item "Allow screen viewing", on by default, is the local off switch. |
| Mac WebRTC stack | Approach A: Google's prebuilt WebRTC framework inside the menu-bar app. Rejected: Pion (Go) helper (second language, frame piping), hosted SFU (account + limited free tiers). |
| Console | `console-next/` only. The Cloudflare Worker console (`console/`) stays wake-only. |

## Non-goals (this iteration)

Mouse/keyboard control (data channel is reserved for it), audio, choosing among several displays (main display only),
more than one viewer at a time (newest replaces the current one), the Cloudflare Worker console, recording.

## Hard platform limits (documented, not solved)

- The root LaunchDaemon cannot capture the screen. Capture runs in the menu-bar app in the user's login session, so
  the app must be running (it registers itself as a login item) and a user must be logged in.
- macOS requires the Screen Recording permission once. Setup requests it; the user flips the switch in System
  Settings. macOS 15+ may re-confirm it periodically; no app can suppress that.
- After a wake the Mac usually shows the lock screen; view-only cannot unlock it. The viewer shows "Mac is locked".
- Lid closed with no external display: there is no display to capture. The Mac answers `no-display`.

## Architecture

```
Viewer (web / mobile)              Console (Vercel + Redis)                Mac menu-bar app (user session)
Watch ─ phase != awake → POST /api/wake (existing), show "Waking…"
      ─ GET  /api/screen  → {ice}
      ─ POST /api/screen {id, offer}  → store screenOffer, push "-screen" topic ─→  GET /api/screen → offer
                                                                                  checks, start capture, answer
      ← poll GET /api/screen          ← store screenAnswer  ←───────────────────  POST /api/screen {id, answer|error}
═══════════ direct WebRTC: DTLS-SRTP video (Mac → viewer) + data channel "control" ═══════════
```

Signaling is non-trickle: each side waits until ICE gathering completes (max 3 s) and sends one complete SDP. One
offer, one answer, no candidate exchange.

## Console API (`console-next/lib/logic.js`, action `screen`)

All calls need `Authorization: Bearer <token>` (existing `account()` check), so only paired devices get in. Keys live
under the Mac's scoped prefix and keep the single-writer rule:

- `screenOffer` `{id, sdp, at}` — written by the viewer
- `screenAnswer` `{id, sdp?, error?, at}` — written by the Mac

Requests (one action, body decides):

| Request | Caller | Effect | Reply |
|---|---|---|---|
| `GET /api/screen` | both | read | `{ice, push, offer, answer}`; `offer` is null when older than 60 s |
| `POST /api/screen {id, offer}` | viewer | write `screenOffer`, push to `<topic>-screen` | `{ok: true, ice}` |
| `POST /api/screen {id, answer}` | Mac | write `screenAnswer` | `{ok: true}` |
| `POST /api/screen {id, error}` | Mac | write `screenAnswer` with error code | `{ok: true}` |

Validation (trust boundary): `id` is 16–64 hex chars; `offer`/`answer` are strings of at most 20 000 chars; `error`
is one of `disabled`, `permission`, `no-display`, `failed`. Anything else → 400.

ICE servers (built in the route from env, passed to `handle` via `opts.ice`):

- Always: `stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`
- If set: `TURN_URLS` (comma-separated), `TURN_USERNAME`, `TURN_CREDENTIAL` → one TURN entry. Added to
  `.env.example` with a pointer to Metered Open Relay's free tier.

Push: the existing `poke()` gains a topic suffix so the offer nudges `topicFor(hash) + "-screen"`, which only the
menu-bar app listens on (the daemon's topic is untouched). `push` in the reply tells the menu-bar app which ntfy
server to use; null when `NTFY_URL=off`.

## Mac app

New file `mac/Sources/Screen.swift`, used only by the menu-bar app. `main.swift` changes stay small.

**Trigger.** The menu-bar app checks `GET /api/screen` when:
- a message arrives on its push topic (long-lived `curl -N` stream, same technique as the daemon; the daemon's
  listener loop is factored into a shared free function used by both),
- the app launches, and 5 s after `NSWorkspace.didWakeNotification`,
- every 10 s while awake, only when the console reports no push server.

**Answering an offer.** When `offer.id` is new and the offer is at most 60 s old:
1. Remember `offer.id` so it is answered once.
2. Refuse with an error answer if "Allow screen viewing" is off (`disabled`), if `CGPreflightScreenCaptureAccess()` is
   false (`permission`), or if ScreenCaptureKit lists no display (`no-display`). Any other setup failure → `failed`.
3. Close any current session (newest viewer wins).
4. Create the peer connection (`RTCDefaultVideoEncoderFactory`, hardware H.264), set the remote offer, add a send-only
   video track fed by an `SCStream` on the main display (long edge capped at 1920 px, up to 30 fps, cursor shown;
   only `complete` frames are forwarded as `RTCCVPixelBuffer`), create the answer, gather ICE (≤ 3 s), POST it.

**While a viewer is connected.**
- Hold `PreventUserIdleDisplaySleep` + `PreventUserIdleSystemSleep` so capture never goes black; release on disconnect.
  The daemon's sleep/lid logic is unchanged.
- Menu bar icon switches to an eye symbol.
- Over the viewer-created data channel `control`, send `{"locked": true|false}` on change (polled once a second from
  `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]`). Incoming messages are ignored for now.

**Ending.** Peer connection `closed`, `failed`, or `disconnected` for more than 10 s → stop the stream, close the
connection, drop the assertions, restore the icon.

**Menu and setup.**
- "Allow screen viewing" (checkmark, `UserDefaults` key `screenViewing`, default on).
- "New token (unpair all phones)…": deletes the saved token and runs the existing setup flow, which generates and
  registers a new token, reinstalls the daemon config (one admin password prompt) and shows the new pairing code.
- Setup additionally calls `CGRequestScreenCaptureAccess()` and `SMAppService.mainApp.register()`.

## Mac packaging (`mac/build.sh`)

- Download a pinned `WebRTC.xcframework` release (universal macOS slice) into `mac/vendor/` (gitignored), verify its
  SHA-256 recorded in `build.sh`, and embed `WebRTC.framework` in `MacWake.app/Contents/Frameworks`.
- Link with `-weak_framework WebRTC` and rpath `@executable_path/../Frameworks`, plus `ScreenCaptureKit` and
  `ServiceManagement`. The daemon is a lone copy of the same binary without the framework next to it; weak linking lets
  it start, and it never touches WebRTC code. A plan step verifies the installed daemon still launches.
- Stable signing so Screen Recording survives updates: `tools/make-signing-cert.sh` (run once by the user) creates a
  free self-signed code-signing identity "MacWake Local Signing" in the login keychain. `build.sh` signs the framework
  and app with it when present, else falls back to ad-hoc signing and prints a warning that the permission resets on
  every build.

## Web console (`console-next/app`)

- "Watch screen" button on the main screen.
- Full-screen viewer overlay (new `app/Viewer.js`): `<video autoPlay playsInline muted>` with `object-fit: contain`,
  close button, status line and the error messages below. Uses the existing `call()` helper for API requests.
- Flow: if `phase !== "awake"` send wake; `GET /api/screen` for ICE; create `RTCPeerConnection`, `recvonly` video
  transceiver, data channel `control`; offer, gather, POST; poll every 700 ms for `answer.id === id`.

## Mobile app (`mobile/`)

- Add `react-native-webrtc` (iOS + Android). `pod install` with `LANG=en_US.UTF-8`; restart Metro after adding.
- "Watch screen" button on the main screen; new `src/Viewer.tsx` full-screen view with `RTCView`
  (`objectFit="contain"`). iOS wraps it in a `ScrollView` with pinch-zoom (max 4×); Android shows it fitted.
- Same flow as the web console. Pure pieces (error-code → message, answer matching, wait/timeout decisions) live in
  `src/core.ts` with checks in `src/core.check.ts`.
- Risk: `react-native-webrtc` on RN 0.87 with the new architecture is unproven. It is the first plan task (install,
  build, connect on the iOS simulator). Fallback if it fails: render the console's web viewer in a WebView.

## Viewer states and errors (web and mobile, same text)

| State | Trigger | Message |
|---|---|---|
| Waking | phase is `requested` | "Waking your Mac…" (re-posts the offer once phase becomes `awake`) |
| Connecting | offer posted | "Connecting…" |
| Live | track received | video |
| Locked | data channel `locked: true` | overlay "Mac is locked" |
| `disabled` | Mac answer | "Screen viewing is turned off on the Mac." |
| `permission` | Mac answer | "MacWake needs Screen Recording permission on the Mac (System Settings → Privacy & Security → Screen Recording)." |
| `no-display` | Mac answer | "The Mac's screen is off (lid closed, no external display)." |
| `failed` | Mac answer | "The Mac couldn't start sharing its screen. Try again." |
| Timeout | phase `awake`, no answer in 20 s | "The Mac didn't answer. Check that MacWake is running and someone is logged in." |
| ICE failed | `connectionState === "failed"` | "Couldn't connect directly to the Mac. Add a free TURN relay to the console (see README)." |
| Lost | connected, then `disconnected` > 10 s | "Connection lost." + Retry |

## Security

- Only token holders can signal; the Mac only answers the newest offer, at most 60 s old.
- Media is end-to-end encrypted (DTLS-SRTP). The console and Redis store only SDP (which includes IP addresses); a TURN
  relay sees only encrypted packets.
- SDP size cap (20 000 chars) and strict id/error validation in the console.
- The token is now as sensitive as a screen-sharing password: README says so, and "New token (unpair all phones)…"
  revokes every paired device.
- Local off switch ("Allow screen viewing"); macOS's recording indicator is never hidden.

## Testing

- `console-next/test.mjs`: offer/answer round trip, answer matching by id, 60 s offer expiry, size and id
  validation, unauthorized request rejected, push suffix used for offers, ICE list with and without TURN env.
- `mobile/src/core.check.ts`: error-code messages, answer matching, timeout decision.
- End to end (local loop): console-next on :3003 with a scratch state file and `NTFY_URL=off`; Mac app built with
  that console URL; viewers in the browser pane and the iOS simulator. One manual step for the user: grant Screen
  Recording in System Settings. Proof: screenshots of the live screen in both viewers.
- Cellular / TURN: manual by the user on a real phone.

## Docs

Root `README.md` (feature, limits, token warning), `console-next/README.md` (route table, TURN env vars),
`mobile/README.md` (new dependency, viewer), `console-next/.env.example` (TURN vars).
