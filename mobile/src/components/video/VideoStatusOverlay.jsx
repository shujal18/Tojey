import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { fs } from '../../utils/size';
import { VIDEO_ACCENT } from './videoConfig';

export default function VideoStatusOverlay({ label, error, buffering, onRetry }) {
  const visible = !!(label || error || buffering);
  const [mounted, setMounted] = useState(visible);
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return undefined;
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? 170 : 190,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!visible && finished) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, mounted, opacity]);

  if (!mounted) return null;

  return (
    <Animated.View pointerEvents={error ? 'auto' : 'none'} style={[styles.root, { opacity }]}>
      <View style={styles.card}>
        {error ? (
          <>
            <Text style={styles.title}>Unable to play this video.</Text>
            <Text style={styles.detail}>{error}</Text>
            <TouchableOpacity onPress={onRetry} accessibilityLabel="Retry video" style={styles.retry}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {buffering ? <ActivityIndicator color="#fff" size="small" /> : null}
            <Text style={[styles.label, buffering ? styles.labelWithSpinner : null]}>{label}</Text>
          </>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 24, right: 24, top: '42%', zIndex: 25, alignItems: 'center' },
  card: {
    minWidth: 160,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 12,
    backgroundColor: 'rgba(5,12,24,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  title: { color: '#fff', fontSize: fs(13), fontWeight: '800', textAlign: 'center' },
  detail: { color: 'rgba(255,255,255,0.66)', fontSize: fs(11), marginTop: 4, textAlign: 'center' },
  retry: { marginTop: 10, borderRadius: 16, paddingHorizontal: 18, paddingVertical: 7, backgroundColor: VIDEO_ACCENT },
  retryText: { color: '#fff', fontSize: fs(12), fontWeight: '800' },
  label: { color: '#fff', fontSize: fs(12), fontWeight: '700', textAlign: 'center' },
  labelWithSpinner: { marginTop: 7 },
});
