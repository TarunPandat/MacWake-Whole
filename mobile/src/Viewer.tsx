/**
 * Full-screen live view of the Mac over WebRTC. Mirrors console-next/app/Viewer.js; decisions live in core.ts.
 *
 * @format
 */

import React, { useEffect, useRef, useState } from 'react';
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
          dc.onmessage = (e: any) => {
            try {
              setLocked(!!JSON.parse(e.data).locked);
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

  const msg = error || (locked && stream ? 'Mac is locked' : status);
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
    <RTCView
      streamURL={stream.toURL()}
      objectFit="contain"
      style={{ width, height }}
    />
  ) : null;
  return (
    <Modal animationType="fade" onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View
        style={st.fill}
        accessibilityViewIsModal
        accessibilityLabel="Mac screen"
      >
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
        {bar ? (
          <View style={[st.bar, { paddingBottom: inset.bottom + 14 }]}>
            {error ? (
              <Btn label="Try again" onPress={() => setAttempt(n => n + 1)} />
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
