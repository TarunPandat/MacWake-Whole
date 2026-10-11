# Remote mouse and keyboard control — design

Date: 2026-10-11. Builds on [live screen](2026-10-11-live-screen-design.md), which reserved the WebRTC data
channel `control` for this.

## Goal

While watching the Mac's screen, the owner can control it: click, scroll, drag, right-click, type text and use
shortcuts. Works from the iPhone/iPad app, from phone and tablet browsers, and from computer browsers (real mouse
and keyboard). Free, no new server, no per-session prompt on the Mac.

## Decisions

| Topic | Decision |
|-------|----------|
| Touch | Two modes with a switch: **Direct** (default, tap where you want to click) and **Trackpad** (finger moves the pointer). |
| Keyboard (app) | Phone keyboard for text + a **Mac keys row** (esc, tab, sticky ⌘ ⌥ ⌃ ⇧, arrows). iPad hardware keyboards (Magic Keyboard etc.) send every key directly. |
| Web console | Full parity: computers use the real mouse/keyboard; touch browsers get both modes and the keys row. |
| Mac consent | Setup asks once for **Accessibility** (next to Screen Recording). Then control is on whenever someone watches. Menu item **Allow remote control** (default on) turns it off. Menu-bar icon changes while input arrives. |
| Where logic lives | Viewer turns gestures into plain mouse/keyboard events (pure, tested JS); the Mac only injects them. |
| Server | Unchanged. Input goes peer to peer over the existing DTLS-encrypted data channel. |
| Displays | Main display only (the one being captured). |
| Android app | Touch modes, keys row and phone keyboard work (shared RN code). No hardware-keyboard capture, no pinch zoom (as today). |

Not doing: clipboard sync, file transfer, audio, multi-display, Android hardware keyboards, remembering the chosen
mode between sessions (Direct every time).

## Wire format

JSON text messages on the existing `control` channel (reliable, ordered). Positions are fractions (0–1) of the
captured screen, so resolution and zoom never matter.

Viewer → Mac:

| Message | Meaning |
|---------|---------|
| `{"m":[x,y]}` | Pointer to a spot (fractions). |
| `{"r":[dx,dy]}` | Pointer moves by fractions of the screen size (trackpad). |
| `{"b":0,"d":1}` / `{"b":0,"d":0}` | Button down / up at the pointer. `b`: 0 left, 1 right. |
| `{"s":[dx,dy]}` | Scroll in Mac points, browser `WheelEvent` sign: positive `dy` scrolls down. |
| `{"k":"KeyA","d":1}` / `"d":0` | Key down / up. Names are the browser's `KeyboardEvent.code` (physical keys): `KeyA`, `Digit1`, `Enter`, `ArrowLeft`, `MetaLeft`, `ShiftRight`, `F5`… |
| `{"t":"héllo 👋"}` | Type this text (phone keyboard, any language). |

Mac → viewer:

| Message | Meaning |
|---------|---------|
| `{"locked":bool}` | Unchanged. |
| `{"control":"ok"\|"off"\|"permission","size":[w,h]}` | On channel open and on every change. `size` is the screen in points (for aspect ratio). |

The viewer shows control UI only after `"control":"ok"`. A Mac app from before this change never sends it, so that
viewer stays view-only with no errors. Moves are coalesced to one per animation frame.

## Mac (`mac/Sources/Control.swift`, menu-bar app only)

- `Injector` owns one `CGEventSource(.hidSystemState)` and posts at `.cghidEventTap`. It knows the captured display
  (`CGDisplayBounds(displayID)`, global points) and clamps every position to it.
- Mouse: tracks the pointer and held buttons; a move while a button is down posts `leftMouseDragged` /
  `rightMouseDragged`. Click count (`mouseEventClickState`) increments when the same button goes down again within
  `NSEvent.doubleClickInterval` and 4 pt, so double-click and triple-click work from plain taps.
- Scroll: `scrollWheelEvent2` in pixel units, `wheel1 = -dy`, `wheel2 = -dx`. Direction to be confirmed on a real Mac
  (natural scrolling may or may not apply to synthetic events).
- Keys: a `code → kVK` table (letters, digits, punctuation, F1–F12, arrows, navigation, modifiers). Held modifiers are
  tracked and set as `flags` on every key and mouse event, so ⌘-click and ⌘C work. Unknown codes are ignored.
