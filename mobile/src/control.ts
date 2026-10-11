// Viewer-side remote control: turns touches and keys into the messages the Mac injects. Wire format:
// docs/superpowers/specs/2026-10-11-remote-control-design.md. Pure (no React, no native), so Node runs the tests.
// Mirrors console-next/lib/control.js: keep behavior and text identical.

export type Mode = 'direct' | 'trackpad';
export type Mod = 'meta' | 'alt' | 'ctrl' | 'shift';
export type ControlStatus = 'ok' | 'off' | 'permission';
export type Msg = { [key: string]: number[] | number | string };
export type PictureView = { box: { w: number; h: number }; size: number[] };
type Touch = { x0: number; y0: number; x: number; y: number };
type State =
  | 'idle'
  | 'pending'
  | 'scroll'
  | 'move'
  | 'held'
  | 'drag'
  | 'two'
  | 'twoScroll'
  | 'swipe'
  | 'swiped'
  | 'ignore';

export const CONTROL_MESSAGES: Record<'off' | 'permission', string> = {
  off: 'Remote control is turned off on the Mac.',
  permission:
    'To control the Mac, allow MacWake under System Settings → Privacy & Security → Accessibility on the Mac.',
};

export const SLOP = 10; // px a finger may wander and still count as a tap
export const LONG_PRESS = 500; // ms
export const TWO_TAP = 300; // ms, two-finger tap (trackpad right click)
// ms: a tap this soon after the last, within SLOP, reuses its spot (a zoomed-out phone picture turns a
// 2 px wobble into more than the Mac's 4 pt double-click radius)
const DOUBLE_TAP = 500;
export const SWIPE = 50; // px the fingers' midpoint travels before a 3+-finger swipe counts
const GAIN = 1.5; // trackpad: pointer moves 1.5x the finger,
const FAST = 0.8; // twice that above 0.8 px/ms

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Element px -> screen fractions for a picture drawn with contain. `inside` is false in the bars. */
export function fraction(
  x: number,
  y: number,
  box: { w: number; h: number },
  size: number[],
) {
  const k = Math.min(box.w / size[0], box.h / size[1]);
  const fx = (x - (box.w - size[0] * k) / 2) / (size[0] * k);
  const fy = (y - (box.h - size[1] * k) / 2) / (size[1] * k);
  return {
    at: [r4(clamp(fx)), r4(clamp(fy))],
    inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1,
  };
}

/**
 * Touch gestures -> messages. `mode` 'direct' taps where you want to click; 'trackpad' moves the pointer.
 * `view()` returns { box: {w, h} element px, size: [w, h] Mac points }. down/move/up/cancel return the
 * messages to send; tick(t), called LONG_PRESS ms after a touch starts, returns true when it became a long press.
 */
