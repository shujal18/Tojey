import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { formatClock, VIDEO_ACCENT } from './videoConfig';
import { fs } from '../../utils/size';

function formatDelta(delta) {
  const abs = Math.abs(Number(delta) || 0);
  const sign = Number(delta) < 0 ? '-' : '+';
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  return h
    ? `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${sign}${m}:${String(s).padStart(2, '0')}`;
}

export default function VideoSeekOverlay({ value, duration }) {
  const visible = !!(value && value.target != null);
  const [mounted, setMounted] = useState(visible);
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return undefined;
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? 120 : 240,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!visible && finished) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, mounted, opacity]);

  if (!mounted) return null;

  const target = value && value.target != null ? value.target : 0;
  const total = Number(duration) || 0;
  const label = value && value.label ? value.label : formatDelta(value && value.delta);
  const scale = opacity.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });

  return (
    <Animated.View pointerEvents="none" style={[styles.root, { opacity, transform: [{ scale }] }]}>
      <View style={styles.card}>
        <Text style={styles.delta}>{label}</Text>
        <Text style={styles.time}>{formatClock(target)} / {formatClock(total)}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: '36%', zIndex: 26, alignItems: 'center' },
  card: {
    minWidth: 132,
    borderRadius: 18,
    backgroundColor: 'rgba(5, 12, 24, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 18,
    paddingVertical: 12,
    alignItems: 'center',
  },
  delta: { color: '#fff', fontSize: fs(20), fontWeight: '900' },
  time: { color: VIDEO_ACCENT, fontSize: fs(11), fontWeight: '700', marginTop: 3 },
});
