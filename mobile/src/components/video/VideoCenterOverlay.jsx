import React, { memo, useEffect, useRef } from 'react';
import { Animated, StyleSheet, TouchableOpacity } from 'react-native';
import { Icon } from '../AppIcon';

function VideoCenterOverlay({ playing = false, disabled = false, onToggle }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    scale.setValue(0.94);
    opacity.setValue(0.7);
    const animation = Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [playing, opacity, scale]);

  return (
    <Animated.View
      style={[
        styles.root,
        disabled && styles.disabled,
        { opacity, transform: [{ scale }] },
      ]}
      pointerEvents="box-none"
    >
      <TouchableOpacity
        style={styles.button}
        onPress={onToggle}
        disabled={disabled}
        accessibilityLabel={playing ? 'Pause video' : 'Play video'}
        accessibilityRole="button"
        activeOpacity={0.72}
      >
        <Icon name={playing ? 'pause' : 'play'} size={34} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 13,
  },
  button: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(4, 10, 20, 0.56)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000',
    shadowOpacity: 0.24,
    shadowRadius: 14,
    elevation: 6,
  },
  disabled: { opacity: 0.5 },
});

export default memo(VideoCenterOverlay);
