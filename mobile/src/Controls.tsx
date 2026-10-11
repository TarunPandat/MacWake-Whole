/**
 * Remote control glue for the viewer: touches on the picture, the phone keyboard, the Mac keys row and iPad
 * hardware keyboards. Decisions live in control.ts; mirrors console-next/app/Controls.js.
 *
 * @format
 */

import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
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
export function usePicture(
  mode: Mode,
  view: () => PictureView,
  send: Send,
  enabled: boolean,
) {
  const [ring, setRing] = useState<{ x: number; y: number } | null>(null);
  const latest = useRef({ view, send, enabled });
  latest.current = { view, send, enabled };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const g = useMemo(
    () => createGestures(mode, () => latest.current.view()),
    [mode],
  );
  const handlers = useMemo(() => {
    const each = (
      e: GestureResponderEvent,
      fn: (id: string, x: number, y: number) => Msg[],
    ) =>
      latest.current.send(
        e.nativeEvent.changedTouches.flatMap(t =>
          fn(String(t.identifier), t.locationX, t.locationY),
        ),
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
      onPanResponderMove: e =>
        each(e, (id, x, y) => g.move(id, x, y, Date.now())),
      onPanResponderEnd: end,
      onPanResponderRelease: end,
      onPanResponderTerminate: () => {
        clearTimeout(timer.current);
        setRing(null);
        latest.current.send(g.cancel());
      },
    }).panHandlers;
  }, [g]);
  // A mode change, control turning off or the viewer closing mid-gesture: let go, so the next touch starts fresh.
  const reset = () => {
    clearTimeout(timer.current);
    setRing(null);
    latest.current.send(g.cancel());
  };
  useEffect(() => reset, [g]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
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
      events.addListener('key', (e: Object) => {
        const { usage, down } = e as { usage: number; down: boolean };
        const code = hidToCode(usage);
        if (code) latest.current(held.key(code, down));
      }),
      events.addListener('keyboard', (e: Object) =>
        setConnected((e as { connected: boolean }).connected),
      ),
    ];
    // ⌘Tab and friends take the app away mid-shortcut: let go of whatever is held.
    const away = AppState.addEventListener('change', s => {
      if (s !== 'active') latest.current(held.releaseAll());
    });
    native.start();
    return () => {
      away.remove();
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
    const show = Keyboard.addListener(
      ios ? 'keyboardWillShow' : 'keyboardDidShow',
      e => setH(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      ios ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setH(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}

/** Hidden input for the phone keyboard. It always holds one space, so Backspace shows up as a deleted space. */
export type TextInputRef = React.ComponentRef<typeof TextInput>;

export const Typing = forwardRef<
  TextInputRef,
  { keys: KeysApi; onBlur: () => void }
>(function HiddenInput({ keys, onBlur }, ref) {
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
            onPress={() =>
              k.mod ? keys.toggle(k.mod) : k.key && keys.press(k.key)
            }
            style={({ pressed }) => [
              st.key,
              on && st.keyOn,
              pressed && st.pressed,
            ]}
          >
            <Text style={[st.keyText, on && st.keyTextOn]}>{k.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  hidden: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexGrow: 0,
    backgroundColor: '#000c',
  },
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
