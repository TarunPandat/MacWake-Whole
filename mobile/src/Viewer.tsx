/**
 * Full-screen live view of the Mac over WebRTC, with mouse and keyboard control once the Mac allows it.
 * Mirrors console-next/app/Viewer.js; decisions live in core.ts and control.ts.
 *
 * @format
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  CONTROL_MESSAGES,
  createSender,
  type ControlStatus,
  type Mode,
} from './control';
import {
  KeysRow,
  Typing,
  useHardwareKeys,
  useKeyboardHeight,
  useKeys,
  usePicture,
  type TextInputRef,
} from './Controls';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(() => r(), ms));

/** Non-trickle signaling: wait until every ICE candidate is in the SDP, at most 3 s. */
function gathered(pc: RTCPeerConnection) {
  return new Promise<void>(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 3000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    };
  });
}

type Channel = ReturnType<RTCPeerConnection['createDataChannel']>;

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
  const [control, setControl] = useState<ControlStatus | null>(null); // null: a view-only Mac app
  const [size, setSize] = useState<number[]>([16, 10]); // the Mac's screen in points
  const [mode, setMode] = useState<Mode>('direct');
  const [typing, setTyping] = useState(false);
  const [attempt, setAttempt] = useState(0); // Try again re-runs the effect
  const dc = useRef<Channel | null>(null);
  const input = useRef<TextInputRef>(null);

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
        setControl(null);
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
          conn.ontrack = (e: any) => setStream(e.streams?.[0] ?? null);
          conn.onconnectionstatechange = () => {
            const s = conn.connectionState;
            if (s === 'connected') {
              clearTimeout(lost);
              wasLive = true;
              setStatus('');
            } else if (s === 'failed') fail(wasLive ? 'lost' : 'ice');
            else if (s === 'disconnected')
              lost = setTimeout(() => fail('lost'), 10e3);
          };
          await conn.setLocalDescription(await conn.createOffer({}));
          await gathered(conn);
          const id = newId();
          setStatus(ph === 'requested' ? 'Waking your Mac…' : 'Connecting…');
          await request(session, 'screen', {
            id,
            offer: conn.localDescription?.sdp,
          });
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

  // Control: only once the Mac says so (a Mac app without control never does, and stays view-only).
  const send = useMemo(
    () =>
      createSender(
        m => {
          if (dc.current?.readyState === 'open')
            dc.current.send(JSON.stringify(m));
        },
        f => requestAnimationFrame(f),
      ),
    [],
  );
  const ok = !!stream && !error && control === 'ok';
  const picture = usePicture(
    mode,
    () => ({ box: { w: width, h: height }, size }),
    send,
    ok,
  );
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
    stream && control && control !== 'ok'
      ? CONTROL_MESSAGES[control] ?? ''
      : '';
  const msg = error || (locked && stream ? 'Mac is locked' : status) || note;
  // Once the picture is up, the Close bar hides after 3 s; the corner ••• button brings it back
  // (a tap on the picture itself is kept free for controlling the Mac).
  const [bar, setBar] = useState(true);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showBar = () => {
    setBar(true);
    clearTimeout(hide.current);
    hide.current = setTimeout(() => setBar(false), 3000);
  };
  const live = !!stream && !msg;
  useEffect(() => {
    if (live) showBar();
    else {
      clearTimeout(hide.current);
      setBar(true);
    }
    return () => clearTimeout(hide.current);
  }, [live]);
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
          style={[
            st.ring,
            { left: picture.ring.x - 22, top: picture.ring.y - 22 },
          ]}
        />
      ) : null}
    </View>
  ) : null;
  const modeLabel = mode === 'direct' ? 'Direct' : 'Trackpad';
  return (
    <Modal animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View
        style={st.fill}
        accessibilityViewIsModal
        accessibilityLabel="Mac screen"
      >
        {Platform.OS === 'ios' ? (
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
        {ok && typing ? (
          <KeysRow keys={keys} bottom={kb || inset.bottom + 84} />
        ) : null}
        {bar ? (
          <View style={[st.bar, { paddingBottom: inset.bottom + 14 }]}>
            {error ? (
              <Btn label="Try again" onPress={() => setAttempt(n => n + 1)} />
            ) : null}
            {ok ? (
              <Btn
                label={modeLabel}
                say={`Touch mode: ${modeLabel}`}
                onPress={() =>
                  setMode(m => (m === 'direct' ? 'trackpad' : 'direct'))
                }
              />
            ) : null}
            {ok ? (
              <Btn label="Keys" selected={typing} onPress={toggleTyping} />
            ) : null}
            <Btn label="Close" onPress={onClose} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Show controls"
            hitSlop={12}
            onPress={showBar}
            style={[st.more, { top: inset.top + 10 }]}
          >
            <Text style={st.moreText}>•••</Text>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

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
      style={({ pressed }) => [
        st.btn,
        selected && st.btnOn,
        pressed && st.pressed,
      ]}
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
  btnOn: { backgroundColor: '#fff3' },
  pressed: { opacity: 0.6 },
  ring: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: '#fff',
  },
  more: {
    position: 'absolute',
    right: 14,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 99,
    backgroundColor: '#0007',
    opacity: 0.6,
  },
  moreText: { color: '#fff', fontSize: 16, letterSpacing: 1 },
  btnText: { color: '#fff', fontFamily: 'Onest-SemiBold', fontSize: 17 },
});
