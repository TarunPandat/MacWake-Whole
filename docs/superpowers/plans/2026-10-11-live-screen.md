# Live Screen Viewing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paired phones (mobile app) and browsers (Next.js console) can watch the Mac's screen live over WebRTC, view-only, with a data channel ready for control later.

**Architecture:** The console (`console-next`) relays one WebRTC offer (viewer) and one answer (Mac) through Redis, nudging the Mac's menu-bar app over the existing ntfy push relay. The menu-bar app captures the main display with ScreenCaptureKit and streams it with Google's prebuilt WebRTC framework straight to the viewer (DTLS-SRTP). Viewers use the browser's WebRTC (console) or `react-native-webrtc` (mobile).

**Tech Stack:** Next.js 16 / React 19 (console), Swift 5 + AppKit + ScreenCaptureKit + WebRTC.framework M153 (Mac, built with `swiftc` in `mac/build.sh`), React Native 0.87 new architecture + `react-native-webrtc` 124.0.8 (mobile).

**Spec:** `docs/superpowers/specs/2026-10-11-live-screen-design.md`

## Global Constraints

- Fully free: no paid service. STUN `stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302`; optional TURN only from env `TURN_URLS` (comma-separated), `TURN_USERNAME`, `TURN_CREDENTIAL`.
- Who can watch: any holder of the Mac's token; every `/api/screen` call goes through the existing `account()` bearer check.
- No per-session consent and no MacWake notifications/pop-ups while viewing. The menu bar icon becomes an eye (`eye`) while a viewer is connected; macOS's own recording indicator is never hidden. Menu item "Allow screen viewing" (UserDefaults `screenViewing`, default on).
- Limits (exact): offer TTL 60 s; viewer waits 20 s for an answer; ICE gathering ≤ 3 s (non-trickle); viewer polls every 700 ms; Mac ends a session 10 s after `disconnected`, or 30 s after start if never connected; SDP ≤ 20 000 chars; offer id 16–64 lowercase hex; Mac error codes exactly `disabled`, `permission`, `no-display`, `failed`.
- Capture: main display only, long edge ≤ 1920 px, up to 30 fps, cursor shown. One viewer at a time; the newest offer replaces the current session.
- Console keys (scoped per Mac): `screenOffer` `{id, sdp, at}` written only by the viewer; `screenAnswer` `{id, sdp?, error?, at}` written only by the Mac. Push topic for the menu-bar app: `topicFor(hash) + "-screen"`.
- Viewer copy, identical on web and mobile: `SCREEN_MESSAGES` in Task 3 (web) and Task 8 (mobile).
- macOS minimum stays 13.0. WebRTC: `https://github.com/stasel/WebRTC/releases/download/153.0.0/WebRTC-M153.xcframework.zip`, SHA-256 `3e3a8946f27510133e3feed04d05fa23505bbe366e977620503bfc7986c2b78f`.
- `react-native-webrtc@124.0.8` exactly.
- `console-next/` is its own git repository (a gitlink in the parent). Commit console changes inside it on branch `feat/live-screen`, then commit the gitlink bump in the parent (branch `feat/live-screen`, already created).
- Dev loop: `.claude/launch.json` config `macwake-console-test` (port 3003, `NTFY_URL=off`, scratch state file). Never touch `console-next/.data/state.json` (the user's real pairing).
- Scratch dir for test tokens and probes: `SCRATCH=/private/tmp/claude-501/-Users-tarunbhardwaj-Desktop-projects-Mac-Remote/031fd809-eb04-4f6f-a800-8907f17bbba8/scratchpad`.
- `mac/dist/` is tracked in git with `MacWakeConsoleURL=https://mac-wake-console.vercel.app` baked in. Do not commit `mac/dist` until Task 9, which rebuilds it with that URL.
- Commit messages: sentence case like the repo history ("Pair any Mac without a token…"), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- USER STEPS are things only the user may do (grant Screen Recording, enter passwords, change keychain trust). Ask, wait, then continue.
- The Bash tool blocks foreground `sleep`; wait with the Monitor tool or repeated checks.

## Review Focus

1. Still screen: a viewer connects while nothing on the Mac moves → a picture appears within about a second (last frame repeated every 0.5 s). Pinned in Task 6 Step 10.
2. Viewer vanishes without closing (tab killed, phone locked, network gone) → the Mac ends the session, releases its keep-awake assertions and restores the icon within ~20 s. Pinned in Task 6 Step 11.
3. A second viewer presses Watch while one is watching → the newest takes over; the first shows "Connection lost." Pinned in Task 6 Step 12.
4. Screen Recording not granted (fresh install, or an ad-hoc rebuild reset it) → the viewer shows the permission message right away, not a 20 s timeout. Pinned in Task 5 Step 8.
5. The Mac stops mid-session (sleep, lid, app quit) → the viewer shows "Connection lost." with Try again instead of a frozen frame forever. Pinned in Task 6 Step 13.

---

### Task 1: Prove `react-native-webrtc` works on RN 0.87 (gate)

The spec's biggest risk. If this fails, STOP and report to the user: the fallback (web viewer inside a WebView) needs their go-ahead.

**Files:**
- Modify: `mobile/package.json`, `mobile/package-lock.json`, `mobile/ios/Podfile.lock`
- Temporary (reverted in Step 5): `mobile/App.tsx`

**Interfaces:**
- Produces: `react-native-webrtc` installed and linked (iOS pods, Android autolinking) for Task 8.

- [ ] **Step 1: Install the dependency**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mobile" && npm install --save-exact react-native-webrtc@124.0.8
cd ios && LANG=en_US.UTF-8 pod install
```
Expected: `npm` adds `"react-native-webrtc": "124.0.8"`; `pod install` ends with "Pod installation complete!" and lists `react-native-webrtc` plus its WebRTC pod.

- [ ] **Step 2: Add a temporary probe**

In `mobile/App.tsx`, add the import below the `react-native-keychain` import and the effect as the first statement inside `Root()`:

```tsx
import { RTCPeerConnection } from 'react-native-webrtc';
```

```tsx
  useEffect(() => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.createDataChannel('control');
    pc.createOffer({}).then(
      o => console.log('WEBRTC PROBE ok', o.sdp?.includes('m=video'), o.sdp?.includes('m=application')),
      e => console.log('WEBRTC PROBE fail', e),
    );
    return () => pc.close();
  }, []);
```

- [ ] **Step 3: Build and run on the iOS simulator**

Restart Metro (it must pick up the new native package): stop any running Metro, then in a terminal tab run `cd mobile && npm start -- --reset-cache`. Build and launch with the iOS Simulator build tool (or `npx react-native run-ios`).
Expected: the app launches without a red screen, and Metro's log shows `WEBRTC PROBE ok true true`.
If the build fails, the app crashes on launch, or the log shows `WEBRTC PROBE fail`: STOP, revert (`git checkout mobile && cd mobile && npm install && cd ios && LANG=en_US.UTF-8 pod install`), and report the exact error to the user with the WebView fallback as the proposed next step.

- [ ] **Step 4: Android compile check (if the SDK exists)**

Run: `echo "ANDROID_HOME=$ANDROID_HOME"; cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mobile/android" && ./gradlew assembleDebug -q`
Expected: if `ANDROID_HOME` is empty, skip the gradle part and note "Android not checked (no SDK)". Otherwise BUILD SUCCESSFUL.

- [ ] **Step 5: Remove the probe and commit the dependency**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && git checkout mobile/App.tsx
git add mobile/package.json mobile/package-lock.json mobile/ios/Podfile.lock
git commit -m "Add react-native-webrtc for live screen viewing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Console signaling API (`screen` action)

**Files:**
- Modify: `console-next/lib/logic.js` (header comment, `poke`, new `iceServers`/`screen`, `handle` switch)
- Modify: `console-next/app/api/[action]/route.js`
- Modify: `console-next/test.mjs`
- Modify: `console-next/.env.example`, `console-next/README.md`

**Interfaces:**
- Produces (HTTP, all with `Authorization: Bearer <token>`):
  - `GET /api/screen` → `200 {ice: IceServer[], push: string|null, offer: {id, sdp, at}|null, answer: {id, sdp?, error?, at}|null}`; `offer` is null when older than 60 s.
  - `POST /api/screen {id, offer}` → `200 {ok: true, ice}`, pushes `<topic>-screen`.
  - `POST /api/screen {id, answer}` or `{id, error}` → `200 {ok: true}`.
  - Bad input → `400 {error}`.
- Produces (JS): `export const OFFER_TTL = 60e3`, `export function iceServers(env) → IceServer[]`.
- `IceServer` = `{urls: string[], username?: string, credential?: string}`.

