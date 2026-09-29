import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { subscribe, removeDownload, clearAllDownloads, fmtSize } from '../services/downloadsStore';
import { OFFLINE_PLAYER_HTML } from './OfflinePlayerHTML';

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
        <Text style={{ color: theme.text, fontSize: fs(14), fontWeight: '700' }} numberOfLines={2}>{item.title}</Text>
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
            <View style={styles.progWrap}>
              <View style={[styles.progFill, { width: `${Math.max(3, item.progress)}%` }]} />
            </View>
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
  const webRef = useRef(null);
  const loadedRef = useRef(false);

  const load = () => {
    if (loadedRef.current || !webRef.current) return;
    loadedRef.current = true;
    const v = `file://${item.videoPath}`;
    const a = item.audioPath ? `file://${item.audioPath}` : null;
    webRef.current.injectJavaScript(
      `window.__load(${JSON.stringify(v)},${JSON.stringify(a)},${JSON.stringify(item.title)},false); true;`
    );
  };

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <View style={[styles.header, { backgroundColor: theme.background }]}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Icon name="arrow-back" size={22} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.title, { flex: 1, marginHorizontal: 8 }]} numberOfLines={1}>{item.title}</Text>
          <Icon name="checkmark-circle" size={18} color="#fff" style={{ opacity: 0 }} />
        </View>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <WebView
            ref={webRef}
            source={{ html: OFFLINE_PLAYER_HTML, baseUrl: 'file:///' }}
            style={{ flex: 1 }}
            javaScriptEnabled
            domStorageEnabled
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            onLoadEnd={load}
            onMessage={(e) => {
              try {
                console.log('[OfflinePlayer]', e.nativeEvent.data);
              } catch (err) {}
            }}
            androidLayerType="hardware"
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
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
    position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(16,11,26,0.45)',
  },
  progWrap: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  progFill: { height: 4, backgroundColor: '#8B5CF6' },
  rowDel: { padding: 6, marginLeft: 6 },
});