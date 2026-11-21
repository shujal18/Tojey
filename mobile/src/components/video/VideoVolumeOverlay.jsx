import React from 'react';
import { Text, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
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

export default function VideoVolumeOverlay({ value }) {
  if (!value || !value.visible) return null;
  return (
    <View style={[videoStyles.overlay, { right: 20, top: '34%', transform: [{ translateY: -40 }] }]} pointerEvents="none">
      <View style={videoStyles.overlayCard}>
        <Icon name={value.level === 0 ? 'volume-mute' : 'volume-high'} size={21} color="#fff" />
        <Meter value={value.level} />
        <Text style={videoStyles.overlayText}>{Math.round(value.level * 100)}%</Text>
      </View>
    </View>
  );
}
