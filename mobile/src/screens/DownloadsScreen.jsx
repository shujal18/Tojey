import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import Video from 'react-native-video';
import TojeyVideoPlayer from '../components/video/TojeyVideoPlayer';
import { useVideoSession } from '../services/VideoSessionContext';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { subscribe, removeDownload, clearAllDownloads, fmtSize } from '../services/downloadsStore';

export default function DownloadsScreen({ onBack }) {
  const { theme } = useTheme();
  const [items, setItems] = useState([]);
  const [play, setPlay] = useState(null);

  useEffect(() => {
    return subscribe(setItems);
  }, []);

  const done = items.filter((d) => d.status === 'done');

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <TouchableOpacity onPress={onBack} style={styles.headerBtn}>
          <Icon name="arrow-back" size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Downloads</Text>
        {done.length > 0 && (
          <TouchableOpacity onPress={() => clearAllDownloads()} style={[styles.headerBtn, { marginLeft: 'auto' }]}>
            <Icon name="trash-outline" size={20} color={theme.danger} />
          </TouchableOpacity>
        )}
      </View>

      {items.length === 0 ? (
        <View style={styles.center}>
          <View style={[styles.emptyBadge, { backgroundColor: theme.primaryLight }]}>
            <Icon name="download-outline" size={42} color={theme.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>No downloads yet</Text>
          <Text style={[styles.emptySub, { color: theme.textSecondary }]}>
            Open a video in Home and tap the download button to save it for offline watching.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
          renderItem={({ item }) => <DownloadRow item={item} theme={theme} onPlay={() => setPlay(item)} onDelete={() => removeDownload(item.id)} />}
        />
      )}

      {!!play && play.status === 'done' && (
        <OfflinePlayer item={play} theme={theme} onClose={() => setPlay(null)} />
      )}
    </View>
  );
}