- [ ] **Step 1: Branch the console repo**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && git status --short && git switch -c feat/live-screen
```
Expected: clean status (stop and ask the user if not), then "Switched to a new branch 'feat/live-screen'".

- [ ] **Step 2: Write the failing tests**

In `console-next/test.mjs`, change the first import to:

```js
import { account, handle, iceServers, OFFER_TTL, register, topicFor } from "./lib/logic.js";
```

Insert this block immediately before the line `console.log("ok");`:

```js
// Live screen signaling: the viewer writes the offer, the Mac writes the answer; nothing leaks across Macs.
const ID = "ab".repeat(16), ID2 = "cd".repeat(16), ICE = [{ urls: ["stun:example"] }];
const scr = (body, now = Date.now()) => handle("screen", body, m1.kv, now, { ice: ICE });
const noAt = o => o && Object.fromEntries(Object.entries(o).filter(([k]) => k !== "at"));
eq((await scr({})).body, { ice: ICE, push: null, offer: null, answer: null }, "nothing pending");
eq((await scr({ id: ID, offer: "v=0 offer" })).body, { ok: true, ice: ICE }, "viewer posts an offer and gets the ICE servers");
eq(noAt((await scr({})).body.offer), { id: ID, sdp: "v=0 offer" }, "Mac reads the offer");
eq((await scr({ id: ID, answer: "v=0 answer" })).body, { ok: true }, "Mac answers");
eq(noAt((await scr({})).body.answer), { id: ID, sdp: "v=0 answer" }, "viewer reads the answer");
eq((await scr({ id: ID2, error: "permission" })).status, 200, "Mac can refuse with a known code");
eq(noAt((await scr({})).body.answer), { id: ID2, error: "permission" }, "a refusal replaces the answer");
eq((await scr({}, Date.now() + OFFER_TTL + 1e3)).body.offer, null, "offers expire after 60 s");
eq((await handle("screen", {}, m2.kv, Date.now(), {})).body.offer, null, "another Mac never sees the offer");
for (const [body, why] of [
  [{ id: "xyz", offer: "v=0" }, "id must be hex"],
  [{ id: "ab", offer: "v=0" }, "id too short"],
  [{ offer: "v=0" }, "id missing"],
  [{ id: ID, offer: "" }, "empty offer"],
  [{ id: ID, offer: "x".repeat(20001) }, "offer over 20000 chars"],
  [{ id: ID, answer: 5 }, "answer must be text"],
  [{ id: ID, error: "boom" }, "unknown error code"],
  [{ id: ID, offer: "v=0", answer: "v=0" }, "offer and answer together"],
]) eq((await scr(body)).status, 400, why);
eq(iceServers({}), [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }], "free STUN only by default");
eq(iceServers({ TURN_URLS: "turn:relay:80, turns:relay:443", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" })[1],
  { urls: ["turn:relay:80", "turns:relay:443"], username: "u", credential: "p" }, "TURN from env");
```

Replace the push test tail:

```js
await handle("wake", {}, m1.kv, Date.now(), { push, hashes: m1.hashes });
srv.close();
eq(got, ["/" + topicFor(sha(T1))], "wake pushed to that Mac's topic only");
```

with:

```js
await handle("wake", {}, m1.kv, Date.now(), { push, hashes: m1.hashes });
await handle("screen", { id: "ab".repeat(16), offer: "v=0" }, m1.kv, Date.now(), { push, hashes: m1.hashes });
srv.close();
eq(got, ["/" + topicFor(sha(T1)), "/" + topicFor(sha(T1)) + "-screen"], "wake pushes the daemon's topic, an offer the menu-bar app's");
```

(Unauthorized access is already pinned by the existing `account()` tests: every action, `screen` included, goes through it in the route.)

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && npm test`
Expected: FAIL with `SyntaxError: The requested module './lib/logic.js' does not provide an export named 'iceServers'`.

- [ ] **Step 4: Implement in `lib/logic.js`**

Add to the key list in the header comment (after the `settings` line):

```js
//   screenOffer  {id, sdp, at}                                 written by a viewer (live screen)
//   screenAnswer {id, sdp?, error?, at}                        written by the Mac's menu-bar app
```

Replace `poke`:

```js
/** Nudge the Mac over the push relay (ntfy) so it checks in within seconds instead of at its next timer. */
async function poke({ push, hashes = [] }) {
  if (!push) return;
  await Promise.all(hashes.map(h =>
    fetch(`${push}/${topicFor(h)}`, { method: "POST", body: "wake", signal: AbortSignal.timeout(3000) }).catch(() => {})));
}
```

with:

```js
/** Nudge the Mac over the push relay (ntfy). The daemon listens on the bare topic, the menu-bar app on "-screen". */
async function poke({ push, hashes = [] }, suffix = "") {
  if (!push) return;
  await Promise.all(hashes.map(h =>
    fetch(`${push}/${topicFor(h)}${suffix}`, { method: "POST", body: "wake", signal: AbortSignal.timeout(3000) }).catch(() => {})));
}
```

Insert after the `state()` function:

```js
// Live screen: WebRTC signaling through the console. The viewer writes screenOffer, the Mac writes screenAnswer
// (one writer each); the video itself flows straight from the Mac to the viewer.
export const OFFER_TTL = 60e3;
const SCREEN_ERRORS = ["disabled", "permission", "no-display", "failed"];
const isId = v => typeof v === "string" && /^[0-9a-f]{16,64}$/.test(v);
const isSdp = v => typeof v === "string" && v.length > 0 && v.length <= 20000;
const bad = error => ({ status: 400, body: { error } });

/** Free STUN always; one TURN entry when TURN_URLS is set (e.g. Metered's free Open Relay). */
export function iceServers(env) {
  const ice = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const turn = (env.TURN_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (turn.length) ice.push({ urls: turn, username: env.TURN_USERNAME || "", credential: env.TURN_CREDENTIAL || "" });
  return ice;
}

async function screen(body, kv, now, opts) {
  const ice = opts.ice || [];
  const given = ["offer", "answer", "error"].filter(k => body[k] !== undefined);
  if (!given.length) {
    const [offer, answer] = await Promise.all([get(kv, "screenOffer", null), get(kv, "screenAnswer", null)]);
    return { status: 200, body: { ice, push: opts.push || null, offer: offer && now - offer.at <= OFFER_TTL ? offer : null, answer } };
  }
  if (given.length > 1) return bad("send one of offer, answer or error");
  if (!isId(body.id)) return bad("id must be 16 to 64 hex characters");
  if (body.offer !== undefined) {
    if (!isSdp(body.offer)) return bad("offer must be 1 to 20000 characters");
    await put(kv, "screenOffer", { id: body.id, sdp: body.offer, at: now });
    await poke(opts, "-screen");   // wakes the menu-bar app's listener, not the daemon
    return { status: 200, body: { ok: true, ice } };
  }
  if (body.answer !== undefined && !isSdp(body.answer)) return bad("answer must be 1 to 20000 characters");
  if (body.error !== undefined && !SCREEN_ERRORS.includes(body.error)) return bad("unknown error");
  await put(kv, "screenAnswer", body.answer !== undefined ? { id: body.id, sdp: body.answer, at: now } : { id: body.id, error: body.error, at: now });
  return { status: 200, body: { ok: true } };
}
```

In `handle`, add a case before `case "heartbeat":`:

```js
    case "screen":
      return screen(body, kv, now, opts);
```

Update the `handle` doc line that starts `/** opts: {push, hashes}:` to:

```js
/** opts: {push, hashes, ice}: push is the ntfy server URL (null skips pushes), hashes the topics to nudge (from account), ice the WebRTC servers. */
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && npm test`
Expected: prints `ok` then `push ok`, exit 0.

- [ ] **Step 6: Wire the route**

In `console-next/app/api/[action]/route.js` change the import and the `handle` call:

```js
import { account, handle, iceServers, register } from "../../../lib/logic.js";
```

```js
  const { status, body: out } = await handle(action, body, acct.kv, Date.now(), { push, hashes: acct.hashes, ice: iceServers(process.env) });
```

- [ ] **Step 7: Document the env vars and route**

Append to `console-next/.env.example`:

```bash

# Optional TURN relay for live screen viewing when a network blocks direct connections (some cellular carriers).
# Free: Metered Open Relay (https://metered.ca/tools/openrelay/, 20 GB/month, no card). Comma-separate several URLs.
TURN_URLS=
TURN_USERNAME=
TURN_CREDENTIAL=
```

In `console-next/README.md`, add a table row after the `POST /api/register` row:

```markdown
| `GET/POST /api/screen` | console, Mac app | live screen signaling: a viewer posts a WebRTC offer, the Mac's menu-bar app answers |
```

and add this paragraph after the "**Instant wake.**" paragraph:

```markdown
**Live screen.** "Watch screen" shows the Mac's screen live (view-only). The console only relays one WebRTC offer and one answer per session; the video goes straight from the Mac to your phone, encrypted. Direct connections use free public STUN and work on most Wi-Fi. If a network (some cellular carriers) can't connect directly, set `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` from a free TURN account such as Metered Open Relay. The Mac needs MacWake's menu-bar app running and Screen Recording allowed.
```

- [ ] **Step 8: Commit (console repo)**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && git add lib/logic.js "app/api/[action]/route.js" test.mjs .env.example README.md
git commit -m "Relay live screen offers and answers between viewers and the Mac

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Viewer decision logic (`lib/screen.js`)

Pure functions the web viewer uses; Task 8 mirrors them in `mobile/src/core.ts` with the same text.

**Files:**
- Create: `console-next/lib/screen.js`
- Modify: `console-next/test.mjs`

**Interfaces:**
- Produces:
  - `SCREEN_MESSAGES: {disabled, permission, 'no-display', failed, timeout, ice, lost}` (strings)
  - `ANSWER_WAIT = 20e3`
  - `afterPoll(answer, id, waited, phase) → {kind:'answer', sdp} | {kind:'error', error} | {kind:'wait'} | {kind:'reoffer'}`
  - `needsWake(phase) → boolean`
  - `newId() → string` (32 hex)

- [ ] **Step 1: Write the failing tests**

Append to `console-next/test.mjs`:

```js
// Viewer decisions (mirrored in mobile/src/core.ts).
const { afterPoll, needsWake, newId, SCREEN_MESSAGES } = await import("./lib/screen.js");
eq(afterPoll(null, "a", 1000, "awake"), { kind: "wait" }, "no answer yet");
eq(afterPoll({ id: "b", sdp: "x", at: 0 }, "a", 1000, "awake"), { kind: "wait" }, "an answer to another offer is ignored");
eq(afterPoll({ id: "a", sdp: "x", at: 0 }, "a", 1000, "awake"), { kind: "answer", sdp: "x" }, "answer");
eq(afterPoll({ id: "a", error: "permission", at: 0 }, "a", 1000, "awake"), { kind: "error", error: "permission" }, "Mac refused");
eq(afterPoll({ id: "a", error: "weird", at: 0 }, "a", 1000, "awake"), { kind: "error", error: "failed" }, "unknown code reads as failed");
eq(afterPoll(null, "a", 20000, "requested"), { kind: "reoffer" }, "Mac still waking: offer again");
eq(afterPoll(null, "a", 20000, "awake"), { kind: "error", error: "timeout" }, "awake but silent");
eq(["idle", "done", "awake", "requested", undefined].map(needsWake), [true, true, false, false, true], "when watching also wakes");
eq(/^[0-9a-f]{32}$/.test(newId()) && newId() !== newId(), true, "offer ids are 32 hex and differ");
eq(Object.keys(SCREEN_MESSAGES).sort(), ["disabled", "failed", "ice", "lost", "no-display", "permission", "timeout"], "every error has text");
console.log("viewer ok");
```

- [ ] **Step 2: Run to see it fail**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && npm test`
Expected: FAIL with `Cannot find module '.../lib/screen.js'`.

- [ ] **Step 3: Implement `console-next/lib/screen.js`**

```js
// Viewer-side live screen decisions, shared by app/Viewer.js. Mirrored in mobile/src/core.ts: keep the text identical.

export const SCREEN_MESSAGES = {
  disabled: "Screen viewing is turned off on the Mac.",
  permission: "MacWake needs Screen Recording permission on the Mac (System Settings → Privacy & Security → Screen Recording).",
  "no-display": "The Mac's screen is off (lid closed, no external display).",
  failed: "The Mac couldn't start sharing its screen. Try again.",
  timeout: "The Mac didn't answer. Check that MacWake is running and someone is logged in.",
  ice: "Couldn't connect directly to the Mac. Add a free TURN relay to the console (see README).",
  lost: "Connection lost.",
};

/** How long the viewer waits for the Mac's answer before checking whether it is still waking. */
export const ANSWER_WAIT = 20e3;

/** What the viewer does after polling for the answer to offer `id`. `phase` is the console's phase (idle/requested/awake/done). */
export function afterPoll(answer, id, waited, phase) {
  if (answer && answer.id === id) {
    if (answer.sdp) return { kind: "answer", sdp: answer.sdp };
    return { kind: "error", error: answer.error in SCREEN_MESSAGES ? answer.error : "failed" };
  }
  if (waited < ANSWER_WAIT) return { kind: "wait" };
  return phase === "requested" ? { kind: "reoffer" } : { kind: "error", error: "timeout" };
}

/** Watching also asks for a wake (it holds the Mac awake), unless one is already holding or on its way. */
export const needsWake = phase => phase !== "awake" && phase !== "requested";

/** Matches an answer to its offer. Not a secret, so Math.random is enough. */
export const newId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
```

- [ ] **Step 4: Run to see it pass**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && npm test`
Expected: `ok`, `push ok`, `viewer ok`.

- [ ] **Step 5: Commit (console repo)**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && git add lib/screen.js test.mjs
git commit -m "Add viewer decisions for live screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web console viewer

**Files:**
- Create: `console-next/app/Viewer.js`
- Modify: `console-next/app/page.js` (import, `watching` state, dock button, render viewer)
- Modify: `console-next/app/globals.css`

**Interfaces:**
- Consumes: Task 2 HTTP API; Task 3 `afterPoll`, `ANSWER_WAIT`, `needsWake`, `newId`, `SCREEN_MESSAGES`.
- Produces: `export default function Viewer({ token, onClose })`; data channel label `control`; understands messages `{"locked": boolean}`.

- [ ] **Step 1: Create `console-next/app/Viewer.js`**

```jsx
"use client";
// Full-screen live view of the Mac over WebRTC. Decisions live in lib/screen.js (mirrored in mobile/src/core.ts).
import { useEffect, useRef, useState } from "react";
import { afterPoll, ANSWER_WAIT, needsWake, newId, SCREEN_MESSAGES } from "../lib/screen.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Non-trickle signaling: wait until every ICE candidate is in the SDP, at most 3 s. */
function gathered(pc) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(resolve, 3000);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
  });
}

export default function Viewer({ token, onClose }) {
  const video = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [live, setLive] = useState(false);
  const [attempt, setAttempt] = useState(0);   // Try again re-runs the effect

  useEffect(() => {
    let closed = false, wasLive = false, pc = null, lost;
    const api = async (action, body) => {
      const r = await fetch(`/api/${action}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `The console returned an error (${r.status}). Try again.`);
      return j;
    };
    const fail = key => { if (!closed) { setError(SCREEN_MESSAGES[key] || key); setLive(false); } };
    (async () => {
      try {
        setError(""); setLive(false); setLocked(false); setStatus("Connecting…");
        let ph = (await api("state")).phase;
        if (needsWake(ph)) { await api("wake", {}); ph = "requested"; }
        const { ice } = await api("screen");
        while (!closed) {
          pc?.close();
          const conn = pc = new RTCPeerConnection({ iceServers: ice });
          conn.addTransceiver("video", { direction: "recvonly" });
          conn.createDataChannel("control").onmessage = e => { try { setLocked(!!JSON.parse(e.data).locked); } catch { /* not ours */ } };
          conn.ontrack = e => { if (video.current) video.current.srcObject = e.streams[0] || new MediaStream([e.track]); };
          conn.onconnectionstatechange = () => {
            const s = conn.connectionState;
            if (s === "connected") { clearTimeout(lost); wasLive = true; setLive(true); setStatus(""); }
            else if (s === "failed") fail(wasLive ? "lost" : "ice");
            else if (s === "disconnected") lost = setTimeout(() => fail("lost"), 10e3);
          };
          await conn.setLocalDescription(await conn.createOffer());
          await gathered(conn);
          const id = newId();
          setStatus(ph === "requested" ? "Waking your Mac…" : "Connecting…");
          await api("screen", { id, offer: conn.localDescription.sdp });
          const t0 = Date.now();
          let next = { kind: "wait" };
          while (!closed && next.kind === "wait") {
            await sleep(700);
            const { answer } = await api("screen");
            if (Date.now() - t0 >= ANSWER_WAIT) ph = (await api("state")).phase;
            next = afterPoll(answer, id, Date.now() - t0, ph);
          }
          if (closed) return;
          if (next.kind === "answer") { setStatus("Connecting…"); await conn.setRemoteDescription({ type: "answer", sdp: next.sdp }); return; }
          if (next.kind === "error") return fail(next.error);
          // "reoffer": the Mac is still waking, so post a fresh offer
        }
      } catch (e) { fail(e.message); }
    })();
    return () => { closed = true; clearTimeout(lost); pc?.close(); };
  }, [token, attempt]);

  const msg = error || (locked && live ? "Mac is locked" : status);
  return (
    <div className="viewer" role="dialog" aria-label="Mac screen">
      <video ref={video} autoPlay playsInline muted />
      {msg && <p className="viewer-msg" role="status">{msg}</p>}
      <div className="viewer-bar">
        {error && <button className="primary quiet onvideo" onClick={() => setAttempt(n => n + 1)}>Try again</button>}
        <button className="primary quiet onvideo" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `page.js`**

Add below `import { useEffect, useRef, useState } from "react";`:

```js
import Viewer from "./Viewer";
```

Add after `const [form, setForm] = useState(null);`:

```js
  const [watching, setWatching] = useState(false);
```

In the dock (`<footer className="dock">`), after the primary `<button className={`primary${…}`} …>{primary.label}</button>`, add:

```jsx
        <button className="primary quiet watch" disabled={ph === "never" || ph === "loading"} onClick={() => setWatching(true)}>Watch screen</button>
```

After `</footer>` and before the console's closing `</main>`, add:

```jsx
      {watching && <Viewer token={token} onClose={() => { setWatching(false); call("state"); }} />}
```

- [ ] **Step 3: Add styles to `globals.css`**

Insert before the `@media (prefers-reduced-motion: reduce)` block:

```css
.watch { margin-top: 10px; }
.viewer { position: fixed; inset: 0; z-index: 10; background: #000; }
.viewer video { width: 100%; height: 100%; object-fit: contain; }
.viewer-msg { position: absolute; top: calc(env(safe-area-inset-top) + 16px); left: 50%; transform: translateX(-50%); margin: 0;
  padding: 8px 14px; border-radius: 99px; background: #000b; color: #fff; width: max-content; max-width: min(90vw, 36ch); text-align: center; }
.viewer-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: 10px; padding: 12px 22px calc(env(safe-area-inset-bottom) + 14px); }
```

- [ ] **Step 4: Start the test console and a test Mac account**

Start the preview `macwake-console-test` (preview_start `{name: "macwake-console-test"}`). Then:

```bash
SCRATCH=/private/tmp/claude-501/-Users-tarunbhardwaj-Desktop-projects-Mac-Remote/031fd809-eb04-4f6f-a800-8907f17bbba8/scratchpad
openssl rand -hex 24 > "$SCRATCH/test-token"; TOK=$(cat "$SCRATCH/test-token")
curl -s -X POST localhost:3003/api/register -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST localhost:3003/api/heartbeat -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"ac":true,"host":"Test Mac"}'
```
Expected: `{"paired":true}` then a JSON reply with `"wake":false`.

- [ ] **Step 5: Fake Mac in a second browser tab**

Open a second browser-pane tab at `http://localhost:3003/` and run this with javascript_tool (replace `TOKEN` with the content of `$SCRATCH/test-token`). It is a test double only, never committed:

```js
(() => {
  const TOKEN = "TOKEN";
  const api = async body => (await fetch("/api/screen", { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json();
  const c = Object.assign(document.createElement("canvas"), { width: 1280, height: 800 }), g = c.getContext("2d");
  setInterval(() => { g.fillStyle = "#3b3f8c"; g.fillRect(0, 0, 1280, 800); g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("Fake Mac " + new Date().toLocaleTimeString(), 80, 400); }, 200);
  const stream = c.captureStream(10); let seen = "";
  window.fakeMac = setInterval(async () => {
    const { offer, ice } = await api(); if (!offer || offer.id === seen) return; seen = offer.id;
    const pc = new RTCPeerConnection({ iceServers: ice });
    pc.ondatachannel = e => { e.channel.onopen = () => e.channel.send(JSON.stringify({ locked: window.fakeLocked || false })); };
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    stream.getTracks().forEach(t => pc.addTrack(t, stream));   // after the offer: takes the viewer's recvonly slot
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise(r => { pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 3000); });
    await api({ id: offer.id, answer: pc.localDescription.sdp });
  }, 1000);
  return "fake Mac running";
})();
```

- [ ] **Step 6: Verify the viewer against the fake Mac**

In the first tab navigate to `http://localhost:3003/#token=<TOK>`, click **Watch screen**.
Expected: within ~3 s the overlay shows the "Fake Mac <time>" canvas with the clock ticking; no errors in read_console_messages. Take a screenshot as proof. Close → back to the console.

- [ ] **Step 7: Verify the error paths**

1. Refusal: in the fake-Mac tab run `clearInterval(window.fakeMac)`, then click Watch in the viewer tab and, while it says "Waking your Mac…" or "Connecting…", run in the fake tab (same `TOKEN`):
   ```js
   (async () => { const h = { Authorization: "Bearer TOKEN", "Content-Type": "application/json" }; const { offer } = await (await fetch("/api/screen", { headers: h })).json(); await fetch("/api/screen", { method: "POST", headers: h, body: JSON.stringify({ id: offer.id, error: "disabled" }) }); })();
   ```
   Expected: the viewer shows "Screen viewing is turned off on the Mac." and a **Try again** button.
2. Timeout: with no fake Mac running, acknowledge the pending wake so the phase becomes `awake`:
   `curl -s -X POST localhost:3003/api/heartbeat -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"ac":true,"host":"Test Mac","holding":true}'`
   then click Watch. Expected after ~20 s: "The Mac didn't answer. Check that MacWake is running and someone is logged in."
3. Phone width: resize_window preset mobile; the viewer fills the screen and the buttons sit above the bottom safe area. Reset to desktop.

- [ ] **Step 8: Commit (console repo, then the parent gitlink)**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && git add app/Viewer.js app/page.js app/globals.css
git commit -m "Watch the Mac's screen live from the console

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
cd .. && git add console-next && git commit -m "Update console with live screen viewing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mac signaling (menu-bar app answers offers)

Signaling and the refusal paths only; Task 6 adds the video. At the end of this task a permitted, allowed Mac answers `failed`; Task 6 replaces that line with the streaming session.

**Files:**
- Create: `mac/Sources/Screen.swift`
- Modify: `mac/Sources/main.swift` (shared push listener, App wiring, menu item)
- Modify: `mac/build.sh` (compile `Sources/*.swift`)

**Interfaces:**
- Consumes: Task 2 HTTP API.
- Produces (Swift, same module):
  - `func pushTopic(_ token: String) -> String`
  - `func listenForPushes(topic: String, server: @escaping () -> String?, onMessage: @escaping () -> Void)`
  - `final class ScreenShare { init(url: String, token: String); let url: String; let token: String; var onLive: (Bool) -> Void; var allowed: () -> Bool; func start(); func check() }`
  - `ScreenShare.Ice` = `struct Ice: Decodable { var urls: [String]; var username: String?; var credential: String? }`
  - App: `var screen: ScreenShare?`, `var screenAllowed: Bool`, `func startScreen(url:token:)`, launch flag `--screen-test <url> <token>`.

- [ ] **Step 1: Share the push listener in `main.swift`**

Insert before `// MARK: - Daemon`:

```swift
/// ntfy topic for a token: unguessable without it. The console's topicFor() computes the same name.
func pushTopic(_ token: String) -> String {
    "macwake-" + SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(40)
}

/// Long-lived stream from the push relay (ntfy) on its own thread; each message calls `onMessage` on that thread.
/// `server` is read before every connection, so the console can switch relays; nil means wait.
func listenForPushes(topic: String, server: @escaping () -> String?, onMessage: @escaping () -> Void) {
    Thread.detachNewThread {
        while true {
            guard let server = server() else { Thread.sleep(forTimeInterval: 5); continue }
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
                    if line.contains(where: { $0 != 32 && $0 != 13 }) { onMessage() }
                }
            }
            p.waitUntilExit()
            Thread.sleep(forTimeInterval: 3)
        }
    }
}
```

In `Daemon`, replace

```swift
    lazy var topic = "macwake-" + SHA256.hash(data: Data(cfg.token.utf8)).map { String(format: "%02x", $0) }.joined().prefix(40)
```

with

```swift
    lazy var topic = pushTopic(cfg.token)
```

and replace the whole `startPushListener()` (its doc comment through its closing brace) with:

```swift
    /// Every message on the Mac's push topic means "check in now".
    func startPushListener() {
        listenForPushes(topic: topic, server: { [self] in pushLock.lock(); defer { pushLock.unlock() }; return pushServer }) { [self] in
            pushLock.lock(); poked = true; pushLock.unlock()
        }
    }
```

- [ ] **Step 2: Create `mac/Sources/Screen.swift`**

```swift
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
```

- [ ] **Step 3: Wire the App in `main.swift`**

In `final class App`, add after `let menu = NSMenu()`:

```swift
    var screen: ScreenShare?
    /// "Allow screen viewing": on unless the user turned it off on this Mac.
    var screenAllowed: Bool {
        get { UserDefaults.standard.object(forKey: "screenViewing") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "screenViewing") }
    }
```

In `applicationDidFinishLaunching`, insert right after `rebuild()`:

```swift
        // Dev only: stream to a test console without setting anything up:  open -n dist/MacWake.app --args --screen-test <url> <token>
        if let i = CommandLine.arguments.firstIndex(of: "--screen-test"), CommandLine.arguments.count > i + 2 {
            _ = CGRequestScreenCaptureAccess()
            startScreen(url: CommandLine.arguments[i + 1], token: CommandLine.arguments[i + 2]); return
        }
```

and append as the last line of `applicationDidFinishLaunching` (after the hourly `Timer.scheduledTimer(…checkPairing()…)` line):

```swift
        if installed, let t = Token.load(), !consoleURL.isEmpty { startScreen(url: consoleURL, token: t) }
```

Add these methods after `func menuWillOpen(_ menu: NSMenu) { rebuild() }`:

```swift
    /// Live screen for paired viewers. Only this app can capture: the root daemon has no screen session.
    func startScreen(url: String, token: String) {
        let s = ScreenShare(url: url, token: token)
        s.allowed = { [weak self] in self?.screenAllowed ?? false }
        s.onLive = { [weak self] live in
            self?.item.button?.image = NSImage(systemSymbolName: live ? "eye" : "powersleep", accessibilityDescription: live ? "MacWake: someone is viewing the screen" : "MacWake")
        }
        s.start()
        screen = s
    }

    @objc func toggleViewing() { screenAllowed.toggle() }
```

In `rebuild()`, inside `if installed && Token.load() != nil {`, after `add("Open console", #selector(openConsole))`:

```swift
            add("Allow screen viewing", #selector(toggleViewing)).state = screenAllowed ? .on : .off
```

In `setup()`, right after the line `Token.save(token)   // only now: the QR code and Copy token must match what the background service uses`:

```swift
        if screen == nil { startScreen(url: consoleURL, token: token) }
```

- [ ] **Step 4: Compile every source file**

In `mac/build.sh` change `Sources/main.swift` to `Sources/*.swift` in the `swiftc` line.

- [ ] **Step 5: Build**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && sh mac/build.sh`
Expected: `built: dist/MacWake.app and dist/MacWake.dmg`, no errors.

- [ ] **Step 6: Daemon push regression check**

Run: `grep -n "pushTopic\|listenForPushes" mac/Sources/main.swift`
Expected: the daemon's `topic` uses `pushTopic(cfg.token)` and `startPushListener` calls `listenForPushes`. (Same code path, moved; the daemon check-in is exercised end to end in Task 9 Step 4.)

- [ ] **Step 7: Run the test app against the test console**

With the `macwake-console-test` preview running and the token from Task 4 (`TOK=$(cat "$SCRATCH/test-token")`):

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && open -n mac/dist/MacWake.app --args --screen-test http://localhost:3003 "$TOK"
```
Expected: a second MacWake icon appears in the menu bar; macOS may show its Screen Recording prompt. Tell the user: do NOT grant it yet (Step 8 needs it off).

- [ ] **Step 8: Review Focus 4 — missing permission is reported, not a timeout**

Make sure no fake-Mac tab is running (`clearInterval(window.fakeMac)`). In the viewer tab click **Watch screen**.
Expected within ~12 s (10 s poll, no push locally): "MacWake needs Screen Recording permission on the Mac (System Settings → Privacy & Security → Screen Recording)." Screenshot.

- [ ] **Step 9: `disabled` path**

Quit the test app (`pkill -f "dist/MacWake.app/Contents/MacOS/MacWake"`), run `defaults write io.macwake.app screenViewing -bool false`, relaunch it (Step 7 command), click **Try again** in the viewer.
Expected: "Screen viewing is turned off on the Mac." Then restore: quit it, `defaults delete io.macwake.app screenViewing`, relaunch.

- [ ] **Step 10: Commit (do not add `mac/dist`)**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && git add mac/Sources/Screen.swift mac/Sources/main.swift mac/build.sh
git commit -m "Answer live screen requests from the menu-bar app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mac streaming (ScreenCaptureKit + WebRTC)

**Files:**
- Modify: `mac/Sources/Screen.swift` (full replacement below)
- Modify: `mac/Sources/main.swift` (`toggleViewing` ends the session)
- Modify: `mac/build.sh` (vendor WebRTC, weak link, embed, stable signing)
- Create: `mac/.gitignore`, `tools/make-signing-cert.sh`

**Interfaces:**
- Consumes: Task 5 `ScreenShare`, `pushTopic`, `listenForPushes`; `assertion(_:_:)` from `main.swift`; Task 2 API; viewer data channel `control`.
- Produces: `ScreenShare.endSession()`; `final class ViewSession` (internal); sends `{"locked":true|false}` on the data channel; IOKit assertion name `MacWake screen viewing`.

- [ ] **Step 1: Ignore the vendored framework**

Create `mac/.gitignore`:

```gitignore
vendor/
```

- [ ] **Step 2: Fetch, link, embed and sign in `mac/build.sh`**

Replace the whole file with:

```sh
#!/bin/sh
# Builds dist/MacWake.app (universal) and dist/MacWake.dmg. Needs Xcode or Command Line Tools.
# CONSOLE_URL=https://your-console.vercel.app ./build.sh  bakes in the console address.
set -e
cd "$(dirname "$0")"
APP=dist/MacWake.app

# Google's WebRTC for live screen viewing, prebuilt by github.com/stasel/WebRTC. Pinned and checksum-verified.
WEBRTC=153.0.0
WEBRTC_SHA256=3e3a8946f27510133e3feed04d05fa23505bbe366e977620503bfc7986c2b78f
FW=vendor/WebRTC.xcframework/macos-arm64_x86_64
if [ ! -d "$FW/WebRTC.framework" ]; then
  mkdir -p vendor
  curl -fsSL -o vendor/webrtc.zip "https://github.com/stasel/WebRTC/releases/download/$WEBRTC/WebRTC-M${WEBRTC%%.*}.xcframework.zip"
  echo "$WEBRTC_SHA256  vendor/webrtc.zip" | shasum -a 256 -c - >/dev/null
  rm -rf vendor/WebRTC.xcframework && unzip -q vendor/webrtc.zip -d vendor && rm vendor/webrtc.zip
fi

rm -rf dist && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
for arch in arm64 x86_64; do
  # WebRTC is weak-linked: the root daemon runs a lone copy of this binary with no Frameworks folder beside it.
  swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" -F "$FW" \
    -Xfrontend -disable-autolink-framework -Xfrontend WebRTC -Xlinker -weak_framework -Xlinker WebRTC \
    -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
    -framework AppKit -framework IOKit -framework ScreenCaptureKit -framework ServiceManagement \
    Sources/*.swift -o "dist/MacWake-$arch"
done
lipo -create dist/MacWake-arm64 dist/MacWake-x86_64 -output "$APP/Contents/MacOS/MacWake" && rm dist/MacWake-*
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp -R "$FW/WebRTC.framework" "$APP/Contents/Frameworks/"
# Bake the console address in, so the app sets itself up with no typing:  CONSOLE_URL=https://you.vercel.app ./build.sh
if [ -n "$CONSOLE_URL" ]; then
  /usr/libexec/PlistBuddy -c "Add :MacWakeConsoleURL string ${CONSOLE_URL%/}" "$APP/Contents/Info.plist"
  echo "console URL baked in: ${CONSOLE_URL%/}"
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"
# A stable signature keeps the Screen Recording permission across rebuilds; an ad-hoc one changes every build.
ID="MacWake Local Signing"
if security find-identity -p codesigning | grep -q "\"$ID\""; then SIGN=$ID; else
  SIGN=-; echo "warning: no \"$ID\" identity, so Screen Recording resets on every build. Run tools/make-signing-cert.sh once."
fi
codesign --force -s "$SIGN" "$APP/Contents/Frameworks/WebRTC.framework"
codesign --force -s "$SIGN" "$APP"
mkdir dist/dmg && cp -R "$APP" dist/dmg/ && ln -s /Applications dist/dmg/Applications
# diskutil image create is the non-deprecated tool on macOS 26+; older systems only have hdiutil.
diskutil image create from dist/dmg --volumeName MacWake --format UDZO dist/MacWake.dmg >/dev/null 2>&1 \
  || hdiutil create -volname MacWake -srcfolder dist/dmg -ov -format UDZO dist/MacWake.dmg >/dev/null
rm -rf dist/dmg
echo "built: $APP and dist/MacWake.dmg"
```

- [ ] **Step 3: Check the framework layout**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mac" && sh build.sh; ls vendor/WebRTC.xcframework`
Expected: the download verifies (no `shasum` FAILED line) and the listing includes `macos-arm64_x86_64`. If the macOS slice has another name, set `FW=vendor/WebRTC.xcframework/<that name>` in `build.sh` and rerun. (Whether this build links cleanly doesn't matter yet; Step 7 checks the real build.)

- [ ] **Step 4: Create `tools/make-signing-cert.sh`**

```sh
#!/bin/sh
# One-time, run by you: creates a free self-signed code-signing identity, "MacWake Local Signing", in your login
# keychain. mac/build.sh signs with it so macOS keeps MacWake's Screen Recording permission across rebuilds and
# updates (ad-hoc signatures change on every build). macOS asks for your login password to trust it for code signing.
set -e
NAME="MacWake Local Signing"
KC="$HOME/Library/Keychains/login.keychain-db"
if security find-identity -p codesigning | grep -q "\"$NAME\""; then echo "already set up: $NAME"; exit 0; fi
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
cat > "$D/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
EOF
# Apple's LibreSSL writes a PKCS#12 that `security import` reads (Homebrew OpenSSL 3 would need -legacy).
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$D/cert.cnf" -keyout "$D/key.pem" -out "$D/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$D/key.pem" -in "$D/cert.pem" -name "$NAME" -out "$D/id.p12" -passout pass:macwake
security import "$D/id.p12" -k "$KC" -P macwake -T /usr/bin/codesign
security add-trusted-cert -p codeSign -k "$KC" "$D/cert.pem"
echo "created: $NAME. Rebuild with mac/build.sh, then allow Screen Recording once more for the newly signed app."
```

Run: `chmod +x tools/make-signing-cert.sh`

- [ ] **Step 5: Replace `mac/Sources/Screen.swift` with the streaming version**

```swift
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
```

- [ ] **Step 6: End the session when viewing is turned off**

In `main.swift` replace

```swift
    @objc func toggleViewing() { screenAllowed.toggle() }
```

with

```swift
    @objc func toggleViewing() {
        screenAllowed.toggle()
        if !screenAllowed { screen?.endSession() }
    }
```

- [ ] **Step 7: Build and check the linking**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && sh mac/build.sh
otool -l mac/dist/MacWake.app/Contents/MacOS/MacWake | grep -A2 LC_LOAD_WEAK_DYLIB | grep WebRTC
SCRATCH=/private/tmp/claude-501/-Users-tarunbhardwaj-Desktop-projects-Mac-Remote/031fd809-eb04-4f6f-a800-8907f17bbba8/scratchpad
mkdir -p "$SCRATCH/lone" && cp mac/dist/MacWake.app/Contents/MacOS/MacWake "$SCRATCH/lone/" && MACWAKE_CONFIG=/nonexistent "$SCRATCH/lone/MacWake" --daemon; echo "exit $?"
```
Expected: build succeeds (a signing warning is fine before Step 8); `otool` prints a `name @rpath/WebRTC.framework/…` line under `LC_LOAD_WEAK_DYLIB`; the lone daemon prints `… no config at /nonexistent; run MacWake.app and choose Set up` and `exit 1`, NOT `dyld: Library not loaded`. If dyld fails, stop: the weak link didn't take.

- [ ] **Step 8: USER STEP — stable signing and Screen Recording**

Ask the user to run, in their own terminal:

```bash
sh "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/tools/make-signing-cert.sh"
```

Then rebuild (`sh mac/build.sh`: expect no signing warning; `codesign -dv mac/dist/MacWake.app 2>&1 | grep Authority` shows `Authority=MacWake Local Signing`), relaunch the test app (`pkill -f "dist/MacWake.app/Contents/MacOS/MacWake"; open -n mac/dist/MacWake.app --args --screen-test http://localhost:3003 "$TOK"`), and ask the user to allow MacWake under System Settings → Privacy & Security → Screen Recording, then choose "Quit & Reopen" (or relaunch with the same `open -n` command).

- [ ] **Step 9: Live video end to end**

In the viewer tab (`http://localhost:3003/#token=<TOK>`), click **Watch screen**.
Expected within ~12 s: the Mac's real screen appears, the cursor moves live, the test app's menu bar icon turns into an eye, and macOS shows its recording indicator. Screenshot as proof. `pmset -g assertions | grep -c "MacWake screen viewing"` prints `3` or more.

- [ ] **Step 10: Review Focus 1 — still screen**

Close the viewer, leave the Mac untouched (no mouse or keyboard), click **Watch screen** again.
Expected: the picture appears as soon as it connects (repeated frame), not a black video until something moves.

- [ ] **Step 11: Review Focus 2 — viewer vanishes**

While live, close the viewer's browser tab entirely (tabs_close), then check `pmset -g assertions | grep -c "MacWake screen viewing"` every 5 s for up to 30 s (Monitor tool).
Expected: drops to `0` within ~20 s and the menu bar icon is back to the sleep symbol.

- [ ] **Step 12: Review Focus 3 — second viewer takes over**

Open two viewer tabs signed in with the same token. Watch in tab A, then Watch in tab B.
Expected: tab B goes live; tab A shows "Connection lost." with Try again within ~10–30 s.

- [ ] **Step 13: Review Focus 5 — Mac stops mid-session**

While live, quit the test app: `pkill -f "dist/MacWake.app/Contents/MacOS/MacWake"`.
Expected: the viewer shows "Connection lost." with Try again within ~30 s (not a frozen frame forever). Relaunch the test app afterwards.

- [ ] **Step 14: Lock screen label**

Ask the user to lock the Mac (Ctrl-Cmd-Q) while a viewer is live, then unlock.
Expected: the viewer shows "Mac is locked" while locked; it disappears after unlock.

- [ ] **Step 15: Commit (do not add `mac/dist`)**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && git add mac/.gitignore mac/build.sh mac/Sources/Screen.swift mac/Sources/main.swift tools/make-signing-cert.sh
git commit -m "Stream the Mac's screen to paired viewers over WebRTC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mac setup, revocation and docs

**Files:**
- Modify: `mac/Sources/main.swift` (import, `renewing`, `pair()`, `setup()`, `relaunch`, `newToken`, menu)
- Modify: `mac/Info.plist` (version 1.5 / build 6)
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 5 `startScreen`, `screen` (`url`, `token`).
- Produces: menu item "New token (unpair all phones)…"; setup requests Screen Recording and registers the login item.

- [ ] **Step 1: Import ServiceManagement**

In `main.swift`, add after `import CryptoKit`:

```swift
import ServiceManagement
```

- [ ] **Step 2: Let setup make a fresh token**

In `final class App`, add after the `screenAllowed` property:

```swift
    /// Set while "New token" runs setup, so pairing makes a fresh token instead of reusing the saved one.
    var renewing = false
```

In `pair()`, replace

```swift
        var token = Token.load() ?? Token.generate()
```

with

```swift
        var token = renewing ? Token.generate() : (Token.load() ?? Token.generate())
```

- [ ] **Step 3: Request permission, register the login item, restart on a new token**

In `setup()`, replace

```swift
        Token.save(token)   // only now: the QR code and Copy token must match what the background service uses
        if screen == nil { startScreen(url: consoleURL, token: token) }
        rebuild()
        showPairing()
```

with

```swift
        Token.save(token)   // only now: the QR code and Copy token must match what the background service uses
        _ = CGRequestScreenCaptureAccess()      // once: macOS asks to allow Screen Recording, for live screen viewing
        try? SMAppService.mainApp.register()    // start at login, so viewers can connect after a restart
        let restart = screen != nil && (screen?.token != token || screen?.url != consoleURL)
        if screen == nil { startScreen(url: consoleURL, token: token) }
        rebuild()
        showPairing()
        if restart { relaunch() }   // the push listener is bound to the old token's topic
```

In `setup()`, change the "set up by another user" guard

```swift
        if installed && Token.load() == nil {
```

to

```swift
        if installed && Token.load() == nil && !renewing {
```

Add after the end of `setup()`:

```swift
    func relaunch() {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-n", Bundle.main.bundlePath]
        try? p.run()
        NSApp.terminate(nil)
    }

    /// The token opens the screen too: a fresh one locks out every phone and browser that had the old one.
    @objc func newToken() {
        let a = NSAlert(); a.messageText = "Unpair all phones?"
        a.informativeText = "Every phone and browser signed in to this Mac stops working and needs the new pairing code. MacWake will ask for your password."
        a.addButton(withTitle: "New token"); a.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard a.runModal() == .alertFirstButtonReturn else { return }
        renewing = true; setup(); renewing = false
    }
```

- [ ] **Step 4: Menu item**

In `rebuild()`, after the `Allow screen viewing` line:

```swift
            add("New token (unpair all phones)…", #selector(newToken))
```

- [ ] **Step 5: Version bump**

In `mac/Info.plist` set `CFBundleShortVersionString` to `1.5` and `CFBundleVersion` to `6`.

- [ ] **Step 6: Build**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && sh mac/build.sh`
Expected: `built: …`, no errors.

- [ ] **Step 7: Root README**

In `README.md`, add after the `## 3. Test` section (before `## Settings (in the console)`):

```markdown
## Watch the screen

Tap **Watch screen** in the console or the app to see your Mac's screen live (view-only for now). It wakes the Mac
if needed and connects on its own; the Mac shows an eye in its menu bar and macOS's own recording indicator while
someone watches. Video goes straight from the Mac to your phone, encrypted; the console only passes the connection
setup along.

- MacWake's menu-bar app must be running (it starts at login) and someone must be logged in on the Mac.
- Allow Screen Recording once when setup asks (System Settings → Privacy & Security → Screen Recording).
- After a wake the Mac usually shows its lock screen; you'll see it, but view-only can't unlock it.
- Lid closed without an external display means there's no screen to show.
- Turn it off on the Mac with **Allow screen viewing** in the menu. **New token (unpair all phones)…** locks out
  every phone and browser that had the old token.
- Some cellular networks block direct connections; add a free TURN relay to the console (see console-next/README.md).
```

In `## 2. Install on the MacBook`, after the `CONSOLE_URL=… sh mac/build.sh` code block, add:

```markdown
Building it yourself? Run `sh tools/make-signing-cert.sh` once first. It creates a free local signing certificate, so
macOS keeps MacWake's Screen Recording permission when you rebuild or update.
```

In `## Limits, honestly`, replace the token bullet with:

```markdown
- **Each Mac's token** protects that Mac on the console and the API, and now also opens its screen. Treat it like a
  password; use **New token (unpair all phones)…** if it leaks.
```

- [ ] **Step 8: Commit (do not add `mac/dist`)**

The setup / New token flow needs the user's admin password and the real install, so it is checked on the release build in Task 9 Step 6.

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && git add mac/Sources/main.swift mac/Info.plist README.md
git commit -m "Ask for Screen Recording at setup and add New token to unpair all phones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Mobile viewer

**Files:**
- Modify: `mobile/src/core.ts` (`request`, screen logic), `mobile/src/core.check.ts`
- Create: `mobile/src/Viewer.tsx`
- Modify: `mobile/App.tsx` (lazy Viewer, `watching`, dock button, modal, style)
- Modify: `mobile/README.md`

**Interfaces:**
- Consumes: Task 1 dependency; Task 2 API; Task 3 text (copied exactly).
- Produces: `request<T>(session, action, body?, timeoutMs?) → Promise<T>`; `api()` unchanged for callers; `afterPoll`, `needsWake`, `newId`, `SCREEN_MESSAGES`, `ANSWER_WAIT`; types `ScreenError`, `Answer`, `IceServer`, `ScreenReply`, `Next`; `export default function Viewer({ session, onClose })`.

- [ ] **Step 1: Baseline**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mobile" && npm run test:core && npx jest --watchAll=false 2>&1 | tail -5`
Expected: `core ok`; note the jest result as the baseline (it must not get worse).

- [ ] **Step 2: Write the failing checks**

In `mobile/src/core.check.ts`, replace the import with:

```ts
import {
  afterPoll,
  api,
  ApiError,
  deriveView,
  needsWake,
  newId,
  normalizeUrl,
  parsePairing,
  request,
  SCREEN_MESSAGES,
  type State,
} from './core.ts';
```

Add before the `// Derived view` comment:

```ts
// Live screen decisions (mirror console-next/lib/screen.js)
eq(afterPoll(null, 'a', 1000, 'awake'), { kind: 'wait' }, 'no answer yet');
eq(
  afterPoll({ id: 'b', sdp: 'x', at: 0 }, 'a', 1000, 'awake'),
  { kind: 'wait' },
  'an answer to another offer is ignored',
);
eq(
  afterPoll({ id: 'a', sdp: 'x', at: 0 }, 'a', 1000, 'awake'),
  { kind: 'answer', sdp: 'x' },
  'answer',
);
eq(
  afterPoll({ id: 'a', error: 'permission', at: 0 }, 'a', 1000, 'awake'),
  { kind: 'error', error: 'permission' },
  'Mac refused',
);
eq(
  afterPoll({ id: 'a', error: 'weird', at: 0 }, 'a', 1000, 'awake'),
  { kind: 'error', error: 'failed' },
  'unknown code reads as failed',
);
eq(afterPoll(null, 'a', 20000, 'requested'), { kind: 'reoffer' }, 'still waking: offer again');
eq(
  afterPoll(null, 'a', 20000, 'awake'),
  { kind: 'error', error: 'timeout' },
  'awake but silent',
);
eq(
  ['idle', 'done', 'awake', 'requested', undefined].map(needsWake),
  [true, true, false, false, true],
  'when watching also wakes',
);
eq(/^[0-9a-f]{32}$/.test(newId()) && newId() !== newId(), true, 'offer ids are 32 hex and differ');
eq(
  SCREEN_MESSAGES.permission,
  'MacWake needs Screen Recording permission on the Mac (System Settings → Privacy & Security → Screen Recording).',
  'same text as the web console',
);
```

In the test server, add before `let body = '';`:

```ts
    if (inc.url === '/api/screen') {
      res.end('{"ice":[],"push":null,"offer":null,"answer":null}');
      return;
    }
```

Before `srv.close();` add:

```ts
eq(
  await request({ url, token: TOK }, 'screen'),
  { ice: [], push: null, offer: null, answer: null },
  'request returns any console JSON',
);
eq(
  await fail(api({ url, token: TOK }, 'screen')),
  [0, "That address isn't a MacWake console."],
  'api still insists on a state',
);
```

- [ ] **Step 3: Run to see it fail**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mobile" && npm run test:core`
Expected: FAIL with `does not provide an export named 'afterPoll'`.

- [ ] **Step 4: Implement in `core.ts`**

Replace the whole `api` function (its doc comment through its closing brace) with:

```ts
/** One console call returning its JSON. Throws ApiError with a sentence a person can act on. */
export async function request<T = unknown>(
  session: Session,
  action: string,
  body?: object,
  timeoutMs = 12000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r: Response;
  try {
    r = await fetch(`${session.url}/api/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError("Can't reach the console. Check your connection.", 0);
  } finally {
    clearTimeout(timer);
  }
  if (r.status === 401)
    throw new ApiError("That token isn't valid for this console.", 401);
  const j = await r.json().catch(() => ({}));
  if (!r.ok)
    throw new ApiError(
      j.error || `The console returned an error (${r.status}). Try again.`,
      r.status,
    );
  return j as T;
}

