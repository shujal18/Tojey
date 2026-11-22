import React, { memo, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import { clamp, formatClock, tickHaptic, VIDEO_ACCENT } from './videoConfig';
import { fs } from '../../utils/size';

function VideoSeekBar({ duration = 0, currentTime = 0, buffered = 0, disabled = false, readOnly = false, style, onPreview, onCommit }) {
  const widthRef = useRef(1);
  const durationRef = useRef(duration);
  const currentRef = useRef(currentTime);
  const callbacksRef = useRef({ onPreview, onCommit });
  const previewRef = useRef(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [preview, setPreview] = useState(0);

  durationRef.current = duration;
  currentRef.current = currentTime;
  callbacksRef.current = { onPreview, onCommit };

  const fractionFromX = (x) => clamp((Number(x) || 0) / (widthRef.current || 1), 0, 1);

  const updatePreview = (target) => {
    previewRef.current = target;
    setPreview(target);
    if (callbacksRef.current.onPreview) {
      callbacksRef.current.onPreview({ target, delta: target - currentRef.current });
    }
  };

  const panHandlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled && !readOnly && durationRef.current > 0,
    onMoveShouldSetPanResponder: () => !disabled && !readOnly && durationRef.current > 0,
    onPanResponderGrant: (event) => {
      setScrubbing(true);
      updatePreview(fractionFromX(event.nativeEvent.locationX) * durationRef.current);
    },
    onPanResponderMove: (event) => {
      updatePreview(fractionFromX(event.nativeEvent.locationX) * durationRef.current);
    },
    onPanResponderRelease: () => {
      setScrubbing(false);
      if (callbacksRef.current.onPreview) callbacksRef.current.onPreview(null);
      if (callbacksRef.current.onCommit) {
        callbacksRef.current.onCommit(previewRef.current);
        tickHaptic();
      }
    },
    onPanResponderTerminate: () => {
      setScrubbing(false);
      if (callbacksRef.current.onPreview) callbacksRef.current.onPreview(null);
    },
  }), [disabled, readOnly]);

  const played = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  const loaded = duration > 0 ? clamp(buffered / duration, 0, 1) : 0;
  const active = scrubbing && duration > 0 ? clamp(preview / duration, 0, 1) : played;

  return (
    <View
      style={[styles.hit, style]}
      {...panHandlers}
      onLayout={(event) => {
        widthRef.current = event.nativeEvent.layout.width || 1;
      }}
      accessibilityRole="adjustable"
      accessibilityLabel="Seek video"
      accessibilityValue={{ min: 0, max: Math.round(Number(duration) || 0), now: Math.round(Number(currentTime) || 0) }}
    >
      {scrubbing ? (
        <View style={[styles.preview, { left: `${active * 100}%` }]} pointerEvents="none">
          <Text style={styles.previewText}>{formatClock(preview)}</Text>
        </View>
      ) : null}
      <View style={[styles.track, scrubbing && styles.trackDragging]}>
        <View style={[styles.buffered, { width: `${loaded * 100}%` }]} />
        <View style={[styles.played, { width: `${active * 100}%` }]} />
        {readOnly ? null : (
          <View style={[styles.knob, scrubbing && styles.knobActive, { left: `${active * 100}%` }]} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hit: { flex: 1, height: 36, justifyContent: 'center' },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.24)' },
  trackDragging: { height: 5, borderRadius: 3 },
  buffered: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  played: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 2, backgroundColor: VIDEO_ACCENT },
  knob: {
    position: 'absolute',
    top: -5,
    width: 13,
    height: 13,
    marginLeft: -6.5,
    borderRadius: 6.5,
    backgroundColor: VIDEO_ACCENT,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.92)',
    shadowColor: VIDEO_ACCENT,
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 4,
  },
  knobActive: { top: -7, width: 18, height: 18, marginLeft: -9, borderRadius: 9 },
  preview: {
    position: 'absolute',
    bottom: 30,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 9,
    backgroundColor: 'rgba(5,12,24,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  previewText: { color: '#fff', fontSize: fs(11), fontWeight: '700' },
});

export default memo(VideoSeekBar);
