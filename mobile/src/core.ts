// Pure MacWake console logic: no React, no native modules, so it runs under plain Node for tests.
// Mirrors console-next/app/page.js so the app and the web console always agree.

export const DEFAULT_CONSOLE = 'https://mac-wake-console.vercel.app';

export type Device = {
  lastSeen?: number;
  ac?: boolean;
  battery?: number | null;
  host?: string;
  lid?: boolean;
  listening?: boolean;
  holding?: boolean;
  ackSeq?: number;
  ackAt?: number;
};
export type Settings = { interval: number; hold: number; instant?: boolean };
export type State = {
  phase: 'idle' | 'requested' | 'awake' | 'done';
  device: Device;
  settings: Settings;
  now: number;
};
export type Session = { url: string; token: string };

/** "https://host/#token=abc…" (the Mac's pairing QR), a bare 32+ hex token, or junk. */
export function parsePairing(
  text: string,
): { url?: string; token: string } | null {
  const t = text.trim();
  const link = t.match(/^(https?:\/\/[^\s#?]+?)\/?(?:[?#].*)?$/i);
  const tok =
    t.match(/token=([0-9a-f]{32,})/i) || t.match(/^([0-9a-f]{32,})$/i);
  if (!tok) return null;
  return link
    ? { url: normalizeUrl(link[1]), token: tok[1] }
    : { token: tok[1] };
}

export function normalizeUrl(u: string): string {
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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

export function span(ms: number): string {
  const a = Math.abs(ms);
  if (a < 60e3) return `${Math.max(1, Math.round(a / 1e3))} s`;
  const m = Math.round(a / 60e3);
  return m < 60
    ? `${m} min`
    : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export type Led = 'off' | 'sleep' | 'ready' | 'pending' | 'awake';
export type Phase =
  | 'loading'
  | 'never'
  | 'asleep'
  | 'idle'
  | 'ready'
  | 'requested'
  | 'awake'
  | 'done';
export type View = {
  phase: Phase;
  led: Led;
  title: string;
  line: string;
  facts: [string, string][];
  note?: string;
  primary: {
    label: string;
    action?: 'wake' | 'cancel';
    quiet?: boolean;
    disabled?: boolean;
  };
  canCancelRequest: boolean;
  pollMs: number;
};

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Everything the screen shows, derived from the last state and the clock. `skew` = server clock minus ours. */
export function deriveView(s: State | null, nowLocal: number, skew = 0): View {
  const now = nowLocal + skew;
  const d: Device = s?.device ?? {};
  const st: Settings = s?.settings ?? { interval: 5, hold: 30 };
  const seen = d.lastSeen ? now - d.lastSeen : Infinity;
  const every =
    (d.ac === false ? Math.max(st.interval, 10) : st.interval) * 60e3; // the Mac backs off to 10 min on battery
  const nextIn = d.lastSeen ? d.lastSeen + every - now : null;
  const asleep = seen > Math.max(every * 1.5, 5.5 * 60e3); // an awake Mac refreshes lastSeen only every 5 min
  const listening = !!d.listening && !asleep;
  const name = (d.host || 'Your Mac').replace(/\.local$/, '');
  const holdEnds = (d.ackAt || 0) + st.hold * 60e3;

  const phase: Phase = !s
    ? 'loading'
    : !d.lastSeen
    ? 'never'
    : s.phase === 'idle'
    ? asleep
      ? 'asleep'
      : listening
      ? 'ready'
      : 'idle'
    : s.phase;

  const copy: Record<Phase, [Led, string, string]> = {
    loading: ['off', 'Checking…', ''],
    never: [
      'off',
      'Not paired.',
      'Open MacWake on your Mac to connect it to this console.',
    ],
    asleep: [
      'sleep',
      'Asleep.',
      `${name} is resting and checks in every ${span(every)}.`,
    ],
    idle: ['awake', 'Awake.', `${name} is on and checking in.`],
    ready: [
      'ready',
      'Ready.',
      `${name} is plugged in and listening, so it wakes within seconds.`,
    ],
    requested: [
      'pending',
      'Waking up…',
      listening
        ? 'Sent. Your Mac should respond in a few seconds.'
        : !asleep
        ? 'Your Mac is already on and will pick this up within a minute.'
        : nextIn !== null && nextIn > 0
        ? `Your Mac will see the request at its next check-in, in about ${span(
            nextIn,
          )}.`
        : 'Your Mac should check in any moment now.',
    ],
    awake: [
      'awake',
      'Awake.',
      d.lid
        ? `Staying awake until ${clock(
            holdEnds,
          )} with the lid closed, so the screen stays off. Screen Sharing and SSH work.`
        : `Staying awake until ${clock(
            holdEnds,
          )}. Screen Sharing and SSH should work now.`,
    ],
    done: [
      'sleep',
      'Back asleep.',
      'The awake time ended. Wake it again if you need more time.',
    ],
  };
  const [led, title, line] = copy[phase];

  const facts: [string, string][] = [];
  if (d.lastSeen) {
    facts.push(['Last check-in', `${span(seen)} ago`]);
    if (asleep && !d.listening && phase !== 'awake' && nextIn !== null)
      facts.push([
        'Next check-in',
        nextIn > 0 ? `in ${span(nextIn)}` : 'any moment',
      ]);
    facts.push(['Lid', d.lid ? 'Closed' : 'Open']);
    facts.push([
      'Power',
      `${d.ac ? 'On charger' : 'On battery'}${
        d.battery != null ? `, ${d.battery}%` : ''
      }`,
    ]);
    if (d.host) facts.push(['Mac', name]);
  }

  const primary: View['primary'] =
    phase === 'awake'
      ? { label: 'Let it sleep', action: 'cancel', quiet: true }
      : phase === 'requested'
      ? { label: 'Waiting for your Mac…', disabled: true }
      : {
          label: phase === 'done' ? 'Wake it again' : 'Wake up Mac',
          action: 'wake',
          disabled: phase === 'never' || phase === 'loading',
        };

  return {
    phase,
    led,
    title,
    line,
    facts,
    primary,
    note:
      d.lastSeen && d.ac === false
        ? 'Your Mac is on battery, so it checks in every 10 minutes at most. Plug it in for faster wakes.'
        : undefined,
    canCancelRequest: phase === 'requested',
    pollMs: s?.phase === 'requested' ? 2000 : 8000,
  };
}

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
