import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';

function VideoGestureOverlay({ panHandlers }) {
  return <View style={StyleSheet.absoluteFillObject} collapsable={false} {...panHandlers} />;
}

export default memo(VideoGestureOverlay);
