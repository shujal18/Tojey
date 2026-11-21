import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { clamp, formatTime, VIDEO_ACCENT } from './videoConfig';
import { fs } from '../../utils/size';

export default function VideoSeekBar({ duration = 0, currentTime = 0, buffered = 0, disabled = false, onPreview, onCommit }) {
  const widthRef = useRef(1);
  const xRef = useRef(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [preview, setPreview] = useState(0);

  const fractionFromX = (x) => clamp((Number(x) || 0) / (widthRef.current || 1), 0, 1);

  const panHandlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled && duration > 0,
    onMoveShouldSetPanResponder: () => !disabled && duration > 0,
    onPanResponderGrant: (event) => {
      const target = fractionFromX(event.nativeEvent.locationX) * duration;
      setScrubbing(true);
      setPreview(target);
      if (onPreview) onPreview({ target, delta: target - currentTime });
    },
    onPanResponderMove: (event, gesture) => {
      const target = fractionFromX(event.nativeEvent.locationX) * duration;
      setPreview(target);
      if (onPreview) onPreview({ target, delta: target - currentTime });
      if (!gesture) return;
    },
    onPanResponderRelease: () => {
      if (!scrubbing) return;
      setScrubbing(false);
      if (onPreview) onPreview(null);
      if (onCommit) onCommit(preview);
    },
    onPanResponderTerminate: () => {
      setScrubbing(false);
      if (onPreview) onPreview(null);
    },
  }), [currentTime, disabled, duration, onCommit, onPreview, scrubbing, preview]);

  const played = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  const loaded = duration > 0 ? clamp(buffered / duration, 0, 1) : 0;
  const active = scrubbing && duration > 0 ? clamp(preview / duration, 0, 1) : played;

  return (
    <View
      style={styles.hit}
      {...panHandlers}
      onLayout={(event) => {
        widthRef.current = event.nativeEvent.layout.width || 1;
        xRef.current = event.nativeEvent.layout.x || 0;
      }}
      accessibilityRole="adjustable"
      accessibilityLabel="Seek video"
      accessibilityValue={{ min: 0, max: Math.round(Number(duration) || 0), now: Math.round(Number(currentTime) || 0) }}
    >
      {scrubbing ? (
        <View style={[styles.preview, { left: `${active * 100}%` }]} pointerEvents="none">
          <Text style={styles.previewText}>{formatTime(preview)}</Text>
        </View>
      ) : null}
      <View style={styles.track}>
        <View style={[styles.buffered, { width: `${loaded * 100}%` }]} />
        <View style={[styles.played, { width: `${active * 100}%` }]} />
        <View style={[styles.knob, { left: `${active * 100}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hit: {
    height: 36,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.24)',
  },
  buffered: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.34)',
  },
  played: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: VIDEO_ACCENT,
  },
  knob: {
    position: 'absolute',
    top: -5,
    width: 14,
    height: 14,
    marginLeft: -7,
    borderRadius: 7,
    backgroundColor: '#fff',
  },
  preview: {
    position: 'absolute',
    bottom: 30,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(8,5,14,0.88)',
  },
  previewText: {
    color: '#fff',
    fontSize: fs(11),
    fontWeight: '800',
  },
});
