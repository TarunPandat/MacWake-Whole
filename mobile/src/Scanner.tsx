/**
 * Full-screen QR scanner for the Mac's "Pair phone…" code. Mirrors Scanner in console-next/app/page.js.
 * iOS only: VisionCamera's object (QR) output uses AVFoundation and isn't available on Android.
 *
 * @format
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Linking,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  isScannedCode,
  useCameraPermission,
  useObjectOutput,
  type ScannedObject,
  type ScannedObjectType,
} from 'react-native-vision-camera';
import { parsePairing } from './core';

type Pairing = NonNullable<ReturnType<typeof parsePairing>>;

const QR: ScannedObjectType[] = ['qr']; // stable reference: useObjectOutput rebuilds the output when this changes
const HINT = 'Point your camera at the pairing code in MacWake on your Mac.';
const DENIED =
  'Camera access is off for MacWake. Allow it in Settings, or paste the token.';
const NO_CAMERA = 'No camera is available. Paste the token instead.';

export default function Scanner({
  onPairing,
  onClose,
}: {
  onPairing: (p: Pairing) => void;
  onClose: () => void;
}) {
  const inset = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();
  const [msg, setMsg] = useState(HINT);
  const done = useRef(false);

  useEffect(() => {
    if (canRequestPermission) requestPermission();
  }, [canRequestPermission, requestPermission]);

  const onObjectsScanned = useCallback(
    (objects: ScannedObject[]) => {
      if (done.current) return;
      for (const o of objects) {
        if (!isScannedCode(o) || !o.value) continue;
        const p = parsePairing(o.value);
        if (p) {
          done.current = true;
          onPairing(p);
          return;
        }
        setMsg(
          "That code isn't a MacWake pairing code. Use Pair phone in the MacWake menu on your Mac.",
        );
      }
    },
    [onPairing],
  );
  const output = useObjectOutput({ types: QR, onObjectsScanned });
  const outputs = useMemo(() => [output], [output]);

  const noCamera = useCallback(() => setMsg(NO_CAMERA), []);
  const denied = !hasPermission && !canRequestPermission;
  const said = denied ? DENIED : msg;
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(said); // VoiceOver has no live regions
  }, [said]);
  const box = Math.min(width * 0.68, 300);
  const top = height * 0.42 - box / 2;
  const left = (width - box) / 2;
  const B = Math.max(width, height); // dim border wide enough to cover the screen; inner radius = outer - border = 24

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
    >
      <StatusBar barStyle="light-content" />
      <View
        style={styles.fill}
        accessibilityViewIsModal
        accessibilityLabel="Scan pairing code"
      >
        {hasPermission && (
          <CameraGuard onFail={noCamera}>
            {/* 'interface' orientation: 'device' needs the accelerometer and throws without one. */}
            <Camera
              style={StyleSheet.absoluteFill}
              device="back"
              isActive
              outputs={outputs}
              orientationSource="interface"
              onError={noCamera}
            />
          </CameraGuard>
        )}
        {/* Dim everything but the finder's rounded square (the web's 100vmax box-shadow). */}
        <View
          style={[
            styles.dim,
            {
              top: top - B,
              left: left - B,
              width: box + 2 * B,
              height: box + 2 * B,
              borderWidth: B,
              borderRadius: 24 + B,
            },
          ]}
        />
        <View style={[styles.finder, { top, left, width: box, height: box }]} />

        <View style={[styles.bar, { paddingBottom: inset.bottom + 18 }]}>
          <Text style={styles.msg} accessibilityLiveRegion="polite">
            {said}
          </Text>
          {denied && (
            <Button
              label="Open Settings"
              onPress={() => Linking.openSettings()}
            />
          )}
          <Button label="Cancel" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

/** A camera that fails to start shows the message instead of taking the whole app down. */
class CameraGuard extends React.Component<
  { onFail: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  dim: {
    position: 'absolute',
    borderColor: 'rgba(0,0,0,0.67)',
    overflow: 'hidden', // native CALayer border; without it iOS rasterises this huge border into a bitmap
  },
  finder: {
    position: 'absolute',
    borderRadius: 24,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.53)',
  },
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 20,
    paddingHorizontal: 22,
    gap: 10,
  },
  msg: {
    fontFamily: 'Onest-Regular',
    fontSize: 17,
    lineHeight: 24.5,
    color: '#fff',
    maxWidth: 383,
    marginBottom: 4,
  },
  button: {
    borderRadius: 999,
    paddingVertical: 17.5,
    paddingHorizontal: 24,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
  },
  buttonText: {
    fontFamily: 'Onest-SemiBold',
    fontSize: 18,
    lineHeight: 26,
    letterSpacing: -0.18,
    color: '#fff',
  },
  pressed: { transform: [{ scale: 0.98 }] },
});
