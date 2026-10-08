/**
 * MacWake: the web console's screen (console-next/app/page.js + globals.css) in React Native.
 * All status logic lives in src/core.ts; this file only draws it.
 *
 * @format
 */

import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  initialWindowMetrics,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import * as Keychain from 'react-native-keychain';
import {
  api,
  ApiError,
  deriveView,
  DEFAULT_CONSOLE,
  parsePairing,
  type Led,
  type Session,
  type State,
} from './src/core';

// The camera only loads when someone taps "Scan pairing code".
const Scanner = React.lazy(() => import('./src/Scanner'));

// Night at home: indigo dark, always. One loud element: the sleep light. (globals.css dark tokens.)
const c = {
  bg: '#12142b',
  ink: '#e9e7f3',
  soft: '#9a9cc0',
  line: '#262a52',
  raise: '#1b1e3d',
  accent: '#e9e7f3',
  onAccent: '#12142b',
  awake: '#5bd6b5',
  pending: '#f2b45a',
  led: '#fff7e8',
  sleepLed: '#fff7e8',
  sleepGlow: '0 0 18px 4px #fff7e899',
  lid: '#4d5294',
  err: '#ff8a7a',
};
const FONT = {
  regular: 'Onest-Regular',
  medium: 'Onest-Medium',
  semibold: 'Onest-SemiBold',
};

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduce,
    );
    return () => sub.remove();
  }, []);
  return reduce;
}

/** VoiceOver has no live regions, so read new messages out; TalkBack uses accessibilityLiveRegion. */
function useAnnounce(msg: string) {
  useEffect(() => {
    if (msg && Platform.OS === 'ios')
      AccessibilityInfo.announceForAccessibility(msg);
  }, [msg]);
}

// The session lives in the iOS Keychain (Android Keystore), only readable on this device.
const VAULT = { service: 'io.macwake.console' };
const vault = {
  async load(): Promise<Session | null> {
    try {
      const r = await Keychain.getGenericPassword(VAULT);
      return r ? { url: r.username, token: r.password } : null;
    } catch {
      return null;
    }
  },
  save: (x: Session) =>
    Keychain.setGenericPassword(x.url, x.token, {
      ...VAULT,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }).catch(() => false),
  clear: () => Keychain.resetGenericPassword(VAULT).catch(() => false),
};

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <StatusBar barStyle="light-content" />
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [session, setSession] = useState<Session | null | undefined>(undefined); // undefined until the Keychain answers
  const [err, setErr] = useState('');
  const [splash, setSplash] = useState(true);
  const lastUrl = useRef(DEFAULT_CONSOLE); // signing out forgets the token, not the console (the web keeps its origin too)

  useEffect(() => {
    vault.load().then(x => {
      if (x) lastUrl.current = x.url;
      setSession(x);
    });
  }, []);
  const signIn = useCallback((x: Session) => {
    lastUrl.current = x.url;
    vault.save(x);
    setErr('');
    setSession(x);
  }, []);
  const signOut = useCallback((why = '') => {
    vault.clear();
    setErr(why);
    setSession(null);
  }, []);
  const splashDone = useCallback(() => setSplash(false), []);

  return (
    <>
      {session === undefined ? null : session ? (
        <Console session={session} onSignOut={signOut} />
      ) : (
        <SignIn err={err} consoleUrl={lastUrl.current} onSubmit={signIn} />
      )}
      {splash && <Splash ready={session !== undefined} onDone={splashDone} />}
    </>
  );
}