/** A console call that answers with the Mac's state (state, wake, cancel, settings). */
export async function api(
  session: Session,
  action: string,
  body?: object,
  timeoutMs = 12000,
): Promise<State> {
  const j = await request<Partial<State>>(session, action, body, timeoutMs);
  // Any web server answers 200; only a MacWake console sends a state the screen can draw.
  if (typeof j.phase !== 'string' || !j.device || !j.settings)
    throw new ApiError("That address isn't a MacWake console.", 0);
  return j as State;
}
```

Append to the end of `core.ts`:

```ts
// Live screen: viewer decisions, mirrored from console-next/lib/screen.js. Keep the text identical.
export type ScreenError =
  | 'disabled'
  | 'permission'
  | 'no-display'
  | 'failed'
  | 'timeout'
  | 'ice'
  | 'lost';
export const SCREEN_MESSAGES: Record<ScreenError, string> = {
  disabled: 'Screen viewing is turned off on the Mac.',
  permission:
    'MacWake needs Screen Recording permission on the Mac (System Settings → Privacy & Security → Screen Recording).',
  'no-display': "The Mac's screen is off (lid closed, no external display).",
  failed: "The Mac couldn't start sharing its screen. Try again.",
  timeout:
    "The Mac didn't answer. Check that MacWake is running and someone is logged in.",
  ice: "Couldn't connect directly to the Mac. Add a free TURN relay to the console (see README).",
  lost: 'Connection lost.',
};
/** How long the viewer waits for the Mac's answer before checking whether it is still waking. */
export const ANSWER_WAIT = 20e3;
export type IceServer = { urls: string[]; username?: string; credential?: string };
export type Answer = { id: string; sdp?: string; error?: string; at: number } | null;
export type ScreenReply = {
  ice: IceServer[];
  push: string | null;
  offer: { id: string; sdp: string; at: number } | null;
  answer: Answer;
};
export type Next =
  | { kind: 'answer'; sdp: string }
  | { kind: 'error'; error: ScreenError }
  | { kind: 'wait' }
  | { kind: 'reoffer' };

