# Remote Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While watching the Mac's screen, control its mouse and keyboard from the web console (computers and touch browsers) and the iPhone/iPad app.

**Architecture:** The viewer turns mouse, touches and keys into small JSON messages (pure, tested logic in `console-next/lib/control.js`, mirrored in `mobile/src/control.ts`) and sends them over the existing WebRTC data channel `control`. The Mac's menu-bar app injects them with CGEvent (`mac/Sources/Control.swift`) once Accessibility is granted. The console server does not change.

**Tech Stack:** Next.js 16 / React 19 (web), React Native 0.87 core APIs + one small Swift native module (app), Swift + CoreGraphics events + WebRTC (Mac).

**Spec:** `docs/superpowers/specs/2026-10-11-remote-control-design.md`

## Global Constraints

- Free only. No new npm packages or pods: web uses React only, app uses React Native core (`PanResponder`, `TextInput`, `Keyboard`, `NativeModules`).
- Wire format exactly as in the spec: `m`, `r`, `b`+`d`, `s`, `k`+`d`, `t` (viewer → Mac); `locked`, `control`+`size` (Mac → viewer).
- `console-next/lib/control.js` and `mobile/src/control.ts` behave identically and carry identical text (`CONTROL_MESSAGES`, `KEYS_ROW`).
- Control UI appears only after the Mac sends `"control":"ok"`; a Mac app without control stays view-only.
- Mac: nothing is injected unless Accessibility is granted and **Allow remote control** is on; every held key and button is released when the channel closes, control turns off, or the session stops.
- Live injection on this Mac moves the owner's real pointer: run it only after the user says go in chat.
- Never touch `console-next/.data/state.json`. Local testing uses the `macwake-console-test` preview (port 3003, `NTFY_URL=off`).
- `console-next/` is its own git repo (`TarunPandat/MacWake-Console`): work on branch `feat/remote-control` there too, then bump the gitlink in the outer repo.
- Commit messages: plain imperative sentence, then a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Mac app version 1.6 (build 7).

## Review Focus

1. Connection drops, or control is switched off, while a finger, mouse button or ⌘ is held: the Mac must let go of everything (Task 3 code path, checked live in Task 6 Step 6).
2. React Native fires both Grant and Start for the first touch, and both End and Release for the last: no doubled clicks (Task 1 and Task 2 tests "duplicate down" / "unknown up").
3. A mouse click in the black letterbox bars must do nothing, not click the screen's edge (Task 1 test on `fraction(...).inside`; glue in Task 4 checks it).
4. A viewer connected to a Mac app without control (1.5) shows no control buttons and no errors (Task 4 Step 5 and Task 5 Step 8 checks: buttons gated on `control === "ok"`).
5. A second finger landing during a long-press drag must release the button, not leave it stuck (Task 1 test "second finger during a drag").

---

### Task 1: Shared control logic (web)

**Files:**
- Create: `console-next/lib/control.js`
- Modify: `console-next/test.mjs` (append at the end)

**Interfaces:**
- Produces (used by Task 4, mirrored in Task 2):
  - `CONTROL_MESSAGES: { off: string, permission: string }`
  - `SLOP = 10`, `LONG_PRESS = 500`, `TWO_TAP = 300`, `SENTINEL = " "`
  - `fraction(x, y, box: {w,h}, size: [w,h]) -> { at: [fx, fy], inside: boolean }`
  - `createGestures(mode: "direct"|"trackpad", view: () => { box: {w,h}, size: [w,h] })` → `{ state, down(id,x,y,t), move(id,x,y,t), up(id,t), tick(t) -> boolean, cancel() }`, each of down/move/up/cancel returning `Msg[]`
  - `wheel(dx, dy, deltaMode, pageHeight) -> { s: [dx, dy] }`
  - `mouseButton(button) -> 0 | 1 | null`
  - `charToCode(ch) -> { code, shift } | null`
  - `createKeys()` → `{ latched() -> string[], toggle(mod), press(code, shift?) -> Msg[], type(text) -> Msg[] }`, mods `"meta" | "alt" | "ctrl" | "shift"`
  - `KEYS_ROW: { label, say, key?, mod? }[]`
  - `edit(next) -> { backspace: true } | { text }`
  - `createHeld()` → `{ key(code, down: boolean) -> Msg[], releaseAll() -> Msg[] }`
  - `createSender(send: (msg) => void, schedule: (fn) => void) -> (msgs: Msg[]) => void`

- [ ] **Step 1: Branch the console repo**

```bash
git -C console-next switch -c feat/remote-control
```

- [ ] **Step 2: Write the failing tests** (append to `console-next/test.mjs`)

```js

// Remote control (mirrored in mobile/src/control.ts).
const C = await import("./lib/control.js");
eq(C.fraction(200, 50, { w: 400, h: 100 }, [200, 100]), { at: [0.5, 0.5], inside: true }, "letterboxed center");
eq(C.fraction(10, 50, { w: 400, h: 100 }, [200, 100]), { at: [0, 0.5], inside: false }, "a click in the side bar is outside, clamped to the edge");

const view = () => ({ box: { w: 200, h: 100 }, size: [200, 100] });
let g = C.createGestures("direct", view);
eq(g.down(1, 50, 50, 0), [], "a touch waits to see what it becomes");
eq(g.down(1, 50, 50, 5), [], "duplicate down is ignored");
eq(g.up(1, 100), [{ m: [0.25, 0.5] }, { b: 0, d: 1 }, { b: 0, d: 0 }], "direct tap clicks there");
eq(g.up(1, 110), [], "unknown up is ignored");
g.down(1, 50, 50, 0);
eq(g.move(1, 55, 50, 10), [], "within slop");
eq(g.move(1, 50, 30, 20), [{ m: [0.25, 0.5] }, { s: [0, 20] }], "dragging up scrolls down, from where the finger started");
eq(g.move(1, 50, 20, 30), [{ s: [0, 10] }], "and keeps scrolling");
eq(g.up(1, 40), [], "no click after a scroll");
g.down(1, 50, 50, 0);
eq(g.tick(400), false, "not yet a long press");
eq(g.tick(500), true, "long press");
eq(g.state, "held", "held");
eq(g.up(1, 600), [{ m: [0.25, 0.5] }, { b: 1, d: 1 }, { b: 1, d: 0 }], "long press, release: right click there");
g.down(1, 50, 50, 0); g.tick(500);
eq(g.move(1, 80, 50, 600), [{ m: [0.25, 0.5] }, { b: 0, d: 1 }, { m: [0.4, 0.5] }], "long press, then drag: holds the button");
eq(g.move(1, 90, 60, 610), [{ m: [0.45, 0.6] }], "drag follows the finger");
eq(g.up(1, 700), [{ b: 0, d: 0 }], "drop");
g.down(1, 50, 50, 0);
eq(g.down(2, 80, 50, 10), [], "second finger in direct mode belongs to zoom");
eq(g.up(1, 50), [], "so no click");
eq(g.up(2, 60), [], "nothing at all");
eq(g.state, "idle", "back to idle");
g.down(1, 50, 50, 0); g.tick(500); g.move(1, 80, 50, 600);
eq(g.down(2, 120, 50, 650), [{ b: 0, d: 0 }], "second finger during a drag lets go of the button");
g.up(1, 700); g.up(2, 710);
g.down(1, 50, 50, 0); g.tick(500); g.move(1, 80, 50, 600);
eq(g.cancel(), [{ b: 0, d: 0 }], "cancel lets go of a held button");
eq(g.state, "idle", "and resets");
g = C.createGestures("direct", () => ({ box: { w: 400, h: 200 }, size: [200, 100] }));
g.down(1, 100, 100, 0);
eq(g.move(1, 100, 80, 10), [{ m: [0.25, 0.5] }, { s: [0, 10] }], "scroll is in Mac points, not screen pixels");

g = C.createGestures("trackpad", view);
g.down(1, 50, 50, 0);
eq(g.up(1, 100), [{ b: 0, d: 1 }, { b: 0, d: 0 }], "trackpad tap clicks at the pointer");
g.down(1, 50, 50, 0);
eq(g.move(1, 70, 50, 100), [{ r: [0.15, 0] }], "slow drag moves the pointer 1.5x");
eq(g.move(1, 110, 50, 110), [{ r: [0.6, 0] }], "fast drag moves it 3x");
eq(g.up(1, 120), [], "no click after moving");
g.down(1, 50, 50, 0); g.tick(500);
eq(g.up(1, 600), [{ b: 1, d: 1 }, { b: 1, d: 0 }], "trackpad long press right clicks at the pointer");
g.down(1, 50, 50, 0); g.tick(500);
eq(g.move(1, 70, 50, 1600), [{ b: 0, d: 1 }, { r: [0.15, 0] }], "long press then drag holds the button");
eq(g.up(1, 1700), [{ b: 0, d: 0 }], "drop");
g.down(1, 50, 50, 0);
eq(g.down(2, 90, 50, 50), [], "two fingers");
eq(g.up(1, 200), [{ b: 1, d: 1 }, { b: 1, d: 0 }], "two-finger tap right clicks");
eq(g.up(2, 210), [], "the other finger lifts quietly");
g.down(1, 50, 50, 0); g.down(2, 90, 50, 10);
eq(g.move(1, 50, 30, 50), [{ s: [0, 10] }], "two-finger drag scrolls by the midpoint");
eq(g.move(2, 90, 30, 60), [{ s: [0, 10] }], "both fingers");
eq(g.up(1, 400), [], "no right click after scrolling");
g.up(2, 410);
eq(g.state, "idle", "all fingers up");

eq(C.wheel(0, 3, 1, 800), { s: [0, 48] }, "line scrolling");
eq(C.wheel(0, 1, 2, 800), { s: [0, 800] }, "page scrolling");
eq(C.wheel(2.5, -7, 0, 800), { s: [2.5, -7] }, "pixels pass through");
eq([0, 1, 2, 3].map(C.mouseButton), [0, null, 1, null], "left and right buttons only");
eq(["c", "C", "7", "&", " ", "\n", "/", "é"].map(C.charToCode), [
  { code: "KeyC", shift: false }, { code: "KeyC", shift: true }, { code: "Digit7", shift: false }, { code: "Digit7", shift: true },
  { code: "Space", shift: false }, { code: "Enter", shift: false }, { code: "Slash", shift: false }, null,
], "US layout keys");

const keys = C.createKeys();
eq(keys.type("hi"), [{ t: "hi" }], "plain typing is text");
keys.toggle("meta");
eq(keys.latched(), ["meta"], "latched");
eq(keys.type("c"), [{ k: "MetaLeft", d: 1 }, { k: "KeyC", d: 1 }, { k: "KeyC", d: 0 }, { k: "MetaLeft", d: 0 }], "⌘ then c is ⌘C");
eq(keys.latched(), [], "a latch is used once");
keys.toggle("meta"); keys.toggle("shift");
eq(keys.press("ArrowLeft"), [
  { k: "MetaLeft", d: 1 }, { k: "ShiftLeft", d: 1 }, { k: "ArrowLeft", d: 1 }, { k: "ArrowLeft", d: 0 }, { k: "ShiftLeft", d: 0 }, { k: "MetaLeft", d: 0 },
], "⌘⇧← from the keys row");
keys.toggle("ctrl"); keys.toggle("ctrl");
eq(keys.latched(), [], "a second tap unlatches");
keys.toggle("meta");
eq(keys.type("ab"), [{ k: "MetaLeft", d: 1 }, { k: "KeyA", d: 1 }, { k: "KeyA", d: 0 }, { k: "MetaLeft", d: 0 }, { t: "b" }], "only the first character gets the latch");
keys.toggle("alt");
eq(keys.type("éx"), [{ t: "éx" }], "a character with no key types as text and drops the latch");
eq(keys.latched(), [], "dropped");
eq(C.KEYS_ROW.map(k => k.label).join(" "), "esc tab ⌘ ⌥ ⌃ ⇧ ← ↑ ↓ →", "keys row");

eq(C.edit(""), { backspace: true }, "the space was deleted: Backspace");
eq(C.edit(" a"), { text: "a" }, "typed after the space");
eq(C.edit("a "), { text: "a" }, "typed before it");
eq(C.edit("  "), { text: " " }, "typed a space");
eq(C.edit(" "), { text: "" }, "nothing changed");

const held = C.createHeld();
eq(held.key("MetaLeft", true), [{ k: "MetaLeft", d: 1 }], "⌘ down");
held.key("KeyC", true);
eq(held.key("MetaLeft", false), [{ k: "MetaLeft", d: 0 }, { k: "KeyC", d: 0 }], "letting go of ⌘ releases keys whose keyup the browser swallowed");
held.key("KeyA", true);
eq(held.releaseAll(), [{ k: "KeyA", d: 0 }], "blur releases everything still held");
eq(held.key("", true), [], "keys without a code are ignored");

const sent = [], later = [];
const send = C.createSender(m => sent.push(m), f => later.push(f));
send([{ m: [0.1, 0.1] }, { m: [0.2, 0.2] }, { r: [0.1, 0] }, { r: [0.1, 0.1] }]);
eq(sent, [{ m: [0.2, 0.2] }], "moves collapse to the last one; another kind flushes it");
send([{ b: 0, d: 1 }]);
eq(sent, [{ m: [0.2, 0.2] }, { r: [0.2, 0.1] }, { b: 0, d: 1 }], "a click flushes pending movement first, in order");
later.forEach(f => f());
eq(sent.length, 3, "the frame flush finds nothing left");
eq(later.length, 1, "one frame was asked for");

eq(Object.keys(C.CONTROL_MESSAGES).sort(), ["off", "permission"], "every control status has text");
console.log("control ok");
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npm --prefix console-next test`
Expected: FAIL with `Cannot find module` … `lib/control.js`.