- Text: key down/up with `keyboardSetUnicodeString`, chunks of at most 20 UTF-16 units.
- Safety: on channel close or session stop, release every held key and button. Malformed messages are ignored.
  Nothing is injected unless Accessibility is granted and **Allow remote control** is on.
- `ViewSession` hands data-channel messages to the injector and sends the `control` status on open, when the menu
  toggle changes, and when Accessibility is granted mid-session (checked with the existing 1 s timer).
- Permission: `AXIsProcessTrustedWithOptions(prompt: true)` in setup next to `CGRequestScreenCaptureAccess()`, and
  again on the first control message if still missing (status `"permission"`). The stable signing key from
  `build.sh` keeps the grant across updates.
- Menu: **Allow remote control** (UserDefaults `remoteControl`, default true) under **Allow screen viewing**.
- Icon: `eye` while watched (unchanged); `cursorarrow.motionlines` while input arrived in the last 5 s, with
  accessibility text "MacWake: someone is controlling this Mac".
- Lock screen: checked in the live test (the owner locks the Mac and types the password from the viewer). If it
  unlocks, the viewer's locked notice becomes "Mac is locked. Type your password to unlock." Otherwise it stays.
- Version 1.6.

## Viewer logic (`console-next/lib/control.js`, mirrored in `mobile/src/control.ts`)

Pure, no DOM/React/native. Keep the two files' behavior and text identical, like `screen.js` ↔ `core.ts`.

`createGestures({ mode, now })` is a small state machine. The platform feeds `down(id, x, y, t)`,
`move(id, x, y, t)`, `up(id, t)`, `cancel()` and `tick(t)` with positions in on-screen px inside the picture plus the
picture size `{w, h}`; every call returns the wire messages to send.

Thresholds: tap slop 10 px, long press 500 ms, two-finger tap < 300 ms with < 10 px movement.

| Gesture | Direct | Trackpad |
|---------|--------|----------|
| Tap | `m` there + left click | left click at pointer |
| Double tap | double click (Mac counts clicks) | same |
| One-finger drag | `m` to start, then scroll (content follows finger) | `r` moves pointer, gain 1.5, ×2 above 0.8 px/ms |
| Long press, release | right click there | right click at pointer |
| Long press, then drag | left down there, `m` while moving, up on release (drag / select) | left down at pointer, `r` while moving, up on release |
| Two-finger drag | not handled (iOS: pinch/pan zoom the picture) | scroll |
| Two-finger tap | not handled | right click |

`cancel()` (for example iOS zoom taking over) releases a held button.

Other pure helpers, all tested:

- `fraction(x, y, box, size)`: px in the element to screen fractions, accounting for `object-fit: contain`
  letterboxing using the Mac's `size`. Returns null outside the picture.
- `wheel(e)`: `WheelEvent` deltas to points (line mode ×16, page mode ×screen height).
- `mouseButton(button)`: browser 0/2 to wire 0/1, others null.
- `charToCode(ch)`: US-layout char to `{code, shift}` (a–z, 0–9, punctuation, space, newline → Enter). Used when a
  sticky modifier is latched, so ⌘ + typed "c" goes out as ⌘ `KeyC` instead of text.
- `hidToCode(usage)` (mobile only): iOS HID usage to `KeyboardEvent.code`.
- `Modifiers`: sticky ⌘ ⌥ ⌃ ⇧ from the keys row. A tap latches a modifier; it is pressed around the next key or
  typed character, then released. A second tap unlatches it.
- `CONTROL_MESSAGES`: `off` "Remote control is turned off on the Mac.", `permission` "To control the Mac, allow
  MacWake under System Settings → Privacy & Security → Accessibility on the Mac."

## Web console (`console-next/app/Viewer.js`, `app/Controls.js`, `globals.css`)

- Keeps the existing `control` channel object and reads `control` messages next to `locked`.
- Mouse (`pointerType === "mouse"`): move → `m` (coalesced per frame), buttons → `b`, wheel → `s` (passive: false,
  preventDefault), context menu suppressed. Keyboard: `keydown`/`keyup` on window → `k` with `e.code`,
  preventDefault, except key presses on the viewer's own buttons; Shift+Escape moves focus to Close (no keyboard trap). Browsers keep ⌘W, ⌘T, ⌘N, ⌘Q, ⌘Tab for themselves; the keys row covers those on touch devices.
  On window blur, send key-up for every key still held.
