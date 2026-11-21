import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { SPEED_OPTIONS, RESIZE_OPTIONS, VIDEO_ACCENT } from './videoConfig';

function trackLabel(track, index) {
  if (!track) return `Track ${index + 1}`;
  return String(track.label || track.name || track.language || track.title || `Track ${index + 1}`);
}

export default function VideoSettingsSheet({
  visible,
  onClose,
  state,
  guest = false,
  watchTogether = false,
  pipSupported = false,
  orientationSupported = false,
  qualities = ['Auto'],
  onSpeed,
  onQuality,
  onSubtitle,
  onAudio,
  onResize,
  onRepeat,
  onBackground,
  onAutoPip,
  onRotationLock,
  onMute,
  onVolume,
}) {
  const [page, setPage] = useState('root');
  useEffect(() => { if (!visible) setPage('root'); }, [visible]);

  const rows = [
    { key: 'speed', label: 'Playback speed', value: `${state.playbackRate}x`, disabled: guest, options: SPEED_OPTIONS.map((v) => ({ label: `${v}x`, value: v })), onSelect: onSpeed },
    { key: 'quality', label: 'Quality', value: state.quality, disabled: guest, options: qualities.map((q) => ({ label: q, value: q })), onSelect: onQuality },
    { key: 'resize', label: 'Aspect ratio', value: state.resizeMode, options: RESIZE_OPTIONS.map((v) => ({ label: v, value: v })), onSelect: onResize },
  ];
  if (state.textTracks.length) {
    rows.push({
      key: 'subtitles',
      label: 'Subtitles',
      value: state.subtitleTrack >= 0 ? trackLabel(state.textTracks[state.subtitleTrack], state.subtitleTrack) : 'Off',
      options: [{ label: 'Off', value: -1 }, ...state.textTracks.map((track, index) => ({ label: trackLabel(track, index), value: index }))],
      onSelect: onSubtitle,
    });
  }
  if (state.audioTracks.length > 1) {
    rows.push({
      key: 'audio',
      label: 'Audio track',
      value: trackLabel(state.audioTracks[state.audioTrack], state.audioTrack),
      options: state.audioTracks.map((track, index) => ({ label: trackLabel(track, index), value: index })),
      onSelect: onAudio,
    });
  }
  rows.push({ key: 'repeat', label: 'Repeat', value: state.repeat ? 'One' : 'Off', disabled: watchTogether, options: [{ label: 'Off', value: false }, { label: 'One', value: true }], onSelect: onRepeat });
  rows.push({ key: 'background', label: 'Background playback', value: state.backgroundPlayback ? 'Audio only' : 'Off', disabled: watchTogether, options: [{ label: 'Off', value: false }, { label: 'Audio only', value: true }], onSelect: onBackground });
  if (pipSupported) rows.push({ key: 'pip', label: 'Auto Picture-in-Picture', value: state.autoPip ? 'On' : 'Off', options: [{ label: 'Off', value: false }, { label: 'On', value: true }], onSelect: onAutoPip });
  if (orientationSupported) rows.push({ key: 'rotation', label: 'Rotation lock', value: state.rotationLock ? 'On' : 'Off', options: [{ label: 'Off', value: false }, { label: 'On', value: true }], onSelect: onRotationLock });

  const activeRow = rows.find((row) => row.key === page);
  const currentValue = activeRow
    ? activeRow.key === 'speed' ? state.playbackRate
      : activeRow.key === 'quality' ? state.quality
        : activeRow.key === 'resize' ? state.resizeMode
          : activeRow.key === 'subtitles' ? state.subtitleTrack
            : activeRow.key === 'audio' ? state.audioTrack
              : activeRow.key === 'repeat' ? state.repeat
                : activeRow.key === 'background' ? state.backgroundPlayback
                  : activeRow.key === 'pip' ? state.autoPip
                    : state.rotationLock
    : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.sheet} onStartShouldSetResponder={() => true}>
          <View style={styles.head}>
            <TouchableOpacity onPress={() => (page === 'root' ? onClose() : setPage('root'))} accessibilityLabel={page === 'root' ? 'Close settings' : 'Back to settings'}>
              <Icon name={page === 'root' ? 'close' : 'chevron-back'} size={21} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.title}>{activeRow ? activeRow.label : 'Player settings'}</Text>
            <View style={{ width: 24 }} />
          </View>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {activeRow ? (
              activeRow.options.map((option) => {
                const selected = option.value === currentValue;
                return (
                  <TouchableOpacity
                    key={String(option.value)}
                    style={[styles.option, selected && styles.optionSelected]}
                    onPress={() => {
                      if (activeRow.onSelect) activeRow.onSelect(option.value);
                      setPage('root');
                    }}
                    accessibilityLabel={String(option.label)}
                  >
                    <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option.label}</Text>
                    {selected ? <Icon name="checkmark" size={17} color={VIDEO_ACCENT} /> : null}
                  </TouchableOpacity>
                );
              })
            ) : (
              <>
                {rows.map((row) => (
                  <TouchableOpacity
                    key={row.key}
                    style={[styles.row, row.disabled && styles.disabled]}
                    onPress={() => !row.disabled && setPage(row.key)}
                    disabled={row.disabled}
                    accessibilityLabel={row.label}
                  >
                    <Text style={styles.rowLabel}>{row.label}</Text>
                    <Text style={styles.rowValue}>{row.value}</Text>
                    <Icon name="chevron-forward" size={16} color="rgba(255,255,255,0.5)" />
                  </TouchableOpacity>
                ))}
                <View style={styles.localBlock}>
                  <Text style={styles.section}>Local audio</Text>
                  <View style={styles.localRow}>
                    <TouchableOpacity style={styles.smallButton} onPress={onMute} accessibilityLabel={state.muted ? 'Unmute video' : 'Mute video'}>
                      <Icon name={state.muted ? 'volume-mute' : 'volume-high'} size={18} color="#fff" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.smallButton} onPress={() => onVolume(state.volume - 0.1)} accessibilityLabel="Decrease volume">
                      <Text style={styles.smallText}>-</Text>
                    </TouchableOpacity>
                    <Text style={styles.volumeText}>{Math.round(state.volume * 100)}%</Text>
                    <TouchableOpacity style={styles.smallButton} onPress={() => onVolume(state.volume + 0.1)} accessibilityLabel="Increase volume">
                      <Text style={styles.smallText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                {guest ? <Text style={styles.note}>The host controls shared playback and speed. Your audio, brightness, zoom and fullscreen stay local.</Text> : null}
              </>
            )}
          </ScrollView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.58)' },
  sheet: { maxHeight: '78%', borderTopLeftRadius: 22, borderTopRightRadius: 22, backgroundColor: '#171020', paddingBottom: 18 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  title: { color: '#fff', fontSize: fs(15), fontWeight: '800' },
  list: { paddingHorizontal: 12 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 12 },
  rowLabel: { flex: 1, color: '#fff', fontSize: fs(13), fontWeight: '600' },
  rowValue: { color: 'rgba(255,255,255,0.62)', fontSize: fs(12), fontWeight: '700' },
  disabled: { opacity: 0.4 },
  option: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderRadius: 12 },
  optionSelected: { backgroundColor: 'rgba(139,92,246,0.18)' },
  optionText: { color: '#fff', fontSize: fs(13), fontWeight: '600' },
  optionTextSelected: { color: VIDEO_ACCENT, fontWeight: '800' },
  section: { color: 'rgba(255,255,255,0.55)', fontSize: fs(11), fontWeight: '800', marginBottom: 8 },
  localBlock: { marginTop: 12, paddingHorizontal: 8 },
  localRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  smallButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.10)', alignItems: 'center', justifyContent: 'center' },
  smallText: { color: '#fff', fontSize: fs(20), fontWeight: '700' },
  volumeText: { width: 48, textAlign: 'center', color: '#fff', fontSize: fs(12), fontWeight: '700' },
  note: { color: 'rgba(255,255,255,0.55)', fontSize: fs(11), lineHeight: 16, paddingHorizontal: 10, paddingTop: 14 },
});