export function createGestures(mode: Mode, view: () => PictureView) {
  const direct = mode === 'direct';
  const touches = new Map<string | number, Touch>();
  let state: State = 'idle';
  let since = 0;
  let twoAt = 0;
  let prev = { x: 0, y: 0 };
  let prevT = 0;
  let lastTap: { x: number; y: number; t: number } | null = null;
  const scale = () => {
    const { box, size } = view();
    return Math.min(box.w / size[0], box.h / size[1]);
  };
  const point = (x: number, y: number): Msg => {
    const { box, size } = view();
    return { m: fraction(x, y, box, size).at };
  };
  // content follows the finger
  const scroll = (dx: number, dy: number): Msg => {
    const k = scale();
    return { s: [r1(-dx / k), r1(-dy / k)] };
  };
  const nudge = (dx: number, dy: number, dt: number): Msg => {
    const k = scale();
    const { size } = view();
    const g = GAIN * (Math.hypot(dx, dy) / Math.max(dt, 1) > FAST ? 2 : 1);
    return { r: [r4((dx * g) / (size[0] * k)), r4((dy * g) / (size[1] * k))] };
  };
  const far = (p: Touch) => Math.hypot(p.x - p.x0, p.y - p.y0) > SLOP;
  const centroid = () => {
    let x = 0;
    let y = 0;
    for (const p of touches.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / touches.size, y: y / touches.size };
  };
  const click = (b: number, p: Touch): Msg[] => [
    ...(direct ? [point(p.x0, p.y0)] : []),
    { b, d: 1 },
    { b, d: 0 },
  ];
  const letGo = (): Msg[] => (state === 'drag' ? [{ b: 0, d: 0 }] : []);
  // A 3+-finger swipe, like on a Mac trackpad: left/right switch Space (⌃→ / ⌃←), up Mission Control, down App Exposé.
  const swipe = (dx: number, dy: number): Msg[] => {
    const k =
      Math.abs(dx) >= Math.abs(dy)
        ? dx < 0
          ? 'ArrowRight'
          : 'ArrowLeft'
        : dy < 0
        ? 'ArrowUp'
        : 'ArrowDown';
    return [
      { k: 'ControlLeft', d: 1 },
      { k, d: 1 },
      { k, d: 0 },
      { k: 'ControlLeft', d: 0 },
    ];
  };
  const tap = (p: Touch, t: number): Msg[] => {
    if (
      direct &&
      lastTap &&
      since - lastTap.t <= DOUBLE_TAP &&
      Math.hypot(p.x0 - lastTap.x, p.y0 - lastTap.y) <= SLOP
    ) {
      p.x0 = lastTap.x;
      p.y0 = lastTap.y;
    }
    lastTap = { x: p.x0, y: p.y0, t };
    return click(0, p);
  };
  const outside = (x: number, y: number) => {
    const { box, size } = view();
    return !fraction(x, y, box, size).inside;
  };

  return {
    get state() {
      return state;
    },
    down(id: string | number, x: number, y: number, t: number): Msg[] {
      if (touches.has(id)) return [];
      touches.set(id, { x0: x, y0: y, x, y });
      if (touches.size === 1) {
        // a direct touch in the black bars does nothing
        state = direct && outside(x, y) ? 'ignore' : 'pending';
        since = prevT = t;
        prev = { x, y };
        return [];
      }
      if (
        !direct &&
        touches.size === 2 &&
        (state === 'pending' || state === 'move')
      ) {
        for (const p of touches.values()) {
          p.x0 = p.x;
          p.y0 = p.y;
        }
        state = 'two';
        twoAt = t;
        prev = centroid();
        return [];
      }
      // three or more fingers: a trackpad swipe; a new finger restarts the measuring
      if (touches.size >= 3) {
        const out = letGo();
        if (state !== 'swiped') {
          state = 'swipe';
          prev = centroid();
        }
        return out;
      }
      // more fingers than the gesture uses (direct: the iOS zoom pinch): wait until all lift
      const out = letGo();
      state = 'ignore';
      return out;
    },
    move(id: string | number, x: number, y: number, t: number): Msg[] {
      const p = touches.get(id);
      if (!p) return [];
      p.x = x;
      p.y = y;
      const dt = t - prevT;
      let out: Msg[];
      switch (state) {
        case 'pending':
          if (!far(p)) return [];
          if (direct) {
            state = 'scroll';
            out = [point(p.x0, p.y0), scroll(x - p.x0, y - p.y0)];
          } else {
            state = 'move';
            out = [nudge(x - p.x0, y - p.y0, dt)];
          }
          break;
        case 'scroll':
          out = [scroll(x - prev.x, y - prev.y)];
          break;
        case 'move':
          out = [nudge(x - prev.x, y - prev.y, dt)];
          break;
        case 'held':
          if (!far(p)) return [];
          state = 'drag';
          out = direct
            ? [point(p.x0, p.y0), { b: 0, d: 1 }, point(x, y)]
            : [{ b: 0, d: 1 }, nudge(x - p.x0, y - p.y0, dt)];
          break;
        case 'drag':
          out = [direct ? point(x, y) : nudge(x - prev.x, y - prev.y, dt)];
          break;
        case 'swipe': {
          const c = centroid();
          const dx = c.x - prev.x;
          const dy = c.y - prev.y;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE) return [];
          state = 'swiped';
          return swipe(dx, dy);
        }
        case 'two':
          if (![...touches.values()].some(far)) return [];
          state = 'twoScroll';
        // falls through
        case 'twoScroll': {
          const c = centroid();
          out = [scroll(c.x - prev.x, c.y - prev.y)];
          prev = c;
          prevT = t;
          return out;
        }
        default:
          return [];
      }
      prev = { x, y };
      prevT = t;
      return out;
    },
    up(id: string | number, t: number): Msg[] {
      const p = touches.get(id);
      if (!p) return [];
      touches.delete(id);
      const out =
        state === 'pending'
          ? tap(p, t)
          : state === 'held'
          ? click(1, p)
          : state === 'two' && t - twoAt < TWO_TAP
          ? click(1, p)
          : letGo();
      state = touches.size ? 'ignore' : 'idle';
      return out;
    },
    tick(t: number): boolean {
      if (state !== 'pending' || t - since < LONG_PRESS) return false;
      state = 'held';
      return true;
    },
    cancel(): Msg[] {
      const out = letGo();
      touches.clear();
      state = 'idle';
      return out;
    },
  };
}

