// npm run test:core  -- Node 24 runs TypeScript directly (type stripping). No server, no device.
import http from 'node:http';
import {
  api,
  ApiError,
  deriveView,
  normalizeUrl,
  parsePairing,
  type State,
} from './core.ts';

const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};
const TOK = '0123456789abcdef'.repeat(3);

// Pairing QR / pasted text
eq(
  parsePairing(`https://mac-wake-console.vercel.app/#token=${TOK}`),
  { url: 'https://mac-wake-console.vercel.app', token: TOK },
  'QR link',
);
eq(
  parsePairing(`http://192.168.0.162:3002/#token=${TOK}`),
  { url: 'http://192.168.0.162:3002', token: TOK },
  'LAN QR link keeps port and http',
);
eq(parsePairing(`  ${TOK}\n`), { token: TOK }, 'bare token');
eq(parsePairing('https://example.com/'), null, 'link without token');
eq(parsePairing('hello'), null, 'junk');
eq(parsePairing('abc123'), null, 'too short');
eq(
  normalizeUrl('mac-wake-console.vercel.app/'),
  'https://mac-wake-console.vercel.app',
  'adds https, strips slash',
);

// Derived view
const T0 = 1_800_000_000_000;
const st = (
  phase: State['phase'],
  device: State['device'],
  settings: Partial<State['settings']> = {},
): State => ({
  phase,
  device,
  settings: { interval: 5, hold: 30, instant: true, ...settings },
  now: T0,
});

eq(deriveView(null, T0).phase, 'loading', 'no state yet');
eq(deriveView(st('idle', {}), T0).phase, 'never', 'never checked in');
eq(
  deriveView(st('idle', {}), T0).primary.disabled,
  true,
  "can't wake an unpaired Mac",
);
eq(
  deriveView(st('idle', { lastSeen: T0 - 60e3, ac: true, listening: true }), T0)
    .phase,
  'ready',
  'listening on charger',
);
eq(
  deriveView(st('idle', { lastSeen: T0 - 60e3, ac: true }), T0).phase,
  'idle',
  'awake, not listening',
);
eq(
  deriveView(
    st('idle', { lastSeen: T0 - 20 * 60e3, ac: true, listening: true }),
    T0,
  ).phase,
  'asleep',
  'stale listening flag means asleep',
);
eq(
  deriveView(st('idle', { lastSeen: T0 - 8 * 60e3, ac: false }), T0).phase,
  'idle',
  'battery backoff: 8 min is not yet stale at 10-min interval',
);
eq(
  deriveView(st('idle', { lastSeen: T0 - 16 * 60e3, ac: false }), T0).phase,
  'asleep',
  'battery: 16 min is stale',
);

const req = deriveView(
  st('requested', { lastSeen: T0 - 30e3, ac: true, listening: true }),
  T0,
);
eq(
  [req.phase, req.line, req.pollMs, req.canCancelRequest, req.primary.disabled],
  [
    'requested',
    'Sent. Your Mac should respond in a few seconds.',
    2000,
    true,
    true,
  ],
  'requested while listening',
);
const reqSleep = deriveView(
  st('requested', { lastSeen: T0 - 9 * 60e3, ac: true }),
  T0,
); // asleep after 1.5 x 5 min
eq(
  reqSleep.facts.map(f => f[0]),
  ['Last check-in', 'Next check-in', 'Lid', 'Power'],
  'asleep request shows next check-in',
);

const awake = deriveView(
  st('awake', {
    lastSeen: T0,
    ac: true,
    lid: true,
    holding: true,
    ackAt: T0,
    host: 'MBP.local',
  }),
  T0,
);
eq(
  [awake.primary.label, awake.primary.action, awake.led],
  ['Let it sleep', 'cancel', 'awake'],
  'awake offers release',
);
eq(awake.facts.find(f => f[0] === 'Mac')?.[1], 'MBP', 'strips .local');
eq(awake.line.includes('lid closed'), true, 'lid-closed copy');
eq(
  deriveView(st('done', { lastSeen: T0 }), T0).primary.label,
  'Wake it again',
  'done',
);
eq(
  deriveView(st('idle', { lastSeen: T0, ac: false, battery: 40 }), T0).note !==
    undefined,
  true,
  'battery note',
);
eq(
  deriveView(
    st('idle', { lastSeen: T0 - 3 * 60e3, ac: true }),
    T0 - 10 * 60e3,
    10 * 60e3,
  ).facts[0][1],
  '3 min ago',
  'server clock skew applied',
);

// API client against a fake console
const srv = http
  .createServer((inc, res) => {
    const auth = inc.headers.authorization;
    res.setHeader('Content-Type', 'application/json');
    if (auth !== `Bearer ${TOK}`) {
      res.statusCode = 401;
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (inc.url === '/api/boom') {
      res.statusCode = 500;
      res.end('{"error":"Storage isn\'t connected."}');
      return;
    }
    if (inc.url === '/api/page') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><p>Parked domain</p>');
      return;
    }
    let body = '';
    inc.on('data', c => (body += c));
    inc.on('end', () =>
      res.end(
        JSON.stringify({
          phase: 'idle',
          device: {},
          settings: { interval: 5, hold: 30 },
          now: 1,
          echo: inc.method + ' ' + inc.url + ' ' + body,
        }),
      ),
    );
  })
  .listen(0);
await new Promise(r => srv.once('listening', r));
const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const ok = (await api({ url, token: TOK }, 'wake', {})) as State & {
  echo: string;
};
eq(ok.echo, 'POST /api/wake {}', 'POST with body');
eq(
  ((await api({ url, token: TOK }, 'state')) as State & { echo: string }).echo,
  'GET /api/state ',
  'GET without body',
);
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return [(e as ApiError).status, (e as ApiError).message];
  }
};
eq(
  await fail(api({ url, token: 'nope' }, 'state')),
  [401, "That token isn't valid for this console."],
  '401 message',
);
eq(
  await fail(api({ url, token: TOK }, 'boom')),
  [500, "Storage isn't connected."],
  'server error passes message through',
);
eq(
  await fail(api({ url, token: TOK }, 'page')),
  [0, "That address isn't a MacWake console."],
  '200 from a non-console is an error, not a crash',
);
srv.close();
eq(
  await fail(
    api({ url: 'http://127.0.0.1:9', token: TOK }, 'state', undefined, 1500),
  ),
  [0, "Can't reach the console. Check your connection."],
  'network failure',
);

console.log('core ok');
