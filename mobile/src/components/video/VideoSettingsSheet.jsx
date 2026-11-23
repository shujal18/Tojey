import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { clamp, RESIZE_OPTIONS, SHEET_OPEN_MS, SPEED_OPTIONS, VIDEO_ACCENT } from './videoConfig';

function trackLabel(track, index) {
  if (!track) return `Track ${index + 1}`;
  return String(track.label || track.name || track.language || track.title || `Track ${index + 1}`);
}

function SettingIcon({ kind }) {
  if (kind === 'quality') {
    return <View style={styles.textIcon}><Text style={styles.textIconLabel}>HD</Text></View>;
  }
  if (kind === 'subtitles') {
    return <View style={styles.textIcon}><Text style={styles.textIconLabel}>CC</Text></View>;
  }
  const names = {
    speed: 'speedometer-outline',
    resize: 'crop-outline',
    background: 'headset-outline',
    audio: 'musical-notes-outline',
    repeat: 'repeat-outline',
    pip: 'tv-outline',
    rotation: 'options-outline',
    lock: 'lock-closed-outline',
    minimize: 'arrow-down-circle-outline',
  };
  return (
    <View style={styles.iconWrap}>
      <Icon name={names[kind] || 'options-outline'} size={18} color="rgba(232,242,255,0.9)" />
    </View>
  );
}

function SettingRow({ row, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.row, row.disabled && styles.rowDisabled]}
      onPress={onPress}
      disabled={row.disabled}
      accessibilityLabel={row.label}
      accessibilityRole="button"
    >
      <SettingIcon kind={row.icon} />
      <Text style={styles.rowLabel}>{row.label}</Text>
      <Text style={styles.rowValue}>{row.value}</Text>
      <Icon name="chevron-forward" size={16} color="rgba(220,235,255,0.42)" />
    </TouchableOpacity>
  );
}

