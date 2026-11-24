import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { clamp, formatClock, VIDEO_ACCENT } from '../../../components/video/videoConfig';
import { fs } from '../../../utils/size';
import { Icon } from '../../AppIcon';

const RATES = [0.5, 1, 1.25, 1.5, 2];

export default function ChatVideoControls({
  visible,
  playing,
  buffering,
  currentTime,
  duration,
  rate,
  error,
  onBack,
  onTogglePlay,
  onSeek,
  onRate,
  onRetry,
  onMenuVisibilityChange,
}) {
  const fade = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [rateOpen, setRateOpen] = useState(false);
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const callbacks = useRef({});
  callbacks.current = { onSeek, onRate, onMenuVisibilityChange };

  useEffect(() => {
    Animated.timing(fade, {
      toValue: visible ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [fade, visible]);

  const setMenuOpen = useCallback((open) => {
    setRateOpen(open);
    if (typeof callbacks.current.onMenuVisibilityChange === 'function') {
      callbacks.current.onMenuVisibilityChange(open);
    }
  }, []);

  useEffect(() => {
    if (!visible) setMenuOpen(false);
  }, [setMenuOpen, visible]);

  useEffect(() => () => {
    if (typeof callbacks.current.onMenuVisibilityChange === 'function') {
      callbacks.current.onMenuVisibilityChange(false);
    }
  }, []);

  const seekWidth = useRef(0);
  const grantX = useRef(0);
  const dragging = useRef(false);

  const applySeek = useMemo(() => (x) => {
    const total = Number(durationRef.current) || 0;
    if (total <= 0 || !seekWidth.current || typeof callbacks.current.onSeek !== 'function') return;
    const ratio = clamp(x / seekWidth.current, 0, 1);
    callbacks.current.onSeek(ratio * total);
  }, []);

  const seekPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (event) => {
      dragging.current = true;
      grantX.current = clamp(Number(event.nativeEvent.locationX) || 0, 0, seekWidth.current || 0);
      applySeek(grantX.current);
    },
    onPanResponderMove: (event, state) => {
      if (!dragging.current) return;
      const x = Number.isFinite(state.dx)
        ? grantX.current + Number(state.dx || 0)
        : Number(event.nativeEvent.locationX) || 0;
      applySeek(x);
    },
    onPanResponderRelease: () => { dragging.current = false; },
    onPanResponderTerminate: () => { dragging.current = false; },
    onPanResponderTerminationRequest: () => false,
  }), [applySeek]);

  const total = Number(duration) || 0;
  const progress = total > 0 ? clamp((Number(currentTime) || 0) / total, 0, 1) : 0;
  const currentRate = Number(rate) || 1;

  return (
    <Animated.View
      style={[styles.root, { opacity: fade }]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <View style={styles.topBar} pointerEvents="box-none">
        <View style={styles.gradientStrong} pointerEvents="none" />
        <View style={styles.gradientSoft} pointerEvents="none" />
        <TouchableOpacity
          onPress={onBack}
          style={styles.backButton}
          accessibilityLabel="Back"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Icon name="arrow-back" size={fs(26)} color="#fff" />
        </TouchableOpacity>
      </View>

      {error ? (
        <TouchableOpacity style={styles.center} onPress={onRetry} accessibilityLabel="Retry">
          <Icon name="refresh-outline" size={fs(22)} color="#fff" />
          <Text style={styles.centerText}>Retry</Text>
        </TouchableOpacity>
      ) : buffering ? (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator size="small" color="#fff" />
        </View>
      ) : (
        <TouchableOpacity
          style={styles.center}
          onPress={onTogglePlay}
          accessibilityLabel={playing ? 'Pause video' : 'Play video'}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Icon name={playing ? 'pause' : 'play'} size={fs(30)} color="#fff" />
        </TouchableOpacity>
      )}

      <View style={styles.bottom} pointerEvents="box-none">
        <Text style={styles.time}>{formatClock(currentTime)}</Text>
        <View
          style={styles.seekArea}
          onLayout={(event) => { seekWidth.current = event.nativeEvent.layout.width || 0; }}
          {...seekPan.panHandlers}
        >
          <View style={styles.track} pointerEvents="none">
            <View style={[styles.fill, { width: `${progress * 100}%` }]} />
            <View style={[styles.thumb, { left: `${progress * 100}%` }]} />
          </View>
        </View>
        <Text style={styles.time}>{formatClock(total)}</Text>
        <View style={styles.rateWrap}>
          {rateOpen ? (
            <View style={styles.rateMenu}>
              {RATES.map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.rateOption, option === currentRate && styles.rateOptionActive]}
                onPress={() => {
                  setMenuOpen(false);
                  if (typeof callbacks.current.onRate === 'function') callbacks.current.onRate(option);
                }}
                >
                  <Text style={[
                    styles.rateOptionText,
                    option === currentRate && styles.rateOptionTextActive,
                  ]}
                  >
                    {`${option}x`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          <TouchableOpacity
            style={styles.rateButton}
            onPress={() => setMenuOpen(!rateOpen)}
            accessibilityLabel="Playback speed"
          >
            <Text style={styles.rateText}>{`${currentRate}x`}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: fs(112),
    paddingHorizontal: fs(8),
    paddingTop: fs(10),
  },
  gradientStrong: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: fs(64),
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  gradientSoft: {
    position: 'absolute',
    top: fs(64),
    left: 0,
    right: 0,
    height: fs(48),
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  backButton: {
    width: fs(42),
    height: fs(42),
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -fs(26),
    marginLeft: -fs(26),
    width: fs(52),
    height: fs(52),
    borderRadius: fs(26),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  centerText: {
    color: '#fff',
    fontSize: fs(11),
    marginTop: fs(2),
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: fs(18),
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: fs(12),
  },
  time: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: fs(11),
    fontVariant: ['tabular-nums'],
    width: fs(44),
    textAlign: 'center',
  },
  seekArea: {
    flex: 1,
    height: fs(44),
    justifyContent: 'center',
    marginHorizontal: fs(4),
  },
  track: {
    height: fs(3),
    borderRadius: fs(2),
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: fs(2),
    backgroundColor: VIDEO_ACCENT,
  },
  thumb: {
    position: 'absolute',
    top: -fs(5),
    width: fs(13),
    height: fs(13),
    borderRadius: fs(7),
    marginLeft: -fs(6),
    backgroundColor: VIDEO_ACCENT,
  },
  rateWrap: {
    marginLeft: fs(4),
  },
  rateButton: {
    paddingHorizontal: fs(7),
    paddingVertical: fs(6),
    borderRadius: fs(8),
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  rateText: {
    color: '#fff',
    fontSize: fs(11),
    fontVariant: ['tabular-nums'],
  },
  rateMenu: {
    position: 'absolute',
    bottom: fs(40),
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(8,10,14,0.92)',
    borderRadius: fs(10),
    padding: fs(4),
  },
  rateOption: {
    paddingHorizontal: fs(7),
    paddingVertical: fs(6),
    borderRadius: fs(7),
  },
  rateOptionActive: {
    backgroundColor: VIDEO_ACCENT,
  },
  rateOptionText: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: fs(11),
  },
  rateOptionTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
});
