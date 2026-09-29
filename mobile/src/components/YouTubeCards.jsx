// Shared YouTube cards used across Home / Search / Channel / Playlist / Library.
import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from './AppIcon';
import { fs } from '../utils/size';

export function fmtDuration(sec) {
  if (!sec || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function thumbOf(item) {
  return item.thumbnailUrl || item.thumb || item.avatar || '';
}

// Grid video card (2-up) with optional download button + progress bar.
export function VideoCard({ item, width, dlMap = {}, onPress, onDownload, showChannel = true }) {
  const { theme } = useTheme();
  const dl = dlMap[item.videoId];
  return (
    <TouchableOpacity style={[{ width }, styles.card]} activeOpacity={0.82} onPress={() => onPress && onPress(item)}>
      <View style={styles.thumbWrap}>
        {item.thumbnailUrl ? (
          <Image source={{ uri: item.thumbnailUrl }} style={styles.thumb} resizeMode="cover" />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: theme.inputBg }]}>
            <Icon name="play" size={24} color={theme.textSecondary} />
          </View>
        )}
        {item.live && (
          <View style={styles.liveBadge}>
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
        )}
        {!item.live && item.durationSeconds > 0 && (
          <View style={styles.durBadge}>
            <Text style={styles.durBadgeText}>{fmtDuration(item.durationSeconds)}</Text>
          </View>
        )}
        {onDownload && (
          <>
            <TouchableOpacity
              style={styles.dlBtn}
              onPress={() => (dl && dl.status === 'done' ? null : onDownload(item))}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {dl ? (
                <Icon name={dl.status === 'done' ? 'checkmark-circle' : 'time-outline'} size={16} color="#fff" />
              ) : (
                <Icon name="download-outline" size={16} color="#fff" />
              )}
            </TouchableOpacity>
            {dl && (dl.status === 'downloading' || dl.status === 'resolving') && (
              <View style={styles.dlBar}>
                <View style={[styles.dlBarFill, { width: `${Math.max(3, dl.progress)}%` }]} />
              </View>
            )}
          </>
        )}
      </View>
      <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={2}>{item.title}</Text>
      {showChannel && item.channelTitle ? (
        <Text style={[styles.cardChannel, { color: theme.textSecondary }]} numberOfLines={1}>{item.channelTitle}</Text>
      ) : null}
    </TouchableOpacity>
  );
}

// Horizontal row item (related, playlist, library, channel tabs).
export function ItemRow({ item, dlMap = {}, onPress, onDownload, index, trailing }) {
  const { theme } = useTheme();
  const dl = dlMap[item.videoId];
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.82} onPress={() => onPress && onPress(item)}>
      <View style={styles.rowThumbWrap}>
        {item.thumbnailUrl ? (
          <Image source={{ uri: item.thumbnailUrl }} style={styles.rowThumb} resizeMode="cover" />
        ) : (
          <View style={[styles.rowThumb, { backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center' }]}>
            <Icon name="md-play" size={20} color={theme.textSecondary} />
          </View>
        )}
        {item.live && (
          <View style={styles.liveBadge}>
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
        )}
        {!item.live && item.durationSeconds > 0 && (
          <View style={styles.rowDur}>
            <Text style={styles.rowDurText}>{fmtDuration(item.durationSeconds)}</Text>
          </View>
        )}
        {onDownload && dl && dl.status === 'done' && (
          <View style={styles.rowDone}>
            <Icon name="checkmark" size={12} color="#fff" />
          </View>
        )}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          {index != null ? <Text style={[styles.rowIndex, { color: theme.textSecondary }]}>{index}.</Text> : null}
          <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={2}>{item.title}</Text>
        </View>
        {item.channelTitle ? (
          <Text style={[styles.rowMeta, { color: theme.textSecondary }]} numberOfLines={1}>{item.channelTitle}</Text>
        ) : null}
      </View>
      {onDownload && !(dl && dl.status === 'done') && (
        <TouchableOpacity
          style={styles.rowDl}
          onPress={() => onDownload(item)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Icon name={dl && dl.status === 'downloading' ? 'time-outline' : 'download-outline'} size={18} color={theme.textSecondary} />
        </TouchableOpacity>
      )}
      {trailing}
    </TouchableOpacity>
  );
}

// Channel row (search results / subscriptions / related).
export function ChannelRow({ item, onPress }) {
  const { theme } = useTheme();
  return (
    <TouchableOpacity style={styles.channelRow} activeOpacity={0.8} onPress={() => onPress && onPress(item)}>
      {item.avatar || item.thumbnailUrl ? (
        <Image source={{ uri: item.avatar || item.thumbnailUrl }} style={styles.channelAvatar} resizeMode="cover" />
      ) : (
        <View style={[styles.channelAvatar, { backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center' }]}>
          <Icon name="person" size={22} color={theme.textSecondary} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={[styles.channelName, { color: theme.text }]} numberOfLines={1}>{item.channelTitle || item.title}</Text>
          {item.verified && <Icon name="checkmark-circle" size={14} color={theme.primary} />}
        </View>
        {item.subscribers ? <Text style={[styles.rowMeta, { color: theme.textSecondary }]} numberOfLines={1}>{item.subscribers}</Text> : null}
      </View>
      {item.videoCount ? <Text style={[styles.rowMeta, { color: theme.textSecondary }]} numberOfLines={1}>{item.videoCount}</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  thumbWrap: { width: '100%', aspectRatio: 16 / 9, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
  thumb: { width: '100%', height: '100%' },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  durBadge: { position: 'absolute', right: 6, bottom: 6, backgroundColor: 'rgba(16,11,26,0.85)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  durBadgeText: { color: '#fff', fontSize: fs(10), fontWeight: '700' },
  liveBadge: { position: 'absolute', left: 6, bottom: 6, backgroundColor: '#E53935', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  liveBadgeText: { color: '#fff', fontSize: fs(9), fontWeight: '800' },
  dlBtn: { position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(16,11,26,0.7)', alignItems: 'center', justifyContent: 'center' },
  dlBar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  dlBarFill: { height: 3, backgroundColor: '#8B5CF6' },
  cardTitle: { fontSize: fs(13), fontWeight: '600', marginTop: 6, paddingHorizontal: 2, lineHeight: 17 },
  cardChannel: { fontSize: fs(11), marginTop: 2, paddingHorizontal: 2 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 10 },
  rowThumbWrap: { width: 150, height: 84, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
  rowThumb: { width: '100%', height: '100%' },
  rowDur: { position: 'absolute', right: 4, bottom: 4, backgroundColor: 'rgba(16,11,26,0.85)', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  rowDurText: { color: '#fff', fontSize: fs(10), fontWeight: '700' },
  rowDone: { position: 'absolute', left: 4, bottom: 4, width: 18, height: 18, borderRadius: 9, backgroundColor: '#4CAF50', alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowTitleLine: { flexDirection: 'row', gap: 6 },
  rowIndex: { fontSize: fs(13), fontWeight: '700' },
  rowTitle: { flex: 1, fontSize: fs(13), fontWeight: '700', lineHeight: 17 },
  rowMeta: { fontSize: fs(11), marginTop: 2 },
  rowDl: { padding: 6 },
  channelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16, paddingHorizontal: 2 },
  channelAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#000' },
  channelName: { fontSize: fs(14), fontWeight: '700', flexShrink: 1 },
});