/** What the viewer does after polling for the answer to offer `id`. `phase` is the console's phase. */
export function afterPoll(answer: Answer, id: string, waited: number, phase?: string): Next {
  if (answer && answer.id === id) {
    if (answer.sdp) return { kind: 'answer', sdp: answer.sdp };
    const e = answer.error ?? '';
    return { kind: 'error', error: e in SCREEN_MESSAGES ? (e as ScreenError) : 'failed' };
  }
  if (waited < ANSWER_WAIT) return { kind: 'wait' };
  return phase === 'requested' ? { kind: 'reoffer' } : { kind: 'error', error: 'timeout' };
}

/** Watching also asks for a wake (it holds the Mac awake), unless one is already holding or on its way. */
export const needsWake = (phase?: string) => phase !== 'awake' && phase !== 'requested';

/** Matches an answer to its offer. Not a secret, so Math.random is enough (Hermes has no crypto.getRandomValues). */
export const newId = () =>
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
```

- [ ] **Step 5: Run to see it pass**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mobile" && npm run test:core`
Expected: `core ok`.

- [ ] **Step 6: Create `mobile/src/Viewer.tsx`**

```tsx
/**
 * Full-screen live view of the Mac over WebRTC. Mirrors console-next/app/Viewer.js; decisions live in core.ts.
 *
 * @format
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  MediaStream,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import {
  afterPoll,
  ANSWER_WAIT,
  needsWake,
  newId,
  request,
  SCREEN_MESSAGES,
  type Next,
  type ScreenError,
  type ScreenReply,
  type Session,
  type State,
} from './core';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Non-trickle signaling: wait until every ICE candidate is in the SDP, at most 3 s. */
function gathered(pc: RTCPeerConnection) {
  return new Promise<void>(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 3000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

export default function Viewer({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [attempt, setAttempt] = useState(0); // Try again re-runs the effect

  useEffect(() => {
    let closed = false;
    let wasLive = false;
    let pc: RTCPeerConnection | null = null;
    let lost: ReturnType<typeof setTimeout> | undefined;
    const fail = (key: string) => {
      if (closed) return;
      setError(SCREEN_MESSAGES[key as ScreenError] ?? key);
      setStream(null);
    };
    (async () => {
      try {
        setError('');
        setStream(null);
        setLocked(false);
        setStatus('Connecting…');
        let ph: string = (await request<State>(session, 'state')).phase;
        if (needsWake(ph)) {
          await request(session, 'wake', {});
          ph = 'requested';
        }
        const { ice } = await request<ScreenReply>(session, 'screen');
        while (!closed) {
          pc?.close();
          const conn = new RTCPeerConnection({ iceServers: ice });
          pc = conn;
          conn.addTransceiver('video', { direction: 'recvonly' });
          const dc = conn.createDataChannel('control');
          dc.addEventListener('message', (e: any) => {
            try {
              setLocked(!!JSON.parse(e.data).locked);
            } catch {
              // not ours
            }
          });
          conn.addEventListener('track', (e: any) => setStream(e.streams?.[0] ?? null));
          conn.addEventListener('connectionstatechange', () => {
            const s = conn.connectionState;
            if (s === 'connected') {
              clearTimeout(lost);
              wasLive = true;
              setStatus('');
            } else if (s === 'failed') fail(wasLive ? 'lost' : 'ice');
            else if (s === 'disconnected') lost = setTimeout(() => fail('lost'), 10e3);
          });
          await conn.setLocalDescription(await conn.createOffer({}));
          await gathered(conn);
          const id = newId();
          setStatus(ph === 'requested' ? 'Waking your Mac…' : 'Connecting…');
          await request(session, 'screen', { id, offer: conn.localDescription?.sdp });
          const t0 = Date.now();
          let next: Next = { kind: 'wait' };
          while (!closed && next.kind === 'wait') {
            await sleep(700);
            const { answer } = await request<ScreenReply>(session, 'screen');
            if (Date.now() - t0 >= ANSWER_WAIT)
              ph = (await request<State>(session, 'state')).phase;
            next = afterPoll(answer, id, Date.now() - t0, ph);
          }
          if (closed) return;
          if (next.kind === 'answer') {
            setStatus('Connecting…');
            await conn.setRemoteDescription(
              new RTCSessionDescription({ type: 'answer', sdp: next.sdp }),
            );
            return;
          }
          if (next.kind === 'error') return fail(next.error);
          // 'reoffer': the Mac is still waking, so post a fresh offer
        }
      } catch (e) {
        fail((e as Error).message);
      }
    })();
    return () => {
      closed = true;
      clearTimeout(lost);
      pc?.close();
    };
  }, [session, attempt]);

  const msg = error || (locked && stream ? 'Mac is locked' : status);
  const video = stream ? (
    <RTCView streamURL={stream.toURL()} objectFit="contain" style={{ width, height }} />
  ) : null;
  return (
    <Modal animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={st.fill} accessibilityViewIsModal accessibilityLabel="Mac screen">
        {Platform.OS === 'ios' ? (
          // Pinch to zoom into small text on the Mac's screen.
          <ScrollView
            maximumZoomScale={4}
            minimumZoomScale={1}
            centerContent
            contentContainerStyle={st.fill}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
            {video}
          </ScrollView>
        ) : (
          video
        )}
        {msg ? (
          <Text
            style={[st.msg, { top: inset.top + 16 }]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {msg}
          </Text>
        ) : null}
        <View style={[st.bar, { paddingBottom: inset.bottom + 14 }]}>
          {error ? <Btn label="Try again" onPress={() => setAttempt(n => n + 1)} /> : null}
          <Btn label="Close" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [st.btn, pressed && st.pressed]}
    >
      <Text style={st.btnText}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  msg: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '90%',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 99,
    overflow: 'hidden',
    backgroundColor: '#000b',
    color: '#fff',
    fontFamily: 'Onest-Regular',
    fontSize: 15,
    textAlign: 'center',
  },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 22,
    paddingTop: 12,
  },
  btn: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 17,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#fff6',
  },
  pressed: { opacity: 0.6 },
  btnText: { color: '#fff', fontFamily: 'Onest-SemiBold', fontSize: 17 },
});
```

