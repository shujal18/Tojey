import React, { useEffect, useRef } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';

export default function Toast({ message, bottom }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!message) return;
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    const t = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    }, 2200);
    return () => clearTimeout(t);
  }, [message, opacity]);

  if (!message) return null;

  return (
    <Animated.View pointerEvents="none" style={[styles.wrap, { bottom: bottom != null ? bottom : 96, opacity }]}>
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute', alignSelf: 'center',
    backgroundColor: 'rgba(20,20,28,0.92)', borderRadius: 22,
    paddingHorizontal: 16, paddingVertical: 10, elevation: 8,
    zIndex: 200, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '600' },
});