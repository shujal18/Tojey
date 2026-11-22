import React, { useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { Icon } from '../AppIcon';
import { videoStyles } from './videoStyles';

function Meter({ value }) {
  const active = Math.round(value * 10);
  return (
    <View style={videoStyles.meter}>
      {Array.from({ length: 10 }).map((_, index) => (
        <View key={index} style={[videoStyles.meterSegment, index < active && videoStyles.meterSegmentOn]} />
      ))}
    </View>
  );
}

export default function VideoVolumeOverlay({ value }) {
  const visible = !!(value && value.visible);
  const level = value && typeof value.level === 'number' ? value.level : 0;
  const [mounted, setMounted] = useState(visible);
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted) return undefined;
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? 120 : 220,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!visible && finished) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, mounted, opacity]);

  if (!mounted) return null;

  return (
    <Animated.View
      style={[
        videoStyles.overlay,
        { right: 20, top: '34%', opacity, transform: [{ translateY: -40 }] },
      ]}
      pointerEvents="none"
    >
      <View style={videoStyles.overlayCard}>
        <Icon name={level === 0 ? 'volume-mute' : 'volume-high'} size={21} color="#fff" />
        <Meter value={level} />
        <Text style={videoStyles.overlayText}>{Math.round(level * 100)}%</Text>
      </View>
    </Animated.View>
  );
}