- [ ] **Step 7: Wire it into `App.tsx`**

After `const Scanner = React.lazy(() => import('./src/Scanner'));` add:

```tsx
// WebRTC only loads when someone taps "Watch screen".
const Viewer = React.lazy(() => import('./src/Viewer'));
```

In `Console`, after `const [form, setForm] = useState<Form | null>(null);` add:

```tsx
  const [watching, setWatching] = useState(false);
```

In the dock, after the existing `<Primary … onPress={() => primary.action && act(primary.action)} />`, add:

```tsx
          <Primary
            label="Watch screen"
            quiet
            style={s.watch}
            disabled={view.phase === 'never' || view.phase === 'loading'}
            onPress={() => setWatching(true)}
          />
```

After `<Timing form={form} setForm={setForm} busy={busy} onSave={save} />` add:

```tsx
      {watching && (
        <Suspense fallback={null}>
          <Viewer
            session={session}
            onClose={() => {
              setWatching(false);
              call('state');
            }}
          />
        </Suspense>
      )}
```

In `const s = StyleSheet.create({`, add before `  primary: {`:

```tsx
  watch: { marginTop: 10 },
```

- [ ] **Step 8: Type check, lint and tests**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/mobile" && npx tsc --noEmit && npx eslint App.tsx src/Viewer.tsx src/core.ts && npm run test:core && npx jest --watchAll=false 2>&1 | tail -5`
Expected: no type errors, no lint errors (warnings are fine), `core ok`, jest no worse than the Step 1 baseline.

- [ ] **Step 9: Simulator end to end**

With the test console and the test Mac app (Task 6) running, sign the simulator app in by pasting the full link `http://localhost:3003/#token=<TOK>` into the Token field. Tap **Watch screen**.
Expected: the Mac's live screen shows, pinch-zoom works, the Mac's menu bar shows the eye; **Close** returns to the console. Screenshot as proof. Then quit the test Mac app and watch again: "Waking your Mac…" (phase requested) or, after ~20 s with phase awake, "The Mac didn't answer…", with **Try again**.

- [ ] **Step 10: Mobile README**

Append to `mobile/README.md`:

```markdown
## Watch screen

"Watch screen" opens a full-screen live view of the Mac (view-only; pinch to zoom on iOS). It uses
`react-native-webrtc` (pinned 124.0.8); after installing or updating it run `cd ios && LANG=en_US.UTF-8 pod install`
and restart Metro. Decisions and text live in `src/core.ts` and mirror `console-next/lib/screen.js`.
```

- [ ] **Step 11: Commit**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && git add mobile/src/core.ts mobile/src/core.check.ts mobile/src/Viewer.tsx mobile/App.tsx mobile/README.md
git commit -m "Watch the Mac's screen live from the mobile app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Release build and final verification

**Files:**
- Modify: `mac/dist/MacWake.app`, `mac/dist/MacWake.dmg` (tracked build)
- Modify: parent gitlink `console-next`