/** WheelEvent deltas -> scroll message in points (line mode: 16 a line, page mode: one screen). */
export function wheel(
  dx: number,
  dy: number,
  deltaMode: number,
  page: number,
): Msg {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? page : 1;
  return { s: [r1(dx * k), r1(dy * k)] };
}

/** Browser mouse button -> wire button (0 left, 1 right); others are ignored. */
export const mouseButton = (b: number) => (b === 0 ? 0 : b === 2 ? 1 : null);

const PLAIN: Record<string, string> = {
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '`': 'Backquote',
  ' ': 'Space',
  '\n': 'Enter',
  '\t': 'Tab',
};
const SHIFTED: Record<string, string> = {
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
  _: 'Minus',
  '+': 'Equal',
  '{': 'BracketLeft',
  '}': 'BracketRight',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
  '~': 'Backquote',
};

/** A typed character -> the US-layout key that makes it, or null. Used only while a modifier is latched. */
export function charToCode(
  ch: string,
): { code: string; shift: boolean } | null {
  if (/^[a-z]$/.test(ch))
    return { code: 'Key' + ch.toUpperCase(), shift: false };
  if (/^[A-Z]$/.test(ch)) return { code: 'Key' + ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { code: 'Digit' + ch, shift: false };
  if (ch in PLAIN) return { code: PLAIN[ch], shift: false };
  if (ch in SHIFTED) return { code: SHIFTED[ch], shift: true };
  return null;
}

const MODIFIERS: Record<Mod, string> = {
  meta: 'MetaLeft',
  alt: 'AltLeft',
  ctrl: 'ControlLeft',
  shift: 'ShiftLeft',
};

/** The Mac keys row, in order. `mod` keys latch (sticky); the others are pressed once. */
export const KEYS_ROW: {
  label: string;
  say: string;
  key?: string;
  mod?: Mod;
}[] = [
  { label: 'esc', say: 'Escape', key: 'Escape' },
  { label: 'tab', say: 'Tab', key: 'Tab' },
  { label: '⌘', say: 'Command', mod: 'meta' },
  { label: '⌥', say: 'Option', mod: 'alt' },
  { label: '⌃', say: 'Control', mod: 'ctrl' },
  { label: '⇧', say: 'Shift', mod: 'shift' },
  { label: '←', say: 'Left arrow', key: 'ArrowLeft' },
  { label: '↑', say: 'Up arrow', key: 'ArrowUp' },
  { label: '↓', say: 'Down arrow', key: 'ArrowDown' },
  { label: '→', say: 'Right arrow', key: 'ArrowRight' },
];

/**
 * Sticky ⌘ ⌥ ⌃ ⇧ from the keys row. A tap latches a modifier; it is held around the next key or typed
 * character, then released. A second tap unlatches it.
 */
export function createKeys() {
  const latched = new Set<Mod>();
  const press = (code: string, shift = false): Msg[] => {
    const mods = [...latched].map(n => MODIFIERS[n]);
    if (shift && !latched.has('shift')) mods.push(MODIFIERS.shift);
    latched.clear();
    return [
      ...mods.map(k => ({ k, d: 1 })),
      { k: code, d: 1 },
      { k: code, d: 0 },
      ...[...mods].reverse().map(k => ({ k, d: 0 })),
    ];
  };
  const type = (text: string): Msg[] => {
    if (!text) return [];
    const [ch] = text;
    const c = latched.size ? charToCode(ch) : null;
    if (!c) {
      latched.clear();
      return [{ t: text }];
    }
    const rest = text.slice(ch.length);
    return [...press(c.code, c.shift), ...(rest ? [{ t: rest }] : [])];
  };
  return {
    latched: () => [...latched],
    toggle: (mod: Mod) => {
      if (latched.has(mod)) latched.delete(mod);
      else latched.add(mod);
    },
    press,
    type,
  };
}

/** The phone keyboard's hidden input always holds this, so Backspace shows up as a deleted space. */
export const SENTINEL = ' ';

/** What the phone keyboard did to the hidden input's value. */
export const edit = (next: string): { backspace?: true; text?: string } =>
  next === '' ? { backspace: true } : { text: next.replace(SENTINEL, '') };

const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'CapsLock',
]);