/** The iOS launch screen, drawn again (tools/make-splash.swift has the same geometry), then faded into the app. */
function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!ready) return;
    Animated.timing(fade, {
      toValue: 0,
      duration: 380,
      delay: 120,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(onDone);
  }, [ready, fade, onDone]);
  const scale = fade.interpolate({
    inputRange: [0, 1],
    outputRange: [1.05, 1],
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[s.splash, { opacity: fade }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[s.mark, { transform: [{ scale }] }]}>
        <View style={s.markLid} />
        <View
          style={[
            s.markLed,
            { backgroundColor: c.sleepLed, boxShadow: c.sleepGlow },
          ]}
        />
        <Text style={s.wordmark} allowFontScaling={false}>
          MacWake
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

type Form = { interval: string; hold: string; instant: boolean };
const toForm = (st: State['settings']): Form => ({
  interval: String(st.interval),
  hold: String(st.hold),
  instant: st.instant !== false,
});

function Console({
  session,
  onSignOut,
}: {
  session: Session;
  onSignOut: (why?: string) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [skew, setSkew] = useState(0); // server clock minus ours
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [, tick] = useState(0);
  const latest = useRef(0);
  const mutating = useRef(0);
  useAnnounce(err);

  const call = useCallback(
    async (action: string, body?: object) => {
      const poll = action === 'state';
      if (poll && mutating.current) return; // a wake/cancel/settings answer is on its way and will be fresher
      const mine = ++latest.current;
      if (!poll) mutating.current++;
      try {
        const next = await api(session, action, body);
        if (poll && mine !== latest.current) return; // a newer request already answered; don't flash older state
        setSkew(next.now - Date.now());
        setState(next);
        setErr('');
        setForm(f => (action === 'settings' || !f ? toForm(next.settings) : f));
      } catch (e) {
        const x = e as ApiError;
        if (x.status === 401) onSignOut(x.message);
        else if (!poll || mine === latest.current) setErr(x.message);
      } finally {
        if (!poll) mutating.current--;
      }
    },
    [session, onSignOut],
  );

  const act = async (action: string, body?: object) => {
    setBusy(true);
    await call(action, body);
    setBusy(false);
  };
  const refresh = async () => {
    setPulling(true);
    await call('state');
    setPulling(false);
  };
  const save = (f: Form) =>
    act('settings', {
      interval: +f.interval,
      hold: +f.hold,
      instant: f.instant,
    });

  const view = deriveView(state, Date.now(), skew);
  const pollMs = useRef(view.pollMs);
  pollMs.current = view.pollMs;

  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(async () => {
        if (AppState.currentState === 'active') await call('state');
        if (alive) loop();
      }, pollMs.current);
    };
    call('state');
    loop();
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') call('state');
    });
    const ticker = setInterval(() => tick(n => n + 1), 5e3);
    return () => {
      alive = false;
      clearTimeout(t);
      clearInterval(ticker);
      sub.remove();
    };
  }, [call]);

  // Read status changes out for VoiceOver when the status word changes, not on every clock tick of the line.
  useEffect(() => {
    if (Platform.OS === 'ios' && view.phase !== 'loading')
      AccessibilityInfo.announceForAccessibility(`${view.title} ${view.line}`);
  }, [view.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const { primary } = view;
  return (
    <Screen
      refresh={{ refreshing: pulling, onRefresh: refresh }}
      top={
        <View style={s.top}>
          <Text style={s.brand}>MacWake</Text>
          <Link label="Sign out" onPress={() => onSignOut()} />
        </View>
      }
      dock={
        <>
          {view.canCancelRequest && (
            <Link
              label="Cancel request"
              center
              disabled={busy}
              onPress={() => act('cancel')}
            />
          )}
          <Primary
            label={primary.label}
            quiet={primary.quiet}
            disabled={busy || primary.disabled}
            onPress={() => primary.action && act(primary.action)}
          />
        </>
      }
    >
      <Hero led={view.led} title={view.title} line={view.line} />

      {view.facts.length > 0 && (
        <View style={s.facts}>
          {view.facts.map(([k, v]) => {
            const [main, rest] = k === 'Power' ? v.split(', ') : [v]; // battery % is set soft, like the web
            return (
              <View
                key={k}
                style={s.fact}
                accessible
                accessibilityLabel={`${k}: ${v}`}
              >
                <Text style={s.dt}>{k}</Text>
                <Text
                  style={[s.dd, k === 'Mac' && s.host]}
                  numberOfLines={k === 'Mac' ? 1 : undefined}
                >
                  {main}
                  {rest ? <Text style={s.softText}>, {rest}</Text> : null}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {view.note ? <Text style={s.note}>{view.note}</Text> : null}

      <Timing form={form} setForm={setForm} busy={busy} onSave={save} />

      {err ? (
        <Text
          style={s.err}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {err}
        </Text>
      ) : null}
    </Screen>
  );
}

function Timing({
  form,
  setForm,
  busy,
  onSave,
}: {
  form: Form | null;
  setForm: (f: Form) => void;
  busy: boolean;
  onSave: (f: Form) => void;
}) {
  const reduce = useReduceMotion();
  const [open, setOpen] = useState(false);
  const [bad, setBad] = useState(''); // its own message: a poll's success clears the console error
  useAnnounce(bad);
  const edit = (f: Form) => {
    setBad('');
    setForm(f);
  };
  const save = () => {
    if (!form) return;
    // The web's number fields refuse these too.
    const why = !(+form.interval >= 1 && +form.interval <= 240)
      ? 'Check in every 1 to 240 minutes.'
      : !(+form.hold >= 1 && +form.hold <= 1440)
      ? 'Stay awake for 1 to 1440 minutes.'
      : '';
    setBad(why);
    if (!why) onSave(form);
  };
  const toggle = () => {
    if (!reduce)
      LayoutAnimation.configureNext(
        LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'),
      );
    setOpen(o => !o);
  };
  return (
    <View style={s.timing}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
      >
        <Text style={s.summary}>Timing {open ? '−' : '+'}</Text>
      </Pressable>
      {open && form && (
        <View style={s.form}>
          <View style={s.row}>
            <Text style={s.label}>Instant wake on charger</Text>
            <Switch
              value={form.instant}
              onValueChange={v => edit({ ...form, instant: v })}
              trackColor={{ true: c.awake, false: c.line }}
              ios_backgroundColor={c.line}
              thumbColor="#ffffff"
              accessibilityLabel="Instant wake on charger"
            />
          </View>
          <Text style={s.help}>
            While plugged in, your Mac skips deep sleep and keeps listening, so
            it wakes in seconds. The screen still turns off. On battery it falls
            back to check-ins.
          </Text>
          <Minutes
            label={
              form.instant ? 'On battery, check in every' : 'Check in every'
            }
            value={form.interval}
            onChange={v => edit({ ...form, interval: v })}
          />
          <Text style={s.help}>
            This is the longest you wait after tapping wake. Shorter uses a
            little more battery.
          </Text>
          <Minutes
            label="Stay awake for"
            value={form.hold}
            onChange={v => edit({ ...form, hold: v })}
          />
          <Pressable
            style={({ pressed }) => [s.save, (busy || pressed) && s.dim]}
            disabled={busy}
            onPress={save}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
          >
            <Text style={s.body}>Save timing</Text>
          </Pressable>
          {bad ? (
            <Text
              style={s.err}
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
            >
              {bad}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** The web's :focus-visible ring, as a border. */
function useFocusRing() {
  const [focused, setFocused] = useState(false);
  return [
    focused,
    { onFocus: () => setFocused(true), onBlur: () => setFocused(false) },
  ] as const;
}

function Minutes({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [focused, ring] = useFocusRing();
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <View style={s.field}>
        <TextInput
          {...ring}
          style={[s.minutes, focused && s.focused]}
          value={value}
          onChangeText={t => onChange(t.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={4}
          selectionColor={c.awake}
          accessibilityLabel={`${label}, minutes`}
        />
        <Text style={s.softText}>min</Text>
      </View>
    </View>
  );
}

function SignIn({
  err,
  consoleUrl,
  onSubmit,
}: {
  err: string;
  consoleUrl: string;
  onSubmit: (x: Session) => void;
}) {
  const [token, setToken] = useState('');
  const [scan, setScan] = useState(false);
  const [focused, ring] = useFocusRing();
  useAnnounce(err);

  // The Mac's pairing link ("https://console/#token=…") carries its console; a bare token uses the last one.
  const url = useRef(consoleUrl);
  const onToken = (t: string) => {
    const p = parsePairing(t);
    if (p?.url) {
      url.current = p.url;
      setToken(p.token);
    } else setToken(t);
  };
  const submit = (text = token) => {
    const v = text.trim();
    if (!v) return;
    const p = parsePairing(v);
    onSubmit({ url: p?.url ?? url.current, token: p?.token ?? v });
  };

  return (
    <Screen>
      <Hero
        led="sleep"
        title="MacWake"
        line="Scan the pairing code from the MacWake menu on your Mac, or paste its token."
      />
      {scan && (
        <Suspense fallback={null}>
          <Scanner
            onClose={() => setScan(false)}
            onPairing={p => {
              setScan(false);
              onSubmit({ url: p.url ?? url.current, token: p.token });
            }}
          />
        </Suspense>
      )}
      <View style={s.signin}>
        <View style={s.stack}>
          <Text style={s.softText}>Token</Text>
          <TextInput
            {...ring}
            style={[s.input, focused && s.focused]}
            value={token}
            onChangeText={onToken}
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            placeholder="48 letters and numbers"
            placeholderTextColor={c.soft}
            selectionColor={c.awake}
            returnKeyType="go"
            onSubmitEditing={e => submit(e.nativeEvent.text)} // the field's own text: state may lag a fast paste + Return
            accessibilityLabel="Token"
          />
        </View>
        {err ? (
          <Text
            style={[s.err, s.errSignin]}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
          >
            {err}
          </Text>
        ) : null}
        <Primary label="Sign in" onPress={() => submit()} />
        {/* Scanning uses AVFoundation's QR reader, which VisionCamera only offers on iOS. */}
        {Platform.OS === 'ios' && (
          <Primary
            label="Scan pairing code"
            quiet
            style={s.scanbtn}
            onPress={() => setScan(true)}
          />
        )}
      </View>
    </Screen>
  );
}

/** The shell: centered 440 pt column, safe areas, content that scrolls, and the dock in the thumb zone. */
function Screen({
  top,
  dock,
  refresh,
  children,
}: {
  top?: React.ReactNode;
  dock?: React.ReactNode;
  children?: React.ReactNode;
  refresh?: { refreshing: boolean; onRefresh: () => void };
}) {
  const inset = useSafeAreaInsets();
  return (
    // The keyboard's height already covers the home-indicator inset, so don't pad for it twice.
    <KeyboardAvoidingView
      style={s.fill}
      behavior="padding"
      keyboardVerticalOffset={-inset.bottom}
    >
      <View
        style={[
          s.shell,
          { paddingTop: inset.top + 12, paddingBottom: inset.bottom + 16 },
        ]}
      >
        {top}
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.grow}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
          refreshControl={
            refresh && (
              <RefreshControl
                {...refresh}
                tintColor={c.soft}
                colors={[c.accent]}
                progressBackgroundColor={c.raise}
              />
            )
          }
        >
          {children}
        </ScrollView>
        {dock ? <View style={s.dock}>{dock}</View> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

/** The sleep light and the status word. A new status fades up into place. */
function Hero({ led, title, line }: { led: Led; title: string; line: string }) {
  const reduce = useReduceMotion();
  const { width, height } = useWindowDimensions();
  const size = Math.min(73.6, Math.max(54.4, width * 0.17)); // clamp(3.4rem, 17vw, 4.6rem)
  const shown = useRef(new Animated.Value(1)).current;
  const first = useRef(true);

  useEffect(() => {
    if (first.current || reduce) {
      first.current = false;
      return;
    }
    shown.setValue(0);
    Animated.timing(shown, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [title, reduce, shown]);
  const rise = shown.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });

  return (
    <View
      style={[s.hero, { paddingTop: height * 0.09 }]}
      accessibilityLiveRegion="polite"
    >
      <Light kind={led} />
      <Animated.View
        style={{ opacity: shown, transform: [{ translateY: rise }] }}
      >
        {/* Already sized to the screen, so it doesn't grow with Dynamic Type (the line under it does). */}
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1}
          style={[
            s.h1,
            {
              fontSize: size,
              lineHeight: size * 0.95,
              letterSpacing: -0.045 * size,
            },
          ]}
        >
          {title}
        </Text>
        {line ? <Text style={s.line}>{line}</Text> : null}
      </Animated.View>
    </View>
  );
}

/** Apple's sleep light breathes about 12 times a minute; a pending wake blinks. */
function Light({ kind }: { kind: Led }) {
  const reduce = useReduceMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  // Layout effect: the starting opacity is set before the first paint, so a sleeping light never flashes full.
  useLayoutEffect(() => {
    const to = (v: number, ms: number) =>
      Animated.timing(opacity, {
        toValue: v,
        duration: ms,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      });
    // resetBeforeIteration: false, or each loop jumps back to the value the Animated.Value was created with.
    const loop = (steps: Animated.CompositeAnimation[]) =>
      Animated.loop(Animated.sequence(steps), {
        iterations: -1,
        resetBeforeIteration: false,
      });
    const anim = reduce
      ? null
      : kind === 'sleep'
      ? loop([to(1, 2250), Animated.delay(500), to(0.12, 2250)])
      : kind === 'pending'
      ? loop([to(0.25, 550), to(1, 550)])
      : null;
    opacity.setValue(kind === 'sleep' ? (reduce ? 0.7 : 0.12) : 1);
    anim?.start();
    return () => anim?.stop();
  }, [kind, reduce, opacity]);

  // globals.css box-shadows, verbatim.
  const look = {
    sleep: [c.sleepLed, c.sleepGlow],
    pending: [c.pending, `0 0 18px 4px ${c.pending}8c`],
    ready: [c.led, `0 0 14px 3px ${c.led}73`],
    awake: [c.awake, `0 0 22px 6px ${c.awake}73`],
  } as const;
  const g = kind === 'off' ? null : look[kind];
  return (
    <View
      style={s.led}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {g && (
        <Animated.View
          style={[s.ledOn, { opacity, backgroundColor: g[0], boxShadow: g[1] }]}
        />
      )}
    </View>
  );
}

function Primary({
  label,
  onPress,
  disabled,
  quiet,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
  style?: object;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.primary,
        quiet && s.quiet,
        disabled && s.disabled,
        pressed && s.pressed,
        style,
      ]}
    >
      <Text style={[s.primaryText, quiet && s.quietText]}>{label}</Text>
    </Pressable>
  );
}

function Link({
  label,
  onPress,
  disabled,
  center,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  center?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={8}
      style={({ pressed }) => [
        s.link,
        center && s.center,
        (disabled || pressed) && s.dim,
      ]}
    >
      <Text style={s.softText}>{label}</Text>
    </Pressable>
  );
}

const body = {
  fontFamily: FONT.regular,
  fontSize: 17,
  lineHeight: 24.5,
  color: c.ink,
};
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: c.bg },
  shell: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: 22,
  },
  scroll: { flex: 1, marginHorizontal: -22 },
  grow: { flexGrow: 1, paddingHorizontal: 22 },
  body,
  softText: { ...body, color: c.soft },

  // Splash: 220 x 170 mark centered on the background, same as the launch screen.
  splash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: c.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { width: 220, height: 170 },
  markLid: {
    position: 'absolute',
    left: 35,
    top: 34,
    width: 150,
    height: 16,
    borderRadius: 8,
    backgroundColor: c.lid,
  },
  markLed: {
    position: 'absolute',
    left: 87,
    top: 64,
    width: 46,
    height: 13,
    borderRadius: 6.5,
  },
  wordmark: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 104,
    fontFamily: FONT.semibold,
    fontSize: 40,
    lineHeight: 48,
    letterSpacing: -1.8,
    textAlign: 'center',
    color: c.ink,
  },

  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 44,
  },
  brand: {
    ...body,
    fontFamily: FONT.semibold,
    letterSpacing: -0.17,
    color: c.soft,
  },
  link: { paddingVertical: 10 },
  center: { alignSelf: 'center', marginBottom: 6 },
  dim: { opacity: 0.6 },

  hero: { paddingBottom: 28 },
  h1: {
    fontFamily: FONT.semibold,
    color: c.ink,
    marginTop: 30,
    marginBottom: 14,
  },
  line: { ...body, fontSize: 17, color: c.soft, maxWidth: 361 }, // 32ch

  led: {
    width: 46,
    height: 13,
    borderRadius: 99,
    backgroundColor: c.soft + '4d',
  },
  ledOn: { ...StyleSheet.absoluteFill, borderRadius: 99 },

  facts: { borderTopWidth: 1, borderColor: c.line },
  fact: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderColor: c.line,
  },
  dt: { ...body, color: c.soft, flexShrink: 1 },
  dd: {
    ...body,
    fontFamily: FONT.medium,
    textAlign: 'right',
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  host: { maxWidth: '60%' },

  note: {
    ...body,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 18,
    paddingLeft: 12,
    borderLeftWidth: 3,
    borderColor: c.pending,
  },
  err: { ...body, fontSize: 15, lineHeight: 22, marginTop: 16, color: c.err },
  errSignin: { marginTop: 2, marginBottom: 12 },

  timing: { marginTop: 22 },
  summary: {
    ...body,
    color: c.soft,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  form: { paddingTop: 6, paddingBottom: 4 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 16,
  },
  label: { ...body, flexShrink: 1 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  minutes: {
    ...body,
    lineHeight: undefined,
    minWidth: 71,
    textAlign: 'right',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.raise,
    fontVariant: ['tabular-nums'],
  },
  focused: { borderColor: c.awake },
  help: {
    ...body,
    fontSize: 14,
    lineHeight: 20,
    color: c.soft,
    marginTop: -2,
    marginBottom: 6,
  },
  save: {
    marginTop: 10,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },

  // The thumb zone.
  dock: { paddingTop: 28 },
  primary: {
    width: '100%',
    borderRadius: 999,
    paddingVertical: 19,
    paddingHorizontal: 24,
    backgroundColor: c.accent,
    alignItems: 'center',
  },
  primaryText: {
    fontFamily: FONT.semibold,
    fontSize: 18,
    lineHeight: 26,
    letterSpacing: -0.18,
    color: c.onAccent,
  },
  quiet: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: c.line,
    paddingVertical: 17.5,
  },
  quietText: { color: c.ink },
  pressed: { transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.45 },

  signin: { marginTop: 'auto' },
  stack: { gap: 8, marginBottom: 14 },
  input: {
    ...body,
    lineHeight: undefined,
    paddingVertical: 15,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.raise,
  },
  scanbtn: { marginTop: 10 },
});
