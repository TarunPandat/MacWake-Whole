// npm run test:core  -- mirror of the "Remote control" tests in console-next/test.mjs, plus iPad hardware keys.
import {
  charToCode,
  CONTROL_MESSAGES,
  createGestures,
  createHeld,
  createKeys,
  createSender,
  edit,
  fraction,
  hidToCode,
  KEYS_ROW,
  mouseButton,
  wheel,
  type Msg,
} from './control.ts';

const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
eq(
  fraction(200, 50, { w: 400, h: 100 }, [200, 100]),
  { at: [0.5, 0.5], inside: true },
  'letterboxed center',
);
eq(
  fraction(10, 50, { w: 400, h: 100 }, [200, 100]),
  { at: [0, 0.5], inside: false },
  'a click in the side bar is outside, clamped to the edge',
);

const view = () => ({ box: { w: 200, h: 100 }, size: [200, 100] });
let g = createGestures('direct', view);
eq(g.down(1, 50, 50, 0), [], 'a touch waits to see what it becomes');
eq(g.down(1, 50, 50, 5), [], 'duplicate down is ignored');
eq(
  g.up(1, 100),
  [{ m: [0.25, 0.5] }, { b: 0, d: 1 }, { b: 0, d: 0 }],
  'direct tap clicks there',
);
eq(g.up(1, 110), [], 'unknown up is ignored');
g.down(1, 50, 50, 0);
eq(g.move(1, 55, 50, 10), [], 'within slop');
eq(
  g.move(1, 50, 30, 20),
  [{ m: [0.25, 0.5] }, { s: [0, 20] }],
  'dragging up scrolls down, from where the finger started',
);
eq(g.move(1, 50, 20, 30), [{ s: [0, 10] }], 'and keeps scrolling');
eq(g.up(1, 40), [], 'no click after a scroll');
g.down(1, 50, 50, 0);
eq(g.tick(400), false, 'not yet a long press');
eq(g.tick(500), true, 'long press');
eq(g.state, 'held', 'held');
eq(
  g.up(1, 600),
  [{ m: [0.25, 0.5] }, { b: 1, d: 1 }, { b: 1, d: 0 }],
  'long press, release: right click there',
);
g.down(1, 50, 50, 0);
g.tick(500);
eq(
  g.move(1, 80, 50, 600),
  [{ m: [0.25, 0.5] }, { b: 0, d: 1 }, { m: [0.4, 0.5] }],
  'long press, then drag: holds the button',
);
eq(g.move(1, 90, 60, 610), [{ m: [0.45, 0.6] }], 'drag follows the finger');
eq(g.up(1, 700), [{ b: 0, d: 0 }], 'drop');
g.down(1, 50, 50, 0);
eq(g.down(2, 80, 50, 10), [], 'second finger in direct mode belongs to zoom');
eq(g.up(1, 50), [], 'so no click');
eq(g.up(2, 60), [], 'nothing at all');
eq(g.state, 'idle', 'back to idle');
g.down(1, 50, 50, 0);
g.tick(500);
g.move(1, 80, 50, 600);
eq(
  g.down(2, 120, 50, 650),
  [{ b: 0, d: 0 }],
  'second finger during a drag lets go of the button',
);
g.up(1, 700);
g.up(2, 710);
g.down(1, 50, 50, 0);
g.tick(500);
g.move(1, 80, 50, 600);
eq(g.cancel(), [{ b: 0, d: 0 }], 'cancel lets go of a held button');
eq(g.state, 'idle', 'and resets');
g = createGestures('direct', () => ({
  box: { w: 400, h: 200 },
  size: [200, 100],
}));
g.down(1, 100, 100, 0);
eq(
  g.move(1, 100, 80, 10),
  [{ m: [0.25, 0.5] }, { s: [0, 10] }],
  'scroll is in Mac points, not screen pixels',
);

g = createGestures('trackpad', view);
g.down(1, 50, 50, 0);
eq(
  g.up(1, 100),
  [
    { b: 0, d: 1 },
    { b: 0, d: 0 },
  ],
  'trackpad tap clicks at the pointer',
);
g.down(1, 50, 50, 0);
eq(
  g.move(1, 70, 50, 100),
  [{ r: [0.15, 0] }],
  'slow drag moves the pointer 1.5x',
);
eq(g.move(1, 110, 50, 110), [{ r: [0.6, 0] }], 'fast drag moves it 3x');
eq(g.up(1, 120), [], 'no click after moving');
g.down(1, 50, 50, 0);
g.tick(500);
eq(
  g.up(1, 600),
  [
    { b: 1, d: 1 },
    { b: 1, d: 0 },
  ],
  'trackpad long press right clicks at the pointer',
);
g.down(1, 50, 50, 0);
g.tick(500);
eq(
  g.move(1, 70, 50, 1600),
  [{ b: 0, d: 1 }, { r: [0.15, 0] }],
  'long press then drag holds the button',
);
eq(g.up(1, 1700), [{ b: 0, d: 0 }], 'drop');
g.down(1, 50, 50, 0);
eq(g.down(2, 90, 50, 50), [], 'two fingers');
eq(
  g.up(1, 200),
  [
    { b: 1, d: 1 },
    { b: 1, d: 0 },
  ],
  'two-finger tap right clicks',
);
eq(g.up(2, 210), [], 'the other finger lifts quietly');
g.down(1, 50, 50, 0);
g.down(2, 90, 50, 10);
eq(
  g.move(1, 50, 30, 50),
  [{ s: [0, 10] }],
  'two-finger drag scrolls by the midpoint',
);
eq(g.move(2, 90, 30, 60), [{ s: [0, 10] }], 'both fingers');
eq(g.up(1, 400), [], 'no right click after scrolling');
g.up(2, 410);
eq(g.state, 'idle', 'all fingers up');