- [ ] **Step 4: Write `console-next/lib/control.js`**

```js
// Viewer-side remote control: turns mouse, touches and keys into the messages the Mac injects. Wire format:
// docs/superpowers/specs/2026-10-11-remote-control-design.md. Pure (no DOM), so `npm test` runs it under Node.
// Mirrored in mobile/src/control.ts: keep behavior and text identical.

export const CONTROL_MESSAGES = {
  off: "Remote control is turned off on the Mac.",
  permission: "To control the Mac, allow MacWake under System Settings → Privacy & Security → Accessibility on the Mac.",
};

export const SLOP = 10;          // px a finger may wander and still count as a tap
export const LONG_PRESS = 500;   // ms
export const TWO_TAP = 300;      // ms, two-finger tap (trackpad right click)
const GAIN = 1.5, FAST = 0.8;    // trackpad: pointer moves 1.5x the finger, twice that above 0.8 px/ms

const clamp = v => Math.min(1, Math.max(0, v));
const r4 = v => Math.round(v * 1e4) / 1e4;
const r1 = v => Math.round(v * 10) / 10;

/** Element px -> screen fractions for a picture drawn with object-fit: contain. `inside` is false in the bars. */
export function fraction(x, y, box, size) {
  const k = Math.min(box.w / size[0], box.h / size[1]);
  const fx = (x - (box.w - size[0] * k) / 2) / (size[0] * k);
  const fy = (y - (box.h - size[1] * k) / 2) / (size[1] * k);
  return { at: [r4(clamp(fx)), r4(clamp(fy))], inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
}

/**
 * Touch gestures -> messages. `mode` is "direct" (tap where you want to click) or "trackpad" (the finger moves the
 * pointer). `view()` returns { box: {w, h} element px, size: [w, h] Mac points }. down/move/up/cancel return the
 * messages to send; tick(t), called LONG_PRESS ms after a touch starts, returns true when it became a long press.
 */
export function createGestures(mode, view) {
  const direct = mode === "direct";
  const touches = new Map();   // id -> { x0, y0, x, y }
  let state = "idle", since = 0, twoAt = 0, prev = { x: 0, y: 0 }, prevT = 0;
  const scale = () => { const { box, size } = view(); return Math.min(box.w / size[0], box.h / size[1]); };
  const point = (x, y) => { const { box, size } = view(); return { m: fraction(x, y, box, size).at }; };
  const scroll = (dx, dy) => { const k = scale(); return { s: [r1(-dx / k), r1(-dy / k)] }; };   // content follows the finger
  const nudge = (dx, dy, dt) => {
    const k = scale(), { size } = view();
    const g = GAIN * (Math.hypot(dx, dy) / Math.max(dt, 1) > FAST ? 2 : 1);
    return { r: [r4((dx * g) / (size[0] * k)), r4((dy * g) / (size[1] * k))] };
  };
  const far = p => Math.hypot(p.x - p.x0, p.y - p.y0) > SLOP;
  const centroid = () => {
    let x = 0, y = 0;
    for (const p of touches.values()) { x += p.x; y += p.y; }
    return { x: x / touches.size, y: y / touches.size };
  };
  const click = (b, p) => [...(direct ? [point(p.x0, p.y0)] : []), { b, d: 1 }, { b, d: 0 }];
  const letGo = () => (state === "drag" ? [{ b: 0, d: 0 }] : []);

  return {
    get state() { return state; },
    down(id, x, y, t) {
      if (touches.has(id)) return [];
      touches.set(id, { x0: x, y0: y, x, y });
      if (touches.size === 1) { state = "pending"; since = prevT = t; prev = { x, y }; return []; }
      if (!direct && touches.size === 2 && (state === "pending" || state === "move")) {
        for (const p of touches.values()) { p.x0 = p.x; p.y0 = p.y; }
        state = "two"; twoAt = t; prev = centroid();
        return [];
      }
      const out = letGo();   // more fingers than the gesture uses (direct: the iOS zoom pinch): wait until all lift
      state = "ignore";
      return out;
    },
    move(id, x, y, t) {
      const p = touches.get(id);
      if (!p) return [];
      p.x = x; p.y = y;
      const dt = t - prevT;
      let out;
      switch (state) {
        case "pending":
          if (!far(p)) return [];
          if (direct) { state = "scroll"; out = [point(p.x0, p.y0), scroll(x - p.x0, y - p.y0)]; }
          else { state = "move"; out = [nudge(x - p.x0, y - p.y0, dt)]; }
          break;
        case "scroll": out = [scroll(x - prev.x, y - prev.y)]; break;
        case "move": out = [nudge(x - prev.x, y - prev.y, dt)]; break;
        case "held":
          if (!far(p)) return [];
          state = "drag";
          out = direct ? [point(p.x0, p.y0), { b: 0, d: 1 }, point(x, y)] : [{ b: 0, d: 1 }, nudge(x - p.x0, y - p.y0, dt)];
          break;
        case "drag": out = [direct ? point(x, y) : nudge(x - prev.x, y - prev.y, dt)]; break;
        case "two":
          if (![...touches.values()].some(far)) return [];
          state = "twoScroll";
        // falls through
        case "twoScroll": {
          const c = centroid();
          out = [scroll(c.x - prev.x, c.y - prev.y)];
          prev = c; prevT = t;
          return out;
        }
        default: return [];
      }
      prev = { x, y }; prevT = t;
      return out;
    },
    up(id, t) {
      const p = touches.get(id);
      if (!p) return [];
      touches.delete(id);
      const out = state === "pending" ? click(0, p)
        : state === "held" ? click(1, p)
        : state === "two" && t - twoAt < TWO_TAP ? click(1, p)
        : letGo();
      state = touches.size ? "ignore" : "idle";
      return out;
    },
    tick(t) {
      if (state !== "pending" || t - since < LONG_PRESS) return false;
      state = "held";
      return true;
    },
    cancel() {
      const out = letGo();
      touches.clear(); state = "idle";
      return out;
    },
  };
}

/** WheelEvent deltas -> scroll message in points (line mode: 16 a line, page mode: one screen). */
export function wheel(dx, dy, deltaMode, page) {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? page : 1;
  return { s: [r1(dx * k), r1(dy * k)] };
}

/** Browser mouse button -> wire button (0 left, 1 right); others are ignored. */
export const mouseButton = b => (b === 0 ? 0 : b === 2 ? 1 : null);

const PLAIN = { "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", ";": "Semicolon",
  "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote", " ": "Space", "\n": "Enter", "\t": "Tab" };
const SHIFTED = { "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5", "^": "Digit6", "&": "Digit7",
  "*": "Digit8", "(": "Digit9", ")": "Digit0", "_": "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight",
  "|": "Backslash", ":": "Semicolon", "\"": "Quote", "<": "Comma", ">": "Period", "?": "Slash", "~": "Backquote" };

/** A typed character -> the US-layout key that makes it, or null. Used only while a modifier is latched. */
export function charToCode(ch) {
  if (/^[a-z]$/.test(ch)) return { code: "Key" + ch.toUpperCase(), shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: "Key" + ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { code: "Digit" + ch, shift: false };
  if (ch in PLAIN) return { code: PLAIN[ch], shift: false };
  if (ch in SHIFTED) return { code: SHIFTED[ch], shift: true };
  return null;
}

const MODIFIERS = { meta: "MetaLeft", alt: "AltLeft", ctrl: "ControlLeft", shift: "ShiftLeft" };

/** The Mac keys row, in order. `mod` keys latch (sticky); the others are pressed once. */
export const KEYS_ROW = [
  { label: "esc", say: "Escape", key: "Escape" },
  { label: "tab", say: "Tab", key: "Tab" },
  { label: "⌘", say: "Command", mod: "meta" },
  { label: "⌥", say: "Option", mod: "alt" },
  { label: "⌃", say: "Control", mod: "ctrl" },
  { label: "⇧", say: "Shift", mod: "shift" },
  { label: "←", say: "Left arrow", key: "ArrowLeft" },
  { label: "↑", say: "Up arrow", key: "ArrowUp" },
  { label: "↓", say: "Down arrow", key: "ArrowDown" },
  { label: "→", say: "Right arrow", key: "ArrowRight" },
];

/**
 * Sticky ⌘ ⌥ ⌃ ⇧ from the keys row. A tap latches a modifier; it is held around the next key or typed character,
 * then released. A second tap unlatches it.
 */
export function createKeys() {
  const latched = new Set();
  const press = (code, shift = false) => {
    const mods = [...latched].map(n => MODIFIERS[n]);
    if (shift && !latched.has("shift")) mods.push(MODIFIERS.shift);
    latched.clear();
    return [...mods.map(k => ({ k, d: 1 })), { k: code, d: 1 }, { k: code, d: 0 }, ...[...mods].reverse().map(k => ({ k, d: 0 }))];
  };
  const type = text => {
    if (!text) return [];
    const [ch] = text;
    const c = latched.size ? charToCode(ch) : null;
    if (!c) { latched.clear(); return [{ t: text }]; }
    const rest = text.slice(ch.length);
    return [...press(c.code, c.shift), ...(rest ? [{ t: rest }] : [])];
  };
  return {
    latched: () => [...latched],
    toggle: mod => { if (latched.has(mod)) latched.delete(mod); else latched.add(mod); },
    press,
    type,
  };
}

/** The phone keyboard's hidden input always holds this, so Backspace shows up as a deleted space. */
export const SENTINEL = " ";

/** What the phone keyboard did to the hidden input's value. */
export const edit = next => (next === "" ? { backspace: true } : { text: next.replace(SENTINEL, "") });

const MODIFIER_CODES = new Set(["MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "ControlLeft", "ControlRight", "CapsLock"]);

/**
 * Physical keys from a real keyboard. Tracks what is held so nothing stays stuck on the Mac: macOS browsers send no
 * keyup for keys released while ⌘ is down, so letting go of ⌘ releases them too.
 */
export function createHeld() {
  const held = new Set();
  return {
    key(code, down) {
      if (!code) return [];
      if (down) { held.add(code); return [{ k: code, d: 1 }]; }
      held.delete(code);
      const out = [{ k: code, d: 0 }];
      if (code === "MetaLeft" || code === "MetaRight")
        for (const k of [...held]) if (!MODIFIER_CODES.has(k)) { held.delete(k); out.push({ k, d: 0 }); }
      return out;
    },
    releaseAll() {
      const out = [...held].map(k => ({ k, d: 0 }));
      held.clear();
      return out;
    },
  };
}

/**
 * Sends at most one pointer message per frame: the last `m`, summed `r` and `s`. Anything else goes out at once,
 * after whatever movement is pending, so order is kept. `schedule(fn)` runs fn on the next frame.
 */
export function createSender(send, schedule) {
  let pending = null, queued = false;
  const flush = () => { if (pending) send(pending); pending = null; };
  return msgs => {
    for (const msg of msgs) {
      const kind = ["m", "r", "s"].find(k => k in msg);
      if (kind && pending && kind in pending)
        pending = kind === "m" ? msg : { [kind]: [pending[kind][0] + msg[kind][0], pending[kind][1] + msg[kind][1]] };
      else { flush(); if (kind) pending = msg; else send(msg); }
    }
    if (pending && !queued) { queued = true; schedule(() => { queued = false; flush(); }); }
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm --prefix console-next test`
Expected: ends with `viewer ok` then `control ok`, exit 0.