function DownloadRow({ item, theme, onPlay, onDelete }) {
  const active = item.status === 'downloading' || item.status === 'resolving';
  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: theme.card, borderColor: theme.border }]}
      activeOpacity={0.8}
      onPress={onPlay}
      disabled={item.status !== 'done'}
    >
      <View style={styles.thumbWrap}>
        <Image source={{ uri: item.thumb }} style={styles.thumb} resizeMode="cover" />
        {item.status !== 'done' && (
          <View style={styles.thumbOverlay}>
            {item.status === 'error' ? (
              <Icon name="alert-circle" size={18} color={theme.danger} />
            ) : active ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : null}
          </View>
        )}
      </View>
      <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {item.kind === 'audio' && (
              <Icon name="headset-outline" size={13} color={theme.primary} style={{ marginRight: 6 }} />
            )}
            <Text style={{ color: theme.text, fontSize: fs(14), fontWeight: '700', flex: 1 }} numberOfLines={2}>{item.title}</Text>
          </View>
          <Text style={{ color: theme.textSecondary, fontSize: fs(12), marginTop: 3 }} numberOfLines={1}>
            {item.channel || 'YouTube'}
          </Text>
          <View style={{ marginTop: 6 }}>
            {item.status === 'done' ? (
              <Text style={{ color: theme.online, fontSize: fs(11), fontWeight: '700' }}>
                ✓ Downloaded{fmtSize(item.size) ? `  ·  ${fmtSize(item.size)}` : ''}
              </Text>
            ) : item.status === 'error' ? (
              <Text style={{ color: theme.danger, fontSize: fs(11) }} numberOfLines={1}>{item.error || 'Download failed'}</Text>
            ) : (
              <>
                <View style={styles.progWrap}>
                  <View style={[styles.progFill, { width: `${Math.max(3, item.progress)}%` }]} />
                </View>
                {item.bytesTotal > 0 && (
                  <Text style={{ color: theme.textSecondary, fontSize: fs(10), marginTop: 3 }}>
                    {fmtSize(item.bytesDone)} / {fmtSize(item.bytesTotal)}
                  </Text>
                )}
              </>
            )}
          </View>
        </View>
      <TouchableOpacity onPress={onDelete} style={styles.rowDel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Icon name="trash-outline" size={17} color={theme.textSecondary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function OfflinePlayer({ item, theme, onClose }) {
  const videoSession = useVideoSession();
  const audioRef = useRef(null);
  const playingRef = useRef(true);
  const audioTimeRef = useRef(0);
  const suppressSeekRef = useRef(0);
  const [audioPaused, setAudioPaused] = useState(false);
  const [audioRate, setAudioRate] = useState(1);
  const [audioError, setAudioError] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const toUri = (path) => {
    if (!path) return '';
    if (/^(file:|content:|http:|https:)/i.test(path)) return path;
    return `file://${path}`;
  };
  const hasVideo = !!item.videoPath;
  const sourceUri = hasVideo ? toUri(item.videoPath) : toUri(item.audioPath);
  const audioUri = hasVideo && item.audioPath ? toUri(item.audioPath) : null;

  const retry = () => {
    setAudioError(false);
    setAudioPaused(true);
    setEpoch((value) => value + 1);
  };

  const handleMinimize = () => {
    if (audioUri) return;
    videoSession.openSession({
      source: { uri: sourceUri },
      title: item.title,
      availableQualities: ['Auto'],
      onRetry: retry,
    });
    onClose();
  };

  const syncAudioTime = (current) => {
    if (!audioRef.current || audioPaused || Date.now() < suppressSeekRef.current) return;
    if (Math.abs(audioTimeRef.current - current) > 0.8) {
      suppressSeekRef.current = Date.now() + 600;
      audioTimeRef.current = current;
      audioRef.current.seek(current);
    }
  };

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.offlineRoot}>
        <TojeyVideoPlayer
          key={`${sourceUri}-${epoch}`}
          source={{ uri: sourceUri }}
          title={item.title}
          style={styles.offlineVideo}
          initialRepeat
          availableQualities={['Auto']}
          statusLabel={audioError ? 'Audio track unavailable' : undefined}
          onPlayChange={(next) => {
            playingRef.current = !!next;
            setAudioPaused(!next);
          }}
          onSeek={(target) => {
            const value = Math.max(0, Number(target) || 0);
            audioTimeRef.current = value;
            suppressSeekRef.current = Date.now() + 600;
            if (audioRef.current) audioRef.current.seek(value);
          }}
          onRateChange={(rate) => {
            const value = Number(rate) || 1;
            setAudioRate(value);
          }}
          onTimeUpdate={(payload) => syncAudioTime(Number(payload && payload.currentTime) || 0)}
          onError={(detail) => { if (audioUri) setAudioError(true); }}
          onRetry={retry}
          onMinimize={audioUri ? undefined : handleMinimize}
          onBack={onClose}
        />
        {audioUri ? (
          <View pointerEvents="none" style={styles.hiddenAudio}>
            <Video
              key={`${audioUri}-${epoch}`}
              ref={audioRef}
              source={{ uri: audioUri }}
              paused={audioPaused}
              rate={audioRate}
              repeat
              playInBackground
              ignoreSilentSwitch="ignore"
              onProgress={(payload) => {
                const t = Number(payload && payload.currentTime) || 0;
                if (t > 0) audioTimeRef.current = t;
              }}
              onError={() => setAudioError(true)}
            />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  offlineRoot: { flex: 1, backgroundColor: '#000' },
  offlineVideo: { flex: 1 },
  hiddenAudio: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  title: { fontSize: fs(18), fontWeight: '800' },
  headerBtn: { padding: 6 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyBadge: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fs(17), fontWeight: '800', marginTop: 16 },
  emptySub: { fontSize: fs(13), textAlign: 'center', marginTop: 8, lineHeight: 19 },
  row: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, padding: 10, marginBottom: 10,
  },
  thumbWrap: { width: 108, height: 61, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
  thumb: { width: '100%', height: '100%' },
  thumbOverlay: {
    position: 'absolute', top: 0, right: 0, bottom: 0, left: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(16,11,26,0.45)',
  },
  progWrap: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  progFill: { height: 4, backgroundColor: '#8B5CF6' },
  rowDel: { padding: 6, marginLeft: 6 },
});