eq(wheel(0, 3, 1, 800), { s: [0, 48] }, 'line scrolling');
eq(wheel(0, 1, 2, 800), { s: [0, 800] }, 'page scrolling');
eq(wheel(2.5, -7, 0, 800), { s: [2.5, -7] }, 'pixels pass through');
eq(
  [0, 1, 2, 3].map(mouseButton),
  [0, null, 1, null],
  'left and right buttons only',
);
eq(
  ['c', 'C', '7', '&', ' ', '\n', '/', 'é'].map(charToCode),
  [
    { code: 'KeyC', shift: false },
    { code: 'KeyC', shift: true },
    { code: 'Digit7', shift: false },
    { code: 'Digit7', shift: true },
    { code: 'Space', shift: false },
    { code: 'Enter', shift: false },
    { code: 'Slash', shift: false },
    null,
  ],
  'US layout keys',
);

const keys = createKeys();
eq(keys.type('hi'), [{ t: 'hi' }], 'plain typing is text');
keys.toggle('meta');
eq(keys.latched(), ['meta'], 'latched');
eq(
  keys.type('c'),
  [
    { k: 'MetaLeft', d: 1 },
    { k: 'KeyC', d: 1 },
    { k: 'KeyC', d: 0 },
    { k: 'MetaLeft', d: 0 },
  ],
  '⌘ then c is ⌘C',
);
eq(keys.latched(), [], 'a latch is used once');
keys.toggle('meta');
keys.toggle('shift');
eq(
  keys.press('ArrowLeft'),
  [
    { k: 'MetaLeft', d: 1 },
    { k: 'ShiftLeft', d: 1 },
    { k: 'ArrowLeft', d: 1 },
    { k: 'ArrowLeft', d: 0 },
    { k: 'ShiftLeft', d: 0 },
    { k: 'MetaLeft', d: 0 },
  ],
  '⌘⇧← from the keys row',
);
keys.toggle('ctrl');
keys.toggle('ctrl');
eq(keys.latched(), [], 'a second tap unlatches');
keys.toggle('meta');
eq(
  keys.type('ab'),
  [
    { k: 'MetaLeft', d: 1 },
    { k: 'KeyA', d: 1 },
    { k: 'KeyA', d: 0 },
    { k: 'MetaLeft', d: 0 },
    { t: 'b' },
  ],
  'only the first character gets the latch',
);
keys.toggle('alt');
eq(
  keys.type('éx'),
  [{ t: 'éx' }],
  'a character with no key types as text and drops the latch',
);
eq(keys.latched(), [], 'dropped');
eq(KEYS_ROW.map(k => k.label).join(' '), 'esc tab ⌘ ⌥ ⌃ ⇧ ← ↑ ↓ →', 'keys row');

eq(edit(''), { backspace: true }, 'the space was deleted: Backspace');
eq(edit(' a'), { text: 'a' }, 'typed after the space');
eq(edit('a '), { text: 'a' }, 'typed before it');
eq(edit('  '), { text: ' ' }, 'typed a space');
eq(edit(' '), { text: '' }, 'nothing changed');

const held = createHeld();
eq(held.key('MetaLeft', true), [{ k: 'MetaLeft', d: 1 }], '⌘ down');
held.key('KeyC', true);
eq(
  held.key('MetaLeft', false),
  [
    { k: 'MetaLeft', d: 0 },
    { k: 'KeyC', d: 0 },
  ],
  'letting go of ⌘ releases keys whose keyup the browser swallowed',
);
held.key('KeyA', true);
eq(
  held.releaseAll(),
  [{ k: 'KeyA', d: 0 }],
  'blur releases everything still held',
);
eq(held.key('', true), [], 'keys without a code are ignored');

const sent: Msg[] = [];
const later: (() => void)[] = [];
const send = createSender(
  m => sent.push(m),
  f => later.push(f),
);
send([
  { m: [0.1, 0.1] },
  { m: [0.2, 0.2] },
  { r: [0.1, 0] },
  { r: [0.1, 0.1] },
]);
eq(
  sent,
  [{ m: [0.2, 0.2] }],
  'moves collapse to the last one; another kind flushes it',
);
send([{ b: 0, d: 1 }]);
eq(
  sent,
  [{ m: [0.2, 0.2] }, { r: [0.2, 0.1] }, { b: 0, d: 1 }],
  'a click flushes pending movement first, in order',
);
later.forEach(f => f());
eq(sent.length, 3, 'the frame flush finds nothing left');
eq(later.length, 1, 'one frame was asked for');

eq(
  Object.keys(CONTROL_MESSAGES).sort(),
  ['off', 'permission'],
  'every control status has text',
);

eq(
  [
    0x04, 0x1d, 0x1e, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x4f, 0x52, 0x3a,
    0x45, 0xe3, 0xe6, 0x99,
  ].map(hidToCode),
  [
    'KeyA',
    'KeyZ',
    'Digit1',
    'Digit0',
    'Enter',
    'Escape',
    'Backspace',
    'Tab',
    'Space',
    'ArrowRight',
    'ArrowUp',
    'F1',
    'F12',
    'MetaLeft',
    'AltRight',
    null,
  ],
  'iPad hardware keys',
);

console.log('control ok');