- [ ] **Step 1: All automated checks**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && (cd console-next && npm test) && (cd mobile && npm run test:core && npx tsc --noEmit)
```
Expected: `ok`, `push ok`, `viewer ok`, `core ok`, no type errors.

- [ ] **Step 2: Console production build**

Run: `cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote/console-next" && npx next build`
Expected: build succeeds (no `node:crypto` in a client bundle: `Viewer.js` imports only `lib/screen.js`).

- [ ] **Step 3: Release Mac build with the production console URL**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && CONSOLE_URL=https://mac-wake-console.vercel.app sh mac/build.sh
/usr/libexec/PlistBuddy -c "Print :MacWakeConsoleURL" mac/dist/MacWake.app/Contents/Info.plist
codesign -dv mac/dist/MacWake.app 2>&1 | grep -E "Authority|Identifier"
```
Expected: `console URL baked in: https://mac-wake-console.vercel.app`; `Authority=MacWake Local Signing` (or the ad-hoc warning if the user skipped Task 6 Step 8: report it).

- [ ] **Step 4: Daemon regression (local check-in by the weak-linked binary)**

```bash
SCRATCH=/private/tmp/claude-501/-Users-tarunbhardwaj-Desktop-projects-Mac-Remote/031fd809-eb04-4f6f-a800-8907f17bbba8/scratchpad; TOK=$(cat "$SCRATCH/test-token")
printf '{"url":"http://localhost:3003","token":"%s"}' "$TOK" > "$SCRATCH/daemon.json"
cp mac/dist/MacWake.app/Contents/MacOS/MacWake "$SCRATCH/lone/MacWake"
MACWAKE_CONFIG="$SCRATCH/daemon.json" perl -e 'alarm 8; exec @ARGV' "$SCRATCH/lone/MacWake" --daemon; true
curl -s localhost:3003/api/state -H "Authorization: Bearer $TOK" | grep -o '"host":"[^"]*"'
```
Expected: the daemon logs `daemon start uid=…` plus a "not root" warning (fine), and the state now shows this Mac's real host name instead of "Test Mac", proving the weak-linked binary still runs the daemon and checks in.

