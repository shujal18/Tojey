import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { VIDEO_ACCENT } from './videoConfig';

export default function VideoMiniPlayer({ title, playing, onToggle, onClose, onExpand, children, progress = 0 }) {
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.card}>
        <TouchableOpacity style={styles.video} onPress={onExpand} activeOpacity={1} accessibilityLabel="Reopen video player">
          {children}
        </TouchableOpacity>
        <TouchableOpacity style={styles.info} onPress={onExpand} accessibilityLabel="Reopen video player">
          <Text style={styles.title} numberOfLines={2}>{title || 'Tojey Player'}</Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, progress * 100))}%` }]} />
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton} onPress={onToggle} accessibilityLabel={playing ? 'Pause video' : 'Play video'}>
          <Icon name={playing ? 'pause' : 'play'} size={19} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconButton} onPress={onClose} accessibilityLabel="Close mini player">
          <Icon name="close" size={19} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 8, right: 8, bottom: 70, zIndex: 45, elevation: 45 },
  card: { flexDirection: 'row', alignItems: 'center', minHeight: 64, borderRadius: 18, backgroundColor: 'rgba(8,16,29,0.96)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', overflow: 'hidden' },
  video: { width: 92, height: 62, backgroundColor: '#000' },
  info: { flex: 1, minWidth: 0, paddingHorizontal: 10, gap: 7 },
  title: { color: '#fff', fontSize: fs(12), fontWeight: '700' },
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' },
  progressFill: { height: 3, borderRadius: 2, backgroundColor: VIDEO_ACCENT },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
