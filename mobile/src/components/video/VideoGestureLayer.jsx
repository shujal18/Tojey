import React from 'react';
import { StyleSheet, View } from 'react-native';

export default function VideoGestureLayer({ panHandlers }) {
  return <View style={StyleSheet.absoluteFillObject} collapsable={false} {...panHandlers} />;
}