/**
 * Physical keys from a real keyboard. Tracks what is held so nothing stays stuck on the Mac: macOS browsers send
 * no keyup for keys released while ⌘ is down, so letting go of ⌘ releases them too.
 */
export function createHeld() {
  const held = new Set<string>();
  return {
    key(code: string, down: boolean): Msg[] {
      if (!code) return [];
      if (down) {
        held.add(code);
        return [{ k: code, d: 1 }];
      }
      held.delete(code);
      const out: Msg[] = [{ k: code, d: 0 }];
      if (code === 'MetaLeft' || code === 'MetaRight')
        for (const k of [...held])
          if (!MODIFIER_CODES.has(k)) {
            held.delete(k);
            out.push({ k, d: 0 });
          }
      return out;
    },
    releaseAll(): Msg[] {
      const out = [...held].map(k => ({ k, d: 0 }));
      held.clear();
      return out;
    },
  };
}

/**
 * Sends at most one pointer message per frame: the last `m`, summed `r` and `s`. Anything else goes out at
 * once, after whatever movement is pending, so order is kept. `schedule(fn)` runs fn on the next frame.
 */
export function createSender(
  send: (msg: Msg) => void,
  schedule: (fn: () => void) => void,
) {
  let pending: Msg | null = null;
  let queued = false;
  const flush = () => {
    if (pending) send(pending);
    pending = null;
  };
  return (msgs: Msg[]) => {
    for (const msg of msgs) {
      const kind = ['m', 'r', 's'].find(k => k in msg);
      if (kind && pending && kind in pending) {
        const a = pending[kind] as number[];
        const b = msg[kind] as number[];
        pending = kind === 'm' ? msg : { [kind]: [a[0] + b[0], a[1] + b[1]] };
      } else {
        flush();
        if (kind) pending = msg;
        else send(msg);
      }
    }
    if (pending && !queued) {
      queued = true;
      schedule(() => {
        queued = false;
        flush();
      });
    }
  };
}

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
  if (usage >= 0x04 && usage <= 0x1d)
    return 'Key' + String.fromCharCode(65 + usage - 0x04);
  if (usage >= 0x1e && usage <= 0x26) return 'Digit' + (usage - 0x1d);
  if (usage === 0x27) return 'Digit0';
  if (usage >= 0x3a && usage <= 0x45) return 'F' + (usage - 0x39);
  return HID[usage] ?? null;
}