- [ ] **Step 6: Commit (console repo)**

```bash
git -C console-next add lib/control.js test.mjs
git -C console-next commit -m "Add viewer logic for remote control

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared control logic (app mirror)

**Files:**
- Create: `mobile/src/control.ts`, `mobile/src/control.check.ts`
- Modify: `mobile/package.json` (`test:core` script)

**Interfaces:**
- Consumes: the behavior of Task 1 (same names, same results).
- Produces (used by Task 5): everything Task 1 exports, typed, plus
  - `type Mode = 'direct' | 'trackpad'`, `type Mod = 'meta' | 'alt' | 'ctrl' | 'shift'`, `type ControlStatus = 'ok' | 'off' | 'permission'`
  - `type Msg = { [key: string]: number[] | number | string }`, `type PictureView = { box: { w: number; h: number }; size: number[] }`
  - `hidToCode(usage: number): string | null` (iOS HID usage → `KeyboardEvent.code`)

- [ ] **Step 1: Write the failing tests** (`mobile/src/control.check.ts`)

Port every assertion of Task 1 Step 2 one-to-one (same inputs, same expected values, `'single quotes'`, `import { … } from './control.ts'`, the same `eq` helper as `src/core.check.ts`, typed `const sent: Msg[] = []; const later: (() => void)[] = [];`), then add before the final log:

```ts
eq(
  [0x04, 0x1d, 0x1e, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x4f, 0x52, 0x3a, 0x45, 0xe3, 0xe6, 0x99].map(hidToCode),
  ['KeyA', 'KeyZ', 'Digit1', 'Digit0', 'Enter', 'Escape', 'Backspace', 'Tab', 'Space', 'ArrowRight', 'ArrowUp', 'F1', 'F12', 'MetaLeft', 'AltRight', null],
  'iPad hardware keys',
);

console.log('control ok');
```

- [ ] **Step 2: Add it to `test:core`** (`mobile/package.json`)

```json
    "test:core": "node --no-warnings src/core.check.ts && node --no-warnings src/control.check.ts"
```

- [ ] **Step 3: Run to see it fail**

Run: `cd mobile && npm run test:core`
Expected: `core ok`, then FAIL with `Cannot find module` … `control.ts`.

- [ ] **Step 4: Write `mobile/src/control.ts`**

A typed port of Task 1 Step 4's `control.js`, same order, same comments, same constants and texts, Prettier style (single quotes, trailing commas, `arrowParens: avoid`). Types:

```ts
export type Mode = 'direct' | 'trackpad';
export type Mod = 'meta' | 'alt' | 'ctrl' | 'shift';
export type ControlStatus = 'ok' | 'off' | 'permission';
export type Msg = { [key: string]: number[] | number | string };
export type PictureView = { box: { w: number; h: number }; size: number[] };
type Touch = { x0: number; y0: number; x: number; y: number };
type State = 'idle' | 'pending' | 'scroll' | 'move' | 'held' | 'drag' | 'two' | 'twoScroll' | 'ignore';
```

Signatures: `CONTROL_MESSAGES: Record<'off' | 'permission', string>`; `createGestures(mode: Mode, view: () => PictureView)` with `touches = new Map<string | number, Touch>()` and methods returning `Msg[]` (`tick` returns `boolean`); `KEYS_ROW: { label: string; say: string; key?: string; mod?: Mod }[]`; `createKeys()` with `new Set<Mod>()` and `MODIFIERS: Record<Mod, string>`; `edit(next: string): { backspace?: true; text?: string }`; `createSender(send: (msg: Msg) => void, schedule: (fn: () => void) => void)`, where summing reads `pending[kind] as number[]`. Then append:

```ts
const HID: Record<number, string> = {
  0x28: 'Enter',
  0x29: 'Escape',
  0x2a: 'Backspace',
  0x2b: 'Tab',
  0x2c: 'Space',
  0x2d: 'Minus',
  0x2e: 'Equal',
  0x2f: 'BracketLeft',
  0x30: 'BracketRight',
  0x31: 'Backslash',
  0x33: 'Semicolon',
  0x34: 'Quote',
  0x35: 'Backquote',
  0x36: 'Comma',
  0x37: 'Period',
  0x38: 'Slash',
  0x39: 'CapsLock',
  0x49: 'Insert',
  0x4a: 'Home',
  0x4b: 'PageUp',
  0x4c: 'Delete',
  0x4d: 'End',
  0x4e: 'PageDown',
  0x4f: 'ArrowRight',
  0x50: 'ArrowLeft',
  0x51: 'ArrowDown',
  0x52: 'ArrowUp',
  0x64: 'IntlBackslash',
  0xe0: 'ControlLeft',
  0xe1: 'ShiftLeft',
  0xe2: 'AltLeft',
  0xe3: 'MetaLeft',
  0xe4: 'ControlRight',
  0xe5: 'ShiftRight',
  0xe6: 'AltRight',
  0xe7: 'MetaRight',
};