- Touch/pen: pointer events into the gesture machine, `touch-action: none` on the picture.
- Control bar, touch devices only (`(pointer: coarse)`): Direct / Trackpad switch, keyboard button, Close. Fades like
  today. The keyboard button focuses a hidden `<input>` (autocorrect, autocapitalize and spellcheck off);
  `beforeinput` `insertText` → `t` (or `k` via `charToCode` while a modifier is latched), `deleteContentBackward` →
  Backspace, `insertLineBreak` / Enter → Enter. The keys row sits above the keyboard while it is open.
- `control` `off` / `permission` show the message in the bar area, without blocking the picture.

## App (`mobile/src/Viewer.tsx`, `mobile/src/Controls.tsx`)

- Same channel handling and control bar as the web, built from RN core (`PanResponder`, `TextInput`, `Pressable`). No
  new JS dependencies.
- Direct mode on iOS keeps pinch zoom: the `ScrollView` gets `scrollEnabled={false}` so one finger goes to the
  gesture machine while two fingers pinch and pan natively. When the native pinch takes over, the responder is
  terminated and the machine gets `cancel()`. Touch positions use `locationX/Y` inside the picture view, which are in
  unzoomed coordinates. Trackpad mode resets zoom to 1 and turns zooming off.
- Phone keyboard: hidden `TextInput` (autoCorrect, spellCheck, autoCapitalize off, `smartInsertDelete={false}`) kept
  at a one-space sentinel so Backspace is always seen; `onKeyPress` Backspace/Enter → `k`, inserted text → `t`.
- iPad hardware keyboard: native module `HardwareKeys` (`mobile/ios/MacWake/HardwareKeys.swift` + `.m`). While the
  viewer is open, a hidden `UIView` holds first responder and overrides `pressesBegan`/`pressesEnded`, so every key's
  HID usage and up/down reaches it (documented UIKit, no focus guessing). Emits `{usage, down}`; JS maps with
  `hidToCode` and sends `k`. `GCKeyboard.coalesced` only answers "is a keyboard attached" (`keyboard` event). When the
  phone-keyboard input takes focus it becomes first responder instead; on blur the catcher takes it back. When a
  hardware keyboard is attached, **Keys** shows only the keys row (for ⌘Tab, ⌘Space and other shortcuts iPadOS keeps).
- Android: no `HardwareKeys`; everything else works.

## Errors and states

| State | Viewer shows |
|-------|--------------|
| No `control` message (old Mac app) | View-only, no control UI. |
| `control: off` | "Remote control is turned off on the Mac." in the bar; picture stays. |
| `control: permission` | Accessibility message in the bar; picture stays. |
| Locked | Existing notice (wording depends on the lock-screen probe). |
| Connection lost | Unchanged; the Mac releases held keys and buttons. |

## Security

The token already opens the screen; now it also controls the Mac. README and console say so next to "New token
(unpair all phones)…". Control needs the Mac owner's explicit Accessibility grant, the menu toggle turns it off,
macOS shows its recording indicator, and the menu-bar icon changes while input arrives. The console never sees
input.

## Testing

- `console-next/test.mjs` and `mobile/src/control.check.ts` (added to `npm run test:core`): every row of the gesture
  table in both modes, cancel, thresholds, `fraction` letterboxing, `wheel`, `mouseButton`, `charToCode`,
  `Modifiers`, `hidToCode`.
- Mac: manual, with `--screen-test` against the isolated local console on :3003 and the web viewer in the browser
  pane. Injection moves the real pointer on this Mac, so live runs only with the owner's go-ahead.
- iOS: simulator for UI and soft keyboard; a real iPad with a Magic Keyboard for `HardwareKeys`.

## Order

1. Shared logic + tests (web, then mobile mirror).
2. Mac injector, permission, menu, icon.
3. Web viewer UI.
4. App viewer UI + `HardwareKeys`.
5. Live test on this Mac with the owner (includes the lock-screen check).
6. READMEs, CLAUDE.md, version 1.6 build; website copy after.