export default function VideoSettingsSheet({
  visible,
  onClose,
  state,
  guest = false,
  watchTogether = false,
  pipSupported = false,
  orientationSupported = false,
  initialPage = 'root',
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
  onLock,
  onMinimize,
}) {
  const [mounted, setMounted] = useState(visible);
  const [page, setPage] = useState('root');
  const [displayPage, setDisplayPage] = useState('root');
  const slide = useRef(new Animated.Value(0)).current;
  const backdrop = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(1)).current;
  const contentX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (visible) setPage(initialPage || 'root');
  }, [visible, initialPage]);

  useEffect(() => {
    if (!mounted) return undefined;
    const show = visible;
    const animation = Animated.parallel([
      Animated.timing(slide, {
        toValue: show ? 1 : 0,
        duration: show ? SHEET_OPEN_MS : 190,
        useNativeDriver: true,
      }),
      Animated.timing(backdrop, {
        toValue: show ? 1 : 0,
        duration: show ? 200 : 160,
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      if (!show && finished) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, mounted, slide, backdrop]);

  useEffect(() => {
    if (page === displayPage) return undefined;
    let alive = true;
    const out = Animated.timing(contentOpacity, {
      toValue: 0,
      duration: 80,
      useNativeDriver: true,
    });
    out.start(({ finished }) => {
      if (!alive || !finished) return;
      setDisplayPage(page);
      contentX.setValue(12);
      Animated.parallel([
        Animated.timing(contentOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.timing(contentX, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    });
    return () => { alive = false; out.stop(); };
  }, [page, displayPage, contentOpacity, contentX]);

  const rows = useMemo(() => {
    const list = [
      {
        key: 'quality',
        icon: 'quality',
        label: 'Quality',
        value: state.quality || 'Auto',
        disabled: guest,
        options: qualities.map((q) => ({ label: q, value: q })),
        onSelect: onQuality,
      },
      {
        key: 'speed',
        icon: 'speed',
        label: 'Playback speed',
        value: `${state.playbackRate}x`,
        disabled: guest,
        options: SPEED_OPTIONS.map((v) => ({ label: `${v}x`, value: v })),
        onSelect: onSpeed,
      },
      ...(state.textTracks.length > 0 ? [{
        key: 'subtitles',
        icon: 'subtitles',
        label: 'Subtitles',
        value: state.subtitleTrack >= 0
          ? trackLabel(state.textTracks[state.subtitleTrack], state.subtitleTrack)
          : 'Off',
        options: [
          { label: 'Off', value: -1 },
          ...state.textTracks.map((track, index) => ({ label: trackLabel(track, index), value: index })),
        ],
        onSelect: onSubtitle,
      }] : []),
      {
        key: 'resize',
        icon: 'resize',
        label: 'Aspect ratio',
        value: state.resizeMode || 'Fit',
        options: RESIZE_OPTIONS.map((v) => ({ label: v, value: v })),
        onSelect: onResize,
      },
      {
        key: 'background',
        icon: 'background',
        label: 'Background playback',
        value: state.backgroundPlayback ? 'On' : 'Off',
        disabled: watchTogether,
        options: [
          { label: 'Off', value: false },
          { label: 'On', value: true },
        ],
        onSelect: onBackground,
      },
    ];

    if (state.audioTracks.length > 1) {
      list.push({
        key: 'audio',
        icon: 'audio',
        label: 'Audio track',
        value: trackLabel(state.audioTracks[state.audioTrack], state.audioTrack),
        options: state.audioTracks.map((track, index) => ({ label: trackLabel(track, index), value: index })),
        onSelect: onAudio,
      });
    }
    list.push({
      key: 'repeat',
      icon: 'repeat',
      label: 'Repeat',
      value: state.repeat ? 'One' : 'Off',
      disabled: guest || watchTogether,
      options: [
        { label: 'Off', value: false },
        { label: 'One', value: true },
      ],
      onSelect: onRepeat,
    });
    if (pipSupported) {
      list.push({
        key: 'pip',
        icon: 'pip',
        label: 'Auto Picture-in-Picture',
        value: state.autoPip ? 'On' : 'Off',
        options: [
          { label: 'Off', value: false },
          { label: 'On', value: true },
        ],
        onSelect: onAutoPip,
      });
    }
    if (orientationSupported) {
      list.push({
        key: 'rotation',
        icon: 'rotation',
        label: 'Rotation lock',
        value: state.rotationLock ? 'On' : 'Off',
        options: [
          { label: 'Off', value: false },
          { label: 'On', value: true },
        ],
        onSelect: onRotationLock,
      });
    }
    if (!guest && onLock) {
      list.push({
        key: 'lock',
        icon: 'lock',
        label: 'Lock controls',
        value: state.locked ? 'On' : 'Off',
        options: [
          { label: 'Off', value: false },
          { label: 'On', value: true },
        ],
        onSelect: (value) => {
          if (value && onLock) onLock();
          if (onClose) onClose();
        },
      });
    }
    if (onMinimize) {
      list.push({
        key: 'minimize',
        icon: 'minimize',
        label: 'Minimize player',
        value: '',
        options: [],
        onSelect: () => {
          if (onMinimize) onMinimize();
          if (onClose) onClose();
        },
      });
    }
    return list;
  }, [
    guest,
    onAudio,
    onAutoPip,
    onBackground,
    onClose,
    onLock,
    onMinimize,
    onQuality,
    onRepeat,
    onResize,
    onRotationLock,
    onSpeed,
    onSubtitle,
    orientationSupported,
    pipSupported,
    qualities,
    state,
    watchTogether,
  ]);

  const activeRow = rows.find((row) => row.key === displayPage);
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

  const sheetTranslate = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [420, 0],
  });

  const sheetPanHandlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => visible && mounted,
    onMoveShouldSetPanResponder: (event, gesture) => visible && mounted && gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponderCapture: () => false,
    onPanResponderGrant: () => {},
    onPanResponderMove: (event, gesture) => {
      slide.setValue(clamp(1 - gesture.dy / 420, 0, 1));
    },
    onPanResponderRelease: (event, gesture) => {
      if (gesture.dy > 70 || gesture.vy > 0.5) {
        if (onClose) onClose();
        return;
      }
      Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      Animated.timing(slide, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    },
  }), [mounted, onClose, slide, visible]);

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.backdrop, { opacity: backdrop }]}>
          <TouchableOpacity style={styles.backdropTouch} activeOpacity={1} onPress={onClose} accessibilityLabel="Close settings" />
        </Animated.View>
        <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetTranslate }] }]}>
          <View style={styles.handleHit} collapsable={false} {...sheetPanHandlers}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <TouchableOpacity
              onPress={() => (displayPage === 'root' ? onClose() : setPage('root'))}
              accessibilityLabel={displayPage === 'root' ? 'Close settings' : 'Back to settings'}
              hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
            >
              <Icon name={displayPage === 'root' ? 'close' : 'chevron-back'} size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>{activeRow ? activeRow.label : 'Player settings'}</Text>
            <View style={styles.headerSpacer} />
          </View>

          <Animated.View style={[styles.pageContent, { opacity: contentOpacity, transform: [{ translateX: contentX }] }]}>
            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {activeRow ? (
              <>
                {activeRow.options.map((option) => {
                  const selected = option.value === currentValue;
                  return (
                    <TouchableOpacity
                      key={String(option.value)}
                      style={[
                        styles.option,
                        selected && styles.optionSelected,
                        activeRow.disabled && styles.optionDisabled,
                      ]}
                      disabled={activeRow.disabled}
                      onPress={() => {
                        if (activeRow.onSelect) activeRow.onSelect(option.value);
                        setPage('root');
                      }}
                      accessibilityLabel={String(option.label)}
                      accessibilityRole="menuitem"
                    >
                      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option.label}</Text>
                      {selected ? <Icon name="checkmark-circle-outline" size={19} color={VIDEO_ACCENT} /> : null}
                    </TouchableOpacity>
                  );
                })}
                {activeRow.disabled ? (
                  <Text style={styles.note}>The host controls this setting during Watch Together.</Text>
                ) : null}
              </>
            ) : (
              <>
                {rows.slice(0, 5).map((row) => (
                  <SettingRow
                    key={row.key}
                    row={row}
                    onPress={() => !row.disabled && setPage(row.key)}
                  />
                ))}
                {rows.length > 5 ? <Text style={styles.section}>More</Text> : null}
                {rows.slice(5).map((row) => (
                  <SettingRow
                    key={row.key}
                    row={row}
                    onPress={() => {
                      if (row.key === 'minimize' && row.onSelect) row.onSelect();
                      else if (!row.disabled) setPage(row.key);
                    }}
                  />
                ))}
                {guest ? (
                  <Text style={styles.note}>
                    The host controls shared playback and speed. Your volume, brightness, PiP, fullscreen and display settings stay local.
                  </Text>
                ) : null}
              </>
            )}
            </ScrollView>
          </Animated.View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(1, 5, 12, 0.68)' },
  backdropTouch: { flex: 1 },
  sheet: {
    maxHeight: '82%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: 'rgba(8, 16, 29, 0.96)',
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingBottom: 18,
  },
  handleHit: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.24)',
    marginTop: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { flex: 1, marginLeft: 12, color: '#fff', fontSize: fs(15), fontWeight: '700' },
  headerSpacer: { width: 22 },
  pageContent: { flexShrink: 1 },
  list: { paddingHorizontal: 14 },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  rowDisabled: { opacity: 0.42 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(120, 180, 255, 0.10)',
  },
  textIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(120, 180, 255, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(140,195,255,0.22)',
  },
  textIconLabel: { color: '#DCEEFF', fontSize: fs(10), fontWeight: '800' },
  rowLabel: { flex: 1, color: '#fff', fontSize: fs(13), fontWeight: '600' },
  rowValue: { color: 'rgba(220,236,255,0.58)', fontSize: fs(12), fontWeight: '600', marginRight: 6 },
  section: {
    color: 'rgba(220,236,255,0.42)',
    fontSize: fs(10),
    fontWeight: '800',
    letterSpacing: 0.6,
    paddingHorizontal: 10,
    paddingTop: 18,
    paddingBottom: 6,
  },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderRadius: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  optionSelected: { backgroundColor: 'rgba(61,155,255,0.12)' },
  optionDisabled: { opacity: 0.42 },
  optionText: { color: '#fff', fontSize: fs(13), fontWeight: '600' },
  optionTextSelected: { color: VIDEO_ACCENT, fontWeight: '800' },
  note: {
    color: 'rgba(220,236,255,0.52)',
    fontSize: fs(11),
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingTop: 16,
  },
});
