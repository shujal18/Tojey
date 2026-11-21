import React from 'react';
import { Text, View } from 'react-native';
import { Icon } from '../AppIcon';
import { VIDEO_ACCENT } from './videoConfig';
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

export default function VideoBrightnessOverlay({ value }) {
  if (!value || !value.visible) return null;
  return (
    <View style={[videoStyles.overlay, { left: 20, top: '34%', transform: [{ translateY: -40 }] }]} pointerEvents="none">
      <View style={videoStyles.overlayCard}>
        <Icon name="sunny" size={21} color="#fff" />
        <Meter value={value.level} />
        <Text style={videoStyles.overlayText}>{Math.round(value.level * 100)}%</Text>
      </View>
    </View>
  );
}
