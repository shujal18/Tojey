import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { formatTime } from './videoConfig';
import { videoStyles } from './videoStyles';
import VideoSeekBar from './VideoSeekBar';

function LabelButton({ label, onPress, active, disabled, accessibilityLabel }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel || label}
      accessibilityRole="button"
      style={[videoStyles.labelButton, active && videoStyles.labelButtonActive, disabled && videoStyles.disabled]}
    >
      <Text style={videoStyles.labelText}>{label}</Text>
    </TouchableOpacity>
  );
}

function IconButton({ name, onPress, disabled, label, size = 19, active }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      style={[videoStyles.iconButtonSmall, active && videoStyles.labelButtonActive, disabled && videoStyles.disabled]}
    >
      <Icon name={name} size={size} color="#fff" />
    </TouchableOpacity>
  );
}

export default function VideoBottomControls({
  state,
  fullscreen = false,
  guest = false,
  watchTogether = false,
  pipOk = false,
  onSeekPreview,
  onSeekCommit,
  onToggleMute,
  onSettings,
  onFullscreen,
  onPip,
  onLock,
  onRepeat,
  onSubtitles,
}) {
  const sharedDisabled = guest;
  const duration = state.duration || 0;
  return (
    <View style={videoStyles.bottom} pointerEvents="box-none">
      <View style={videoStyles.timeRow}>
        <Text style={videoStyles.timeText}>{formatTime(state.currentTime)}</Text>
        <Text style={[videoStyles.timeText, videoStyles.timeMuted]}>
          {duration ? `-${formatTime(Math.max(0, duration - state.currentTime))} / ${formatTime(duration)}` : '--:--'}
        </Text>
      </View>
      <VideoSeekBar
        duration={duration}
        currentTime={state.currentTime}
        buffered={state.buffered}
        disabled={sharedDisabled || !duration}
        onPreview={onSeekPreview}
        onCommit={onSeekCommit}
      />
      <View style={videoStyles.controlRow}>
        <View style={videoStyles.controlGroup}>
          <IconButton
            name={state.muted ? 'volume-mute' : 'volume-high'}
            onPress={onToggleMute}
            label={state.muted ? 'Unmute video' : 'Mute video'}
          />
          {fullscreen && state.textTracks.length ? (
            <LabelButton label="CC" onPress={onSubtitles} active={state.subtitleTrack >= 0} accessibilityLabel="Toggle subtitles" />
          ) : null}
          {fullscreen ? (
            <LabelButton
              label={`${state.playbackRate}x`}
              onPress={onSettings}
              disabled={sharedDisabled}
              accessibilityLabel="Playback speed"
            />
          ) : null}
          {fullscreen ? (
            <LabelButton label={state.quality} onPress={onSettings} disabled={sharedDisabled} accessibilityLabel="Video quality" />
          ) : null}
          {fullscreen ? (
            <LabelButton label={state.resizeMode} onPress={onSettings} accessibilityLabel="Aspect ratio" />
          ) : null}
        </View>
        <View style={videoStyles.controlGroup}>
          {fullscreen ? (
            <IconButton
              name={state.repeat ? 'repeat' : 'repeat-outline'}
              onPress={onRepeat}
              disabled={watchTogether}
              label={state.repeat ? 'Repeat one off' : 'Repeat one on'}
              active={state.repeat}
            />
          ) : null}
          {pipOk ? <IconButton name="scan-outline" onPress={onPip} label="Picture in picture" /> : null}
          {fullscreen ? (
            <IconButton
              name={state.locked ? 'lock-closed' : 'lock-open'}
              onPress={onLock}
              label={state.locked ? 'Unlock controls' : 'Lock controls'}
            />
          ) : null}
          <IconButton name="settings-outline" onPress={onSettings} label="Video settings" />
          <IconButton
            name={fullscreen ? 'compress' : 'expand'}
            onPress={onFullscreen}
            label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          />
        </View>
      </View>
      {!fullscreen ? (
        <Text style={{ color: 'rgba(255,255,255,0.58)', fontSize: fs(10), textAlign: 'center', marginTop: 2 }}>
          Tap to toggle controls · Double-tap to seek · Hold for 2x
        </Text>
      ) : null}
    </View>
  );
}