- [ ] **Step 5: Commit the build and the console gitlink**

```bash
cd "/Users/tarunbhardwaj/Desktop/projects/Mac Remote" && git add mac/dist console-next
git commit -m "Build MacWake 1.5 with live screen viewing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: USER STEP (optional) — install and try setup / New token**

Ask the user whether to install the release build now. If yes: they open `mac/dist/MacWake.dmg`, drag MacWake to Applications and open it; it reinstalls its service (admin password), asks for Screen Recording, and registers the login item (check System Settings → General → Login Items). Then **New token (unpair all phones)…** → confirm → password: a new pairing code shows and the app relaunches after it's closed; the old token no longer controls the Mac. Note that live viewing against the production console works only after `console-next` is deployed. If they decline, record this step as deferred.

- [ ] **Step 7: Clean up the test session**

Quit the test app (`pkill -f "dist/MacWake.app/Contents/MacOS/MacWake"`), stop the `macwake-console-test` preview, close the extra browser tabs. Leave `$SCRATCH` files (scratch, outside the repo).

- [ ] **Step 8: Hand-off notes for the user**

Tell the user, without doing any of it: the production console needs a deploy of `console-next` (branch `feat/live-screen`) before phones can watch through it; the installed MacWake updates by opening the new DMG; `website/public/downloads` still has 1.4 unless they ask to upload 1.5; nothing has been pushed; TURN env vars are optional.