/** iOS hardware key (HID usage, keyboard page) -> browser KeyboardEvent.code, the wire's key names. */
export function hidToCode(usage: number): string | null {
  if (usage >= 0x04 && usage <= 0x1d) return 'Key' + String.fromCharCode(65 + usage - 0x04);
  if (usage >= 0x1e && usage <= 0x26) return 'Digit' + (usage - 0x1d);
  if (usage === 0x27) return 'Digit0';
  if (usage >= 0x3a && usage <= 0x45) return 'F' + (usage - 0x39);
  return HID[usage] ?? null;
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd mobile && npm run test:core && npx tsc --noEmit && npx prettier --check src/control.ts`
Expected: `core ok`, `control ok`, no type errors, Prettier clean.

- [ ] **Step 6: Commit**

```bash
git add mobile/src/control.ts mobile/src/control.check.ts mobile/package.json
git commit -m "Add the app's remote control logic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Mac injector, permission, menu and icon

**Files:**
- Create: `mac/Sources/Control.swift`
- Modify: `mac/Sources/Screen.swift` (ScreenShare properties, `answer`, ViewSession fields/init/start/status/data channel/stop)
- Modify: `mac/Sources/main.swift` (imports, App properties, `startScreen`, menu, setup)
- Modify: `mac/Info.plist` (version 1.6, build 7)

**Interfaces:**
- Consumes: wire messages from Tasks 1–2.
- Produces: `func askAccessibility()`, `final class Injector { init(display:); var bounds: CGRect; func handle(_ msg: [String: Any]); func releaseAll() }`; `ScreenShare.controlAllowed: () -> Bool`, `ScreenShare.onInput: () -> Void`; data-channel status `{"control": "ok"|"off"|"permission", "size": [w, h]}`.

- [ ] **Step 1: Write `mac/Sources/Control.swift`**

```swift
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
        post(e)
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
```

- [ ] **Step 2: Wire it into `mac/Sources/Screen.swift`**

2a. In `ScreenShare`, after `var allowed: () -> Bool = { true }` add:

```swift
    /// The menu's "Allow remote control".
    var controlAllowed: () -> Bool = { true }
    /// Main queue: a viewer's input was just injected (the menu bar shows a pointer).
    var onInput: () -> Void = {}
```

2b. In `ScreenShare.answer`, replace `let s = ViewSession(ice: ice)` with:

```swift
        let s = ViewSession(ice: ice, controlAllowed: { [weak self] in self?.controlAllowed() ?? false },
                            onInput: { [weak self] in self?.onInput() })
```

2c. In `ViewSession`, replace `private var lockTimer: Timer?` and `private var sentLocked: Bool?` with:

```swift
    private var statusTimer: Timer?
    private var sentLocked: Bool?
    private var sentControl: String?
    private let controlAllowed: () -> Bool
    private let onInput: () -> Void
    private var injector: Injector?
    private var askedAccess = false
```

and replace the init's first lines `init(ice: [ScreenShare.Ice]) {` / `self.ice = ice` with:

```swift
    init(ice: [ScreenShare.Ice], controlAllowed: @escaping () -> Bool, onInput: @escaping () -> Void) {
        self.ice = ice
        self.controlAllowed = controlAllowed
        self.onInput = onInput
```

2d. In `ViewSession.start`, right after the `guard let display = … else { return done(.failure(ShareError(code: "no-display"))) }` statement add:

```swift
                self.injector = Injector(display: display.displayID)
```

2e. Replace `peerConnection(_:didOpen:)`, `dataChannelDidChangeState`, `dataChannel(_:didReceiveMessageWith:)` and `sendLocked()` with:

```swift
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        DispatchQueue.main.async {
            self.channel = dataChannel
            dataChannel.delegate = self
            self.statusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.sendStatus() }
        }
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        DispatchQueue.main.async {
            self.sentLocked = nil; self.sentControl = nil
            if dataChannel.readyState != .open { self.injector?.releaseAll() }
            self.sendStatus()
        }
    }

    /// Viewer input. Injected only while control is allowed and Accessibility is granted; asks for it once otherwise.
    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, let msg = (try? JSONSerialization.jsonObject(with: buffer.data)) as? [String: Any] else { return }
        DispatchQueue.main.async {
            guard !self.stopped, let injector = self.injector else { return }
            switch self.controlStatus() {
            case "ok": injector.handle(msg); self.onInput()
            case "permission": if !self.askedAccess { self.askedAccess = true; askAccessibility() }
            default: break
            }
        }
    }

    private func controlStatus() -> String { !controlAllowed() ? "off" : AXIsProcessTrusted() ? "ok" : "permission" }

    /// Tells the viewer when the Mac is at the lock screen and whether it may control it. On change; 1 s timer.
    private func sendStatus() {
        guard let c = channel, c.readyState == .open else { return }
        let locked = (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
        if locked != sentLocked, send(["locked": locked], on: c) { sentLocked = locked }
        let control = controlStatus()
        guard control != sentControl else { return }
        if control != "ok" { injector?.releaseAll() }
        let size = injector.map { [Int($0.bounds.width), Int($0.bounds.height)] } ?? [16, 10]
        if send(["control": control, "size": size], on: c) { sentControl = control }
    }

    private func send(_ obj: [String: Any], on c: RTCDataChannel) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return false }
        return c.sendData(RTCDataBuffer(data: data, isBinary: false))
    }
```

2f. In `ViewSession.stop()`, replace `dropTimer?.cancel(); lockTimer?.invalidate(); repeater?.cancel()` with:

```swift
        dropTimer?.cancel(); statusTimer?.invalidate(); repeater?.cancel()
        injector?.releaseAll(); injector = nil
```

- [ ] **Step 3: Wire the menu and icon in `mac/Sources/main.swift`**

3a. Add `import ApplicationServices` after `import AppKit`.

3b. In `App`, after the `screenAllowed` property add:

```swift
    /// "Allow remote control": on unless the user turned it off on this Mac. Also needs Accessibility.
    var controlAllowed: Bool {
        get { UserDefaults.standard.object(forKey: "remoteControl") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "remoteControl") }
    }
    var live = false                         // a viewer is connected
    var lastInput = Date.distantPast        // last injected input, for the icon
    var iconTimer: Timer?
```

3c. Replace `startScreen(url:token:)` with:

```swift
    func startScreen(url: String, token: String) {
        let s = ScreenShare(url: url, token: token)
        s.allowed = { [weak self] in self?.screenAllowed ?? false }
        s.controlAllowed = { [weak self] in self?.controlAllowed ?? false }
        s.onLive = { [weak self] live in
            guard let self else { return }
            self.live = live
            self.iconTimer?.invalidate()
            self.iconTimer = live ? Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.setIcon() } : nil
            self.setIcon()
        }
        s.onInput = { [weak self] in
            guard let self else { return }
            let was = Date().timeIntervalSince(self.lastInput) < 5
            self.lastInput = Date()
            if !was { self.setIcon() }
        }
        s.start()
        screen = s
    }

    /// Menu-bar icon: asleep, watched (eye), or controlled (pointer, until 5 s after the last input).
    func setIcon() {
        let controlled = live && Date().timeIntervalSince(lastInput) < 5
        let (name, label) = controlled ? ("cursorarrow.motionlines", "MacWake: someone is controlling this Mac")
            : live ? ("eye", "MacWake: someone is viewing the screen") : ("powersleep", "MacWake")
        item.button?.image = NSImage(systemSymbolName: name, accessibilityDescription: label)
    }

    @objc func toggleControl() {
        controlAllowed.toggle()
        if controlAllowed && !AXIsProcessTrusted() { askAccessibility() }
    }
```

3d. In `rebuild()`, after the `Allow screen viewing` line add:

```swift
            add("Allow remote control", #selector(toggleControl)).state = controlAllowed ? .on : .off
```

3e. In `setup()`, after `_ = CGRequestScreenCaptureAccess()      // once: …` add:

```swift
        askAccessibility()                      // once: macOS asks to allow Accessibility, for remote control
```

- [ ] **Step 4: Bump the version** (`mac/Info.plist`)

Set `CFBundleShortVersionString` to `1.6` and `CFBundleVersion` to `7`.

- [ ] **Step 5: Build**

Run: `CONSOLE_URL=https://mac-wake-console.vercel.app sh mac/build.sh`
Expected: `built: dist/MacWake.app and dist/MacWake.dmg`, no Swift errors. Fix any compile error in the files above before moving on.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources mac/Info.plist mac/dist
git commit -m "Let viewers control the Mac's mouse and keyboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web console viewer UI

**Files:**
- Create: `console-next/app/Controls.js`
- Modify (full replace): `console-next/app/Viewer.js`
- Modify: `console-next/app/globals.css` (after `.viewer-bar.hidden`)

**Interfaces:**
- Consumes (Task 1): `createGestures`, `createHeld`, `createKeys`, `createSender`, `edit`, `fraction`, `KEYS_ROW`, `LONG_PRESS`, `mouseButton`, `SENTINEL`, `wheel`, `CONTROL_MESSAGES`.
- Produces: `usePicture(mode, size, send, enabled) -> { ref, handlers, ring }`, `useKeys(send) -> { latched, press, type, toggle }`, `useKeyboard(enabled, send, skip, onEscape)`, `useKeyboardInset() -> number`, `Typing` (forwardRef `{ keys, onBlur }`), `KeysRow({ keys, bottom })`.

- [ ] **Step 1: Write `console-next/app/Controls.js`**

```js
"use client";
// Remote control glue for the viewer: the real mouse and keyboard, touches on the picture, the phone keyboard and
// the Mac keys row. Decisions live in lib/control.js; mirrored in mobile/src/Controls.tsx.
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { createGestures, createHeld, createKeys, edit, fraction, KEYS_ROW, LONG_PRESS, mouseButton, SENTINEL, wheel } from "../lib/control.js";

/** Pointer handlers for the picture. The mouse goes straight through; touches and pens go through the gestures. */
export function usePicture(mode, size, send, enabled) {
  const ref = useRef(null);
  const [ring, setRing] = useState(null);
  const latest = useRef({ size, send, enabled });
  latest.current = { size, send, enabled };
  const box = useRef({ w: 1, h: 1 });
  const timer = useRef();
  const g = useMemo(() => createGestures(mode, () => ({ box: box.current, size: latest.current.size })), [mode]);

  useEffect(() => {   // non-passive, so scrolling the Mac doesn't scroll the page
    const el = ref.current;
    if (!el) return;
    const onWheel = e => {
      if (!latest.current.enabled) return;
      e.preventDefault();
      latest.current.send([wheel(e.deltaX, e.deltaY, e.deltaMode, latest.current.size[1])]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const at = e => {
    const r = e.currentTarget.getBoundingClientRect();
    box.current = { w: r.width, h: r.height };
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const handlers = {
    onPointerDown: e => {
      const { enabled, send, size } = latest.current;
      if (!enabled) return;
      const [x, y] = at(e);
      if (e.pointerType === "mouse") {
        const b = mouseButton(e.button), f = fraction(x, y, box.current, size);
        if (b === null || !f.inside) return;   // a click in the black bars does nothing
        e.currentTarget.setPointerCapture(e.pointerId);
        send([{ m: f.at }, { b, d: 1 }]);
        return;
      }
      send(g.down(e.pointerId, x, y, performance.now()));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (g.tick(performance.now())) { setRing({ x, y }); navigator.vibrate?.(10); }
      }, LONG_PRESS + 20);
    },
    onPointerMove: e => {
      const { enabled, send, size } = latest.current;
      if (!enabled) return;
      const [x, y] = at(e);
      send(e.pointerType === "mouse" ? [{ m: fraction(x, y, box.current, size).at }] : g.move(e.pointerId, x, y, performance.now()));
    },
    onPointerUp: e => {
      const { enabled, send, size } = latest.current;
      if (!enabled) return;
      const [x, y] = at(e);
      if (e.pointerType === "mouse") {
        const b = mouseButton(e.button);
        if (b !== null) send([{ m: fraction(x, y, box.current, size).at }, { b, d: 0 }]);
        return;
      }
      send(g.up(e.pointerId, performance.now()));
      if (g.state === "idle") { clearTimeout(timer.current); setRing(null); }
    },
    onPointerCancel: e => {
      if (e.pointerType === "mouse") return;
      clearTimeout(timer.current);
      setRing(null);
      latest.current.send(g.cancel());
    },
    onContextMenu: e => { if (latest.current.enabled) e.preventDefault(); },
  };
  return { ref, handlers, ring };
}

/** Sticky ⌘ ⌥ ⌃ ⇧ from the keys row plus typed text; `latched` drives the row's highlight. */
export function useKeys(send) {
  const keys = useMemo(createKeys, []);
  const [latched, setLatched] = useState([]);
  const after = out => { send(out); setLatched(keys.latched()); };
  return {
    latched,
    press: code => after(keys.press(code)),
    type: text => after(keys.type(text)),
    toggle: mod => { keys.toggle(mod); setLatched(keys.latched()); },
  };
}

/**
 * The computer's own keyboard -> Mac keys while `enabled`. Skips the phone-keyboard input and key presses on the
 * viewer's buttons (so they work by keyboard); Shift+Escape calls `onEscape` instead of reaching the Mac, so keyboard
 * users can always get back to Close.
 */
export function useKeyboard(enabled, send, skip, onEscape) {
  const latest = useRef({ send, onEscape });
  latest.current = { send, onEscape };
  useEffect(() => {
    if (!enabled) return;
    const held = createHeld();
    const key = e => {
      const down = e.type === "keydown";
      if (e.target === skip.current) return;
      if (down && e.target.closest?.(".viewer-bar")) return;
      if (down && e.key === "Escape" && e.shiftKey) { e.preventDefault(); latest.current.onEscape(); return; }
      e.preventDefault();
      latest.current.send(held.key(e.code, down));
    };
    const blur = () => latest.current.send(held.releaseAll());
    addEventListener("keydown", key);
    addEventListener("keyup", key);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("keyup", key);
      removeEventListener("blur", blur);
      blur();
    };
  }, [enabled, skip]);
}

/** How far the on-screen keyboard covers the page bottom (0 when closed), so the keys row sits above it. */
export function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);
  return inset;
}

/** Hidden input for the phone keyboard. It always holds one space, so Backspace shows up as a deleted space. */
export const Typing = forwardRef(function Typing({ keys, onBlur }, ref) {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const el = ref.current;
    const take = () => {
      const r = edit(el.value);
      el.value = SENTINEL;
      el.setSelectionRange(1, 1);
      if (r.backspace) latest.current.press("Backspace");
      else if (r.text) latest.current.type(r.text);
    };
    const onInput = e => { if (!e.isComposing) take(); };
    const onKey = e => { if (e.key === "Enter") { e.preventDefault(); latest.current.press("Enter"); } };
    el.addEventListener("input", onInput);
    el.addEventListener("compositionend", take);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("compositionend", take);
      el.removeEventListener("keydown", onKey);
    };
  }, [ref]);
  return (
    <input ref={ref} className="viewer-input" defaultValue={SENTINEL} autoCapitalize="off" autoCorrect="off" autoComplete="off"
      spellCheck={false} enterKeyHint="enter" aria-label="Type on the Mac" onBlur={onBlur} />
  );
});

/** esc, tab, sticky ⌘ ⌥ ⌃ ⇧ and arrows, for what the phone keyboard lacks. */
export function KeysRow({ keys, bottom }) {
  const keep = e => e.preventDefault();   // don't take focus from the phone keyboard
  return (
    <div className="viewer-keys" style={bottom ? { bottom } : undefined} role="toolbar" aria-label="Mac keys">
      {KEYS_ROW.map(k => {
        const on = !!k.mod && keys.latched.includes(k.mod);
        return (
          <button key={k.label} className={on ? "on" : undefined} aria-label={k.say} aria-pressed={k.mod ? on : undefined}
            onPointerDown={keep} onMouseDown={keep} onClick={() => (k.mod ? keys.toggle(k.mod) : keys.press(k.key))}>
            {k.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Replace `console-next/app/Viewer.js`**

```js
"use client";
// Full-screen live view of the Mac over WebRTC, with mouse and keyboard control once the Mac allows it.
// Decisions live in lib/screen.js and lib/control.js (mirrored in mobile/src/core.ts and control.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { afterPoll, ANSWER_WAIT, needsWake, newId, SCREEN_MESSAGES } from "../lib/screen.js";
import { CONTROL_MESSAGES, createSender } from "../lib/control.js";
import { KeysRow, Typing, useKeyboard, useKeyboardInset, useKeys, usePicture } from "./Controls";

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
  const dc = useRef(null);
  const input = useRef(null);
  const close = useRef(null);
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [live, setLive] = useState(false);
  const [control, setControl] = useState(null);   // "ok" | "off" | "permission" from the Mac; null: a view-only Mac app
  const [size, setSize] = useState([16, 10]);     // the Mac's screen in points, for the picture's shape
  const [mode, setMode] = useState("direct");
  const [typing, setTyping] = useState(false);
  const [attempt, setAttempt] = useState(0);   // Try again re-runs the effect
  const touch = useMemo(() => matchMedia("(pointer: coarse)").matches, []);

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
        setError(""); setLive(false); setLocked(false); setControl(null); setStatus("Connecting…");
        let ph = (await api("state")).phase;
        if (needsWake(ph)) { await api("wake", {}); ph = "requested"; }
        const { ice } = await api("screen");
        while (!closed) {
          pc?.close();
          const conn = pc = new RTCPeerConnection({ iceServers: ice });
          conn.addTransceiver("video", { direction: "recvonly" });
          const ch = dc.current = conn.createDataChannel("control");
          ch.onmessage = e => {
            try {
              const d = JSON.parse(e.data);
              if ("locked" in d) setLocked(!!d.locked);
              if ("control" in d) { setControl(d.control); if (Array.isArray(d.size)) setSize(d.size); }
            } catch { /* not ours */ }
          };
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

  // Control: only once the Mac says so (a Mac app without control never does, and stays view-only).
  const send = useMemo(() => createSender(m => { if (dc.current?.readyState === "open") dc.current.send(JSON.stringify(m)); }, f => requestAnimationFrame(f)), []);
  const ok = live && !error && control === "ok";
  const pic = usePicture(mode, size, send, ok);
  const keys = useKeys(send);
  useKeyboard(ok, send, input, () => close.current?.focus());
  const kb = useKeyboardInset();
  useEffect(() => { if (!ok) setTyping(false); }, [ok]);
  const toggleTyping = () => {
    if (typing) { setTyping(false); input.current?.blur(); }
    else { setTyping(true); input.current?.focus(); }
  };

  const note = live && control && control !== "ok" ? CONTROL_MESSAGES[control] || "" : "";
  const msg = error || (locked && live ? "Mac is locked" : status) || note;
  // Once the picture is up, the Close bar fades after 3 s. A mouse brings it back by moving (while controlling: near
  // the bottom edge, so the Dock stays reachable); touch screens use the ••• button.
  const [bar, setBar] = useState(true);
  const hide = useRef();
  const showBar = () => { setBar(true); clearTimeout(hide.current); hide.current = setTimeout(() => setBar(false), 3000); };
  useEffect(() => {
    if (live && !msg) showBar(); else { clearTimeout(hide.current); setBar(true); }
    return () => clearTimeout(hide.current);
  }, [live, msg]); // eslint-disable-line react-hooks/exhaustive-deps
  const keep = e => e.preventDefault();   // the Keys button must not take focus from the phone keyboard
  return (
    <div className="viewer" role="dialog" aria-label="Mac screen"
      onPointerMove={e => { if (e.pointerType === "mouse" && live && !msg && (!ok || e.clientY > innerHeight - 90)) showBar(); }}>
      <video ref={el => { video.current = el; pic.ref.current = el; }} className={ok ? "control" : undefined} autoPlay playsInline muted
        aria-describedby={ok ? "viewer-hint" : undefined} {...pic.handlers} />
      {ok && <p id="viewer-hint" className="sr-only">Mouse and keys go to the Mac. Shift+Escape moves to the Close button.</p>}
      {pic.ring && <span className="viewer-ring" style={{ left: pic.ring.x, top: pic.ring.y }} />}
      {msg && <p className="viewer-msg" role="status">{msg}</p>}
      {ok && touch && <Typing ref={input} keys={keys} onBlur={() => setTyping(false)} />}
      {ok && typing && <KeysRow keys={keys} bottom={kb} />}
      <div className={`viewer-bar${bar ? "" : " hidden"}`}>
        {error && <button className="primary quiet onvideo" onClick={() => setAttempt(n => n + 1)}>Try again</button>}
        {ok && touch && (
          <button className="primary quiet onvideo" aria-label={`Touch mode: ${mode === "direct" ? "Direct" : "Trackpad"}`}
            onClick={() => setMode(m => (m === "direct" ? "trackpad" : "direct"))}>
            {mode === "direct" ? "Direct" : "Trackpad"}
          </button>
        )}
        {ok && touch && (
          <button className="primary quiet onvideo" aria-pressed={typing} onPointerDown={keep} onMouseDown={keep} onClick={toggleTyping}>Keys</button>
        )}
        <button ref={close} className="primary quiet onvideo" onClick={onClose}>Close</button>
      </div>
      {touch && !bar && <button className="viewer-more" aria-label="Show controls" onClick={showBar}>•••</button>}
    </div>
  );
}
```

- [ ] **Step 3: Add the styles** (`console-next/app/globals.css`, right after `.viewer-bar.hidden { … }`)

```css
.viewer video.control { touch-action: none; }
.viewer-input { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; font-size: 16px; }
.viewer-keys { position: absolute; left: 0; right: 0; bottom: calc(env(safe-area-inset-bottom) + 84px); display: flex; gap: 6px;
  padding: 8px 10px; overflow-x: auto; background: #000c; }
.viewer-keys button { flex: 0 0 auto; min-width: 44px; height: 40px; padding: 0 10px; border: 0; border-radius: 10px;
  background: #fff2; color: #fff; font: inherit; font-size: 1rem; cursor: pointer; }
.viewer-keys button.on { background: #fff; color: #000; }
.viewer-ring { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
  box-shadow: 0 0 0 2px #fff, 0 0 0 4px #0006; pointer-events: none; }
.viewer-more { position: absolute; top: calc(env(safe-area-inset-top) + 10px); right: 14px; padding: 4px 10px; border: 0;
  border-radius: 99px; background: #0007; color: #fff; opacity: 0.6; font-size: 16px; letter-spacing: 1px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
```

- [ ] **Step 4: Test and build**

Run: `npm --prefix console-next test && npm --prefix console-next run build`
Expected: `control ok`; Next build succeeds with no errors.

- [ ] **Step 5: Check the view-only path in the browser**

Start the `macwake-console-test` preview, register a test token (`POST /api/register` with a fresh 48-hex token), sign in with `http://localhost:3003/#token=<token>`, tap **Watch screen**. With no Mac answering, the viewer must show the waking/connecting status, only **Close** in the bar (no Direct/Keys buttons), and no console errors (`read_console_messages`). Close it.

- [ ] **Step 6: Commit (console repo)**

```bash
git -C console-next add app/Controls.js app/Viewer.js app/globals.css
git -C console-next commit -m "Control the Mac's mouse and keyboard from the console

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: App viewer UI and iPad hardware keys

**Files:**
- Create: `mobile/src/Controls.tsx`, `mobile/ios/MacWake/HardwareKeys.swift`, `mobile/ios/MacWake/HardwareKeys.m`
- Modify: `mobile/src/Viewer.tsx`
- Modify: `mobile/ios/MacWake.xcodeproj/project.pbxproj` (via the xcodeproj gem, Step 4)

**Interfaces:**
- Consumes (Task 2): `createGestures`, `createHeld`, `createKeys`, `createSender`, `edit`, `hidToCode`, `KEYS_ROW`, `LONG_PRESS`, `SENTINEL`, `CONTROL_MESSAGES`, types `Mode`, `Mod`, `Msg`, `PictureView`, `ControlStatus`.
- Produces: native module `HardwareKeys` with `start()`, `stop()` and events `key {usage: number, down: boolean}`, `keyboard {connected: boolean}`; hooks `usePicture(mode, view, send, enabled) -> { handlers, ring }`, `useKeys(send)`, `useHardwareKeys(enabled, send) -> { connected, refocus }`, `useKeyboardHeight() -> number`; components `Typing` (forwardRef `{ keys, onBlur }`), `KeysRow({ keys, bottom })`.

- [ ] **Step 1: Write `mobile/ios/MacWake/HardwareKeys.swift`**

```swift
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
    DispatchQueue.main.async {
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
```

- [ ] **Step 2: Write `mobile/ios/MacWake/HardwareKeys.m`**

```objc
// Exposes HardwareKeys.swift to JavaScript.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(HardwareKeys, RCTEventEmitter)
RCT_EXTERN_METHOD(start)
RCT_EXTERN_METHOD(stop)
@end
```

- [ ] **Step 3: Check the Xcode group layout**

Run: `grep -n -A12 '13B07FAE1A68108700A75B9A /\* MacWake \*/ = {' mobile/ios/MacWake.xcodeproj/project.pbxproj`
Expected: the `MacWake` group has `name = MacWake;` and no `path`, so its files use `path = MacWake/<file>` (like `AppDelegate.swift`).

- [ ] **Step 4: Add both files to the MacWake target**

```bash
cd mobile/ios && bundle exec ruby -e '
require "xcodeproj"
p = Xcodeproj::Project.open("MacWake.xcodeproj")
group = p.main_group.groups.find { |g| g.display_name == "MacWake" }
target = p.targets.find { |t| t.name == "MacWake" }
%w[HardwareKeys.swift HardwareKeys.m].each do |f|
  ref = group.new_reference("MacWake/#{f}")
  ref.name = f
  target.source_build_phase.add_file_reference(ref)
end
p.save'
```

Then `git diff --stat mobile/ios/MacWake.xcodeproj/project.pbxproj` shows only that file changed, with two file references and two build files added.

- [ ] **Step 5: Write `mobile/src/Controls.tsx`**

```tsx
/**
 * Remote control glue for the viewer: touches on the picture, the phone keyboard, the Mac keys row and iPad
 * hardware keyboards. Decisions live in control.ts; mirrors console-next/app/Controls.js.
 *
 * @format
 */

import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  NativeEventEmitter,
  NativeModules,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type GestureResponderEvent,
} from 'react-native';
import {
  createGestures,
  createHeld,
  createKeys,
  edit,
  hidToCode,
  KEYS_ROW,
  LONG_PRESS,
  SENTINEL,
  type Mod,
  type Mode,
  type Msg,
  type PictureView,
} from './control';

type Send = (msgs: Msg[]) => void;

/** Touches on the picture -> Mac pointer messages. `ring` marks where a long press took hold. */
export function usePicture(mode: Mode, view: () => PictureView, send: Send, enabled: boolean) {
  const [ring, setRing] = useState<{ x: number; y: number } | null>(null);
  const latest = useRef({ view, send, enabled });
  latest.current = { view, send, enabled };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handlers = useMemo(() => {
    const g = createGestures(mode, () => latest.current.view());
    const each = (e: GestureResponderEvent, fn: (id: string, x: number, y: number) => Msg[]) =>
      latest.current.send(
        e.nativeEvent.changedTouches.flatMap(t => fn(String(t.identifier), t.locationX, t.locationY)),
      );
    const start = (e: GestureResponderEvent) => {
      each(e, (id, x, y) => g.down(id, x, y, Date.now()));
      const { locationX: x, locationY: y } = e.nativeEvent.changedTouches[0];
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (g.tick(Date.now())) setRing({ x, y });
      }, LONG_PRESS + 20);
    };
    const end = (e: GestureResponderEvent) => {
      each(e, id => g.up(id, Date.now()));
      if (g.state === 'idle') {
        clearTimeout(timer.current);
        setRing(null);
      }
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.enabled,
      onMoveShouldSetPanResponder: () => latest.current.enabled,
      onPanResponderGrant: start,
      onPanResponderStart: start,
      onPanResponderMove: e => each(e, (id, x, y) => g.move(id, x, y, Date.now())),
      onPanResponderEnd: end,
      onPanResponderRelease: end,
      onPanResponderTerminate: () => {
        clearTimeout(timer.current);
        setRing(null);
        latest.current.send(g.cancel());
      },
    }).panHandlers;
  }, [mode]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { handlers, ring };
}

/** Sticky ⌘ ⌥ ⌃ ⇧ from the keys row plus typed text; `latched` drives the row's highlight. */
export function useKeys(send: Send) {
  const keys = useMemo(createKeys, []);
  const [latched, setLatched] = useState<Mod[]>([]);
  const after = (out: Msg[]) => {
    send(out);
    setLatched(keys.latched());
  };
  return {
    latched,
    press: (code: string) => after(keys.press(code)),
    type: (text: string) => after(keys.type(text)),
    toggle: (mod: Mod) => {
      keys.toggle(mod);
      setLatched(keys.latched());
    },
  };
}
export type KeysApi = ReturnType<typeof useKeys>;

const native = Platform.OS === 'ios' ? NativeModules.HardwareKeys : null;

/** iPad hardware keyboard -> Mac keys while `enabled` (iOS only). `connected` says whether one is attached. */
export function useHardwareKeys(enabled: boolean, send: Send) {
  const [connected, setConnected] = useState(false);
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => {
    if (!native || !enabled) return;
    const held = createHeld();
    const events = new NativeEventEmitter(native);
    const subs = [
      events.addListener('key', ({ usage, down }: { usage: number; down: boolean }) => {
        const code = hidToCode(usage);
        if (code) latest.current(held.key(code, down));
      }),
      events.addListener('keyboard', ({ connected: c }: { connected: boolean }) => setConnected(c)),
    ];
    native.start();
    return () => {
      subs.forEach(s => s.remove());
      native.stop();
      latest.current(held.releaseAll());
    };
  }, [enabled]);
  return {
    connected,
    refocus: () => {
      if (native && enabled) native.start();
    },
  };
}

/** Height of the on-screen keyboard (0 when hidden), so the keys row sits right above it. */
export function useKeyboardHeight() {
  const [h, setH] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', e =>
      setH(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}

/** Hidden input for the phone keyboard. It always holds one space, so Backspace shows up as a deleted space. */
export const Typing = forwardRef<TextInput, { keys: KeysApi; onBlur: () => void }>(function Typing(
  { keys, onBlur },
  ref,
) {
  return (
    <TextInput
      ref={ref}
      style={st.hidden}
      value={SENTINEL}
      autoCapitalize="none"
      autoComplete="off"
      autoCorrect={false}
      spellCheck={false}
      smartInsertDelete={false}
      submitBehavior="submit"
      onSubmitEditing={() => keys.press('Enter')}
      onChangeText={t => {
        const r = edit(t);
        if (r.backspace) keys.press('Backspace');
        else if (r.text) keys.type(r.text);
      }}
      onBlur={onBlur}
      accessibilityLabel="Type on the Mac"
    />
  );
});

/** esc, tab, sticky ⌘ ⌥ ⌃ ⇧ and arrows, for what the phone keyboard lacks. */
export function KeysRow({ keys, bottom }: { keys: KeysApi; bottom: number }) {
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={[st.row, { bottom }]}
      contentContainerStyle={st.rowIn}
      accessibilityRole="toolbar"
      accessibilityLabel="Mac keys"
    >
      {KEYS_ROW.map(k => {
        const on = !!k.mod && keys.latched.includes(k.mod);
        return (
          <Pressable
            key={k.label}
            accessibilityRole="button"
            accessibilityLabel={k.say}
            accessibilityState={k.mod ? { selected: on } : undefined}
            onPress={() => (k.mod ? keys.toggle(k.mod) : k.key && keys.press(k.key))}
            style={({ pressed }) => [st.key, on && st.keyOn, pressed && st.pressed]}
          >
            <Text style={[st.keyText, on && st.keyTextOn]}>{k.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 },
  row: { position: 'absolute', left: 0, right: 0, flexGrow: 0, backgroundColor: '#000c' },
  rowIn: { gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  key: {
    minWidth: 44,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff2',
  },
  keyOn: { backgroundColor: '#fff' },
  pressed: { opacity: 0.6 },
  keyText: { color: '#fff', fontFamily: 'Onest-Medium', fontSize: 16 },
  keyTextOn: { color: '#000' },
});
```

- [ ] **Step 6: Update `mobile/src/Viewer.tsx`**

6a. Header comment: replace the first doc line with `Full-screen live view of the Mac over WebRTC, with mouse and keyboard control once the Mac allows it.` and the second with `Mirrors console-next/app/Viewer.js; decisions live in core.ts and control.ts.`

6b. Imports: add `TextInput` and `useMemo` to the existing React / react-native imports, and below the `./core` import:

```tsx
import { CONTROL_MESSAGES, createSender, type ControlStatus, type Mode } from './control';
import { KeysRow, Typing, useHardwareKeys, useKeyboardHeight, useKeys, usePicture } from './Controls';
```

and above `export default function Viewer`:

```tsx
type Channel = ReturnType<RTCPeerConnection['createDataChannel']>;
```

6c. State, after `const [locked, setLocked] = useState(false);`:

```tsx
  const [control, setControl] = useState<ControlStatus | null>(null); // null: a view-only Mac app
  const [size, setSize] = useState<number[]>([16, 10]); // the Mac's screen in points
  const [mode, setMode] = useState<Mode>('direct');
  const [typing, setTyping] = useState(false);
```

and after `const [attempt, setAttempt] = useState(0);`:

```tsx
  const dc = useRef<Channel | null>(null);
  const input = useRef<TextInput>(null);
```

6d. In the effect: add `setControl(null);` after `setLocked(false);`, and replace the data-channel block (`const dc = conn.createDataChannel('control');` through its `onmessage` handler) with:

```tsx
          const ch = conn.createDataChannel('control');
          dc.current = ch;
          ch.onmessage = (e: any) => {
            try {
              const d = JSON.parse(e.data);
              if ('locked' in d) setLocked(!!d.locked);
              if ('control' in d) {
                setControl(d.control);
                if (Array.isArray(d.size)) setSize(d.size);
              }
            } catch {
              // not ours
            }
          };
```

6e. Replace `const msg = error || (locked && stream ? 'Mac is locked' : status);` with:

```tsx
  // Control: only once the Mac says so (a Mac app without control never does, and stays view-only).
  const send = useMemo(
    () =>
      createSender(
        m => {
          if (dc.current?.readyState === 'open') dc.current.send(JSON.stringify(m));
        },
        f => requestAnimationFrame(f),
      ),
    [],
  );
  const ok = !!stream && !error && control === 'ok';
  const picture = usePicture(mode, () => ({ box: { w: width, h: height }, size }), send, ok);
  const keys = useKeys(send);
  const hw = useHardwareKeys(ok, send);
  const kb = useKeyboardHeight();
  useEffect(() => {
    if (!ok) setTyping(false);
  }, [ok]);
  const toggleTyping = () => {
    if (typing) {
      setTyping(false);
      input.current?.blur();
    } else {
      setTyping(true);
      if (!hw.connected) input.current?.focus();
    }
  };

  const note =
    stream && control && control !== 'ok' ? CONTROL_MESSAGES[control] ?? '' : '';
  const msg = error || (locked && stream ? 'Mac is locked' : status) || note;
```

6f. Replace the `const video = stream ? ( <RTCView … /> ) : null;` block with:

```tsx
  const video = stream ? (
    <View style={{ width, height }} {...(ok ? picture.handlers : {})}>
      <View pointerEvents="none">
        <RTCView
          streamURL={stream.toURL()}
          objectFit="contain"
          style={{ width, height }}
        />
      </View>
      {picture.ring ? (
        <View
          pointerEvents="none"
          style={[st.ring, { left: picture.ring.x - 22, top: picture.ring.y - 22 }]}
        />
      ) : null}
    </View>
  ) : null;
  const modeLabel = mode === 'direct' ? 'Direct' : 'Trackpad';
```

6g. Replace the iOS `<ScrollView …>` opening tag (and its comment) with:

```tsx
          // Pinch to zoom into small text on the Mac's screen. While controlling, one finger belongs to the Mac,
          // so panning happens with two fingers during the pinch; trackpad mode turns zoom off.
          <ScrollView
            key={mode}
            maximumZoomScale={ok && mode === 'trackpad' ? 1 : 4}
            minimumZoomScale={1}
            scrollEnabled={!ok}
            keyboardShouldPersistTaps="always"
            centerContent
            contentContainerStyle={st.fill}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
          >
```

6h. Right after the `{msg ? ( <Text …>{msg}</Text> ) : null}` block, add:

```tsx
        {ok ? (
          <Typing
            ref={input}
            keys={keys}
            onBlur={() => {
              if (!hw.connected) setTyping(false);
              hw.refocus();
            }}
          />
        ) : null}
        {ok && typing ? <KeysRow keys={keys} bottom={kb || inset.bottom + 84} /> : null}
```

and inside the bar, between the `Try again` button and `<Btn label="Close" …/>`:

```tsx
            {ok ? (
              <Btn
                label={modeLabel}
                say={`Touch mode: ${modeLabel}`}
                onPress={() => setMode(m => (m === 'direct' ? 'trackpad' : 'direct'))}
              />
            ) : null}
            {ok ? <Btn label="Keys" selected={typing} onPress={toggleTyping} /> : null}
```

6i. Replace `function Btn` with:

```tsx
function Btn({
  label,
  say,
  selected,
  onPress,
}: {
  label: string;
  say?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={say}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [st.btn, selected && st.btnOn, pressed && st.pressed]}
    >
      <Text style={st.btnText}>{label}</Text>
    </Pressable>
  );
}
```

and add to `st`: `btnOn: { backgroundColor: '#fff3' },` and

```tsx
  ring: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: '#fff',
  },
```

- [ ] **Step 7: Type-check, lint, test**

Run: `cd mobile && npx tsc --noEmit && npm run lint && npm test && npm run test:core && npx prettier --check src/Viewer.tsx src/Controls.tsx`
Expected: no type errors, no lint errors, jest passes, `core ok` + `control ok`, Prettier clean. Fix reported issues in this task's files (for example drop `smartInsertDelete` if the installed RN types reject it).

- [ ] **Step 8: Build and open in the iOS simulator**

Attach the simulator panel, then build and launch the app (Metro running via `npm start`). Sign in to the local test console (`http://localhost:3003/#token=<test token>`), tap **Watch screen**: with no Mac answering, the viewer shows its status and only **Close** (view-only path, no crash). Confirm `NativeModules.HardwareKeys` is defined on iOS (temporary `console.log(!!NativeModules.HardwareKeys)` in Metro's log, removed afterwards).

- [ ] **Step 9: Commit**

```bash
git add mobile/src/Controls.tsx mobile/src/Viewer.tsx mobile/ios/MacWake/HardwareKeys.swift mobile/ios/MacWake/HardwareKeys.m mobile/ios/MacWake.xcodeproj/project.pbxproj
git commit -m "Control the Mac's mouse and keyboard from the app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end on this Mac (needs the user's go-ahead)

**Files:** none unless a fix is needed (fixes go into the file that owns the bug, with its own commit).

- [ ] **Step 1: Ask the user in chat**

Say that this run moves their real pointer and types on this Mac, and that the test build at `mac/dist/MacWake.app` needs Accessibility (and Screen Recording, if not already) allowed in System Settings → Privacy & Security, which only they can do. Wait for a clear yes.

- [ ] **Step 2: Start the isolated console and the test Mac app**

Start preview `macwake-console-test`. Generate a token with `openssl rand -hex 24`, `POST http://localhost:3003/api/register` with `Authorization: Bearer <token>`, then:

```bash
open -n mac/dist/MacWake.app --args --screen-test http://localhost:3003 <token>
```

- [ ] **Step 3: Watch and control from the browser pane**

Open `http://localhost:3003/#token=<token>`, tap **Watch screen**. Expected: picture appears; before Accessibility is granted, the note "To control the Mac, allow MacWake under …" shows and nothing is injected. After the user grants it, within ~1 s the note disappears.

- [ ] **Step 4: Mouse and keys**

With the user watching: move the mouse over the picture (the Mac pointer follows), click a Finder window (it activates), double-click a folder (it opens), scroll a window (direction matches the browser's scrolling; if inverted, flip the signs in `Injector.scroll` and note it), press ⌘ + Space and type `notes` (Spotlight opens and searches), press Escape. Menu-bar icon shows the pointer symbol while input arrives, the eye 5 s later.

- [ ] **Step 5: Touch modes**

Switch the pane to a touch device size (`resize_window` mobile preset), reload, watch again. Direct: tap clicks, drag scrolls. Trackpad: drag moves the pointer, tap clicks. Keys shows the keys row.

- [ ] **Step 6: Nothing stays stuck**

Hold the mouse button down on the picture and close the viewer mid-drag; on the Mac, the button is released (a Finder selection rectangle ends). Turn **Allow remote control** off in the menu while watching: "Remote control is turned off on the Mac." appears and input stops; turn it back on.

- [ ] **Step 7: iPhone simulator**

In the simulator app, sign in to the same local console and watch: Direct/Trackpad and Keys appear, a tap clicks on the Mac, the phone keyboard types into a Mac text field (TextEdit), Backspace deletes, the keys row's ⌘ + typed `a` selects all.

- [ ] **Step 8: Lock screen (user, optional)**

Ask the user to lock the Mac (⌃⌘Q) and type the password from the viewer. If it unlocks, change the locked text in both viewers (`console-next/app/Viewer.js`, `mobile/src/Viewer.tsx`) from `"Mac is locked"` to `"Mac is locked. Type your password to unlock."`, run both test suites, and commit each repo ("Tell viewers they can type the password at the lock screen"). If it does not unlock, keep the text.

- [ ] **Step 9: Clean up**

Quit the `--screen-test` instance (`pkill -f 'MacWake --screen-test'`), stop the preview, reset the pane size (`resize_window` desktop).

---

### Task 7: Docs, release build, gitlink

**Files:**
- Modify: `README.md` ("Watch the screen" section and the Limits token line)
- Modify: `console-next/README.md` ("Live screen" paragraph)
- Modify: `mobile/README.md` ("Watch screen" section and the table)
- Modify: `CLAUDE.md` (mirroring section)

- [ ] **Step 1: Root README** — rename the section to `## Watch and control the screen` and replace its first paragraph with:

```markdown
Tap **Watch screen** in the console or the app to see your Mac's screen live and control it. It wakes the Mac if
needed and connects on its own; the Mac shows an eye in its menu bar while someone watches, a pointer while someone
controls it, and macOS's own recording indicator. Video and input go straight between the Mac and your phone,
encrypted; the console only passes the connection setup along.

- **Computer browsers**: use your mouse and keyboard on the picture. Browsers keep a few shortcuts for themselves
  (⌘W, ⌘T, ⌘Q, ⌘Tab). Shift+Escape moves to the Close button.
- **Phones and tablets**: **Direct** mode taps where you want to click, drags to scroll, long-presses to right-click,
  and long-presses then drags to drag or select. **Trackpad** mode moves the pointer like a laptop trackpad (two
  fingers scroll, two-finger tap right-clicks). **Keys** opens the keyboard plus a row with esc, tab, arrows and
  sticky ⌘ ⌥ ⌃ ⇧ (tap ⌘, then type c, for ⌘C). On iPad, a Magic Keyboard sends every key directly.
```

and add to the list under it:

```markdown
- Allow Accessibility once when setup asks (System Settings → Privacy & Security → Accessibility) so MacWake can
  move the pointer and type. Turn control off with **Allow remote control** in the menu; viewing keeps working.
```

In "Limits, honestly", change the token bullet to say the token "now also opens and controls its screen".

- [ ] **Step 2: `console-next/README.md`** — after the "Live screen." paragraph add:

```markdown
**Remote control.** While watching, mouse, touch and keys go to the Mac over the same encrypted connection (never
through this server). The Mac needs Accessibility allowed for MacWake and "Allow remote control" on in its menu.
Viewer logic lives in `lib/control.js` (mirrored in `mobile/src/control.ts`), the UI in `app/Controls.js`.
```

- [ ] **Step 3: `mobile/README.md`** — add rows to the "What's here" table:

```markdown
| `src/control.ts` | Remote control logic (gestures, keys, batching), mirrored from `console-next/lib/control.js`. Tests: `src/control.check.ts`. |
| `src/Controls.tsx` | Touch handling, phone keyboard, Mac keys row, iPad hardware keys hook. |
| `ios/MacWake/HardwareKeys.swift` | Native module: iPad hardware keyboard keys (HID usage, up/down) while the viewer is open. |
```

and append to "Watch screen": `While watching, the Mac can be controlled: Direct/Trackpad touch modes, Keys for the phone keyboard and Mac keys row, and an iPad hardware keyboard sends keys directly (iOS only).`

- [ ] **Step 4: `CLAUDE.md`** — in "Cross-platform mirroring", add:

```markdown
- `console-next/lib/control.js` ↔ `mobile/src/control.ts` (remote control: gestures, sticky keys, batching, texts) and `console-next/app/Controls.js` ↔ `mobile/src/Controls.tsx` (the glue). Keep behavior and text identical. The Mac side (`mac/Sources/Control.swift`) only injects; its `keyCodes` table must cover every `KeyboardEvent.code` the viewers send.
```

- [ ] **Step 5: Release build**

Run: `CONSOLE_URL=https://mac-wake-console.vercel.app sh mac/build.sh` (skip if no Mac source changed since Task 3's build).

- [ ] **Step 6: Commit both repos and bump the gitlink**

```bash
git -C console-next add README.md
git -C console-next commit -m "Document remote control

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git add README.md mobile/README.md CLAUDE.md console-next mac/dist
git commit -m "Document remote control and point at the console's control branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected: `git status` clean in both repos. Pushing, merging to `main`, and the website download update are separate steps the user decides on.
