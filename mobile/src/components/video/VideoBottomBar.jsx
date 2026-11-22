import React, { memo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { formatClock } from './videoConfig';
import VideoSeekBar from './VideoSeekBar';

const GRADIENT_STOPS = [0, 1, 2, 3, 4];

function QuickButton({ children, onPress, disabled = false, label, hitSlop = 8 }) {
  return (
    <TouchableOpacity
      style={[styles.quickButton, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={{ top: hitSlop, right: hitSlop, bottom: hitSlop, left: hitSlop }}
    >
      {children}
    </TouchableOpacity>
  );
}

function VideoBottomBar({
  state,
  fullscreen = false,
  guest = false,
  pipOk = false,
  previewTime = null,
  onSeekPreview,
  onSeekCommit,
  onToggleMute,
  onSettings,
  onFullscreen,
  onPip,
}) {
  const duration = state.duration || 0;
  const shownTime = previewTime != null ? previewTime : state.currentTime;

  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={styles.gradient} pointerEvents="none">
        {GRADIENT_STOPS.map((index) => (
          <View
            key={index}
            style={[
              styles.gradientLayer,
              {
                bottom: index * 26,
                height: 26,
                backgroundColor: `rgba(2, 6, 14, ${0.62 - index * 0.1})`,
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.progressRow}>
        <Text style={styles.time}>{formatClock(shownTime)}</Text>
        <VideoSeekBar
          duration={duration}
          currentTime={state.currentTime}
          buffered={state.buffered}
          disabled={guest || !duration}
          readOnly={guest}
          onPreview={onSeekPreview}
          onCommit={onSeekCommit}
        />
        {guest ? <Text style={styles.synced}>● Synced</Text> : null}
        <Text style={[styles.time, styles.duration]}>{formatClock(duration)}</Text>
      </View>

      <View style={styles.controlRow}>
        <QuickButton onPress={onToggleMute} label={state.muted ? 'Unmute video' : 'Mute video'}>
          <Icon name={state.muted ? 'volume-mute' : 'volume-high'} size={22} color="#fff" />
        </QuickButton>
        <QuickButton onPress={() => onSettings('speed')} label="Playback speed">
          <Text style={styles.speed}>{state.playbackRate}x</Text>
        </QuickButton>
        <QuickButton onPress={() => onSettings()} label="Video settings">
          <Icon name="settings-outline" size={22} color="#fff" />
        </QuickButton>
        <QuickButton onPress={onPip} disabled={!pipOk} label="Picture in picture">
          <Icon name="tv-outline" size={22} color="#fff" />
        </QuickButton>
        <QuickButton
          onPress={onFullscreen}
          label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          <Icon name={fullscreen ? 'contract' : 'expand'} size={22} color="#fff" />
        </QuickButton>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 14, paddingBottom: 12 },
  gradient: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 170, overflow: 'hidden' },
  gradientLayer: { position: 'absolute', left: 0, right: 0 },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingTop: 18,
  },
  time: {
    color: 'rgba(255,255,255,0.94)',
    fontSize: fs(11),
    fontWeight: '600',
    minWidth: 42,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  duration: { color: 'rgba(255,255,255,0.68)' },
  synced: { color: 'rgba(190,222,255,0.72)', fontSize: fs(9), fontWeight: '700' },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  quickButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speed: { color: '#fff', fontSize: fs(13), fontWeight: '700' },
  disabled: { opacity: 0.3 },
});

export default memo(VideoBottomBar);
