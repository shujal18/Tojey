// Library: watch History, Subscriptions, Saved videos and custom Playlists
// (LocalTube-style, stored locally via AsyncStorage).
import React, { useEffect, useState } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, Modal,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { ItemRow, ChannelRow } from '../components/YouTubeCards';
import {
  initLibrary, subscribeLibrary, storeSnapshot, clearHistory,
  createPlaylist, deletePlaylist, playlistItems,
} from '../services/library';

const TABS = [
  { id: 'history', label: 'History' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'saved', label: 'Saved' },
  { id: 'playlists', label: 'Playlists' },
];

export default function YoutubeLibraryScreen({ token, onBack, onPlay, onOpenChannel, onOpenPlaylist, dlMap, onDownload }) {
  const { theme } = useTheme();
  const [tab, setTab] = useState('history');
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    let active = true;
    initLibrary().then(() => {
      if (!active) return;
      setSnap(storeSnapshot());
      setLoading(false);
    });
    const unsub = subscribeLibrary(() => setSnap(storeSnapshot()));
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const openPl = (plName) => {
    const db = snap?.playlists[plName] || [];
    onOpenPlaylist && onOpenPlaylist({
      playlistId: `local:${plName}`,
      title: plName,
      local: true,
      count: db.length,
      videos: db,
    });
  };

  const doCreate = async () => {
    const ok = await createPlaylist(name);
    setName('');
    setCreating(false);
  };

  const renderBlank = (msg) => (
    <View style={styles.blank}>
      <Text style={{ color: theme.textSecondary, fontSize: fs(13), textAlign: 'center' }}>{msg}</Text>
    </View>
  );

  const body = () => {
    if (loading) return <ActivityIndicator color={theme.primary} style={{ marginTop: 40 }} />;
    const s = snap || { history: [], subs: [], bookmarks: [], playlists: {} };
    if (tab === 'history') {
      if (!s.history.length) return renderBlank('Videos you watch will appear here.');
      return (
        <FlatList
          data={s.history}
          keyExtractor={(v) => v.videoId}
          contentContainerStyle={styles.listPad}
          renderItem={({ item }) => <ItemRow item={item} dlMap={dlMap} onPress={onPlay} onDownload={onDownload} />}
          ListHeaderComponent={
            <View style={styles.listHeader}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Watch history</Text>
              <TouchableOpacity onPress={() => clearHistory()}>
                <Text style={{ color: theme.danger, fontSize: fs(12), fontWeight: '700' }}>Clear</Text>
              </TouchableOpacity>
            </View>
          }
        />
      );
    }
    if (tab === 'subscriptions') {
      if (!s.subs.length) return renderBlank('Subscribe to channels to see them here.');
      return (
        <FlatList
          data={s.subs}
          keyExtractor={(c) => c.channelId}
          contentContainerStyle={styles.listPad}
          renderItem={({ item }) => <ChannelRow item={{ ...item, avatar: item.avatar, subscribers: '' }} onPress={onOpenChannel} />}
        />
      );
    }
    if (tab === 'saved') {
      if (!s.bookmarks.length) return renderBlank('Tap the bookmark icon on a video to save it.');
      return (
        <FlatList
          data={s.bookmarks}
          keyExtractor={(v) => v.videoId}
          contentContainerStyle={styles.listPad}
          renderItem={({ item }) => <ItemRow item={item} dlMap={dlMap} onPress={onPlay} onDownload={onDownload} />}
        />
      );
    }
    // playlists
    const names = Object.keys(s.playlists || {});
    if (!names.length) return renderBlank('Create a playlist to organize videos.');
    return (
      <FlatList
        data={names}
        keyExtractor={(n) => n}
        contentContainerStyle={styles.listPad}
        renderItem={({ item: plName }) => {
          const vids = playlistItems(plName);
          const thumb = vids[0];
          return (
            <TouchableOpacity style={styles.plRow} activeOpacity={0.8} onPress={() => openPl(plName)}>
              {thumb?.thumbnailUrl ? (
                <Image source={{ uri: thumb.thumbnailUrl }} style={styles.plThumb} resizeMode="cover" />
              ) : (
                <View style={[styles.plThumb, { backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center' }]}>
                  <Icon name="list" size={20} color={theme.textSecondary} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={[styles.plName, { color: theme.text }]} numberOfLines={1}>{plName}</Text>
                <Text style={[styles.plMeta, { color: theme.textSecondary }]}>{vids.length} video{vids.length === 1 ? '' : 's'}</Text>
              </View>
              <TouchableOpacity onPress={() => deletePlaylist(plName)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Icon name="trash-outline" size={18} color={theme.danger} />
              </TouchableOpacity>
            </TouchableOpacity>
          );
        }}
      />
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="arrow-back" size={23} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Library</Text>
        <TouchableOpacity
          style={styles.addBtn}
          onPress={() => setCreating(true)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Icon name="add" size={26} color={theme.primary} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabsRow}>
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <TouchableOpacity key={t.id} style={styles.tabBtn} onPress={() => setTab(t.id)}>
              <Text style={[styles.tabLabel, { color: active ? theme.primary : theme.textSecondary }]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {body()}

      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.overlay}>
          <View style={[styles.modal, { backgroundColor: theme.card }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>New playlist</Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: theme.inputBg, color: theme.text }]}
              placeholder="Playlist name"
              placeholderTextColor={theme.textSecondary}
              value={name}
              onChangeText={setName}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={doCreate}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.modalBtn} onPress={() => setCreating(false)}>
                <Text style={{ color: theme.textSecondary, fontWeight: '700' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalBtn, styles.modalBtnPrimary, { backgroundColor: theme.primary }]} onPress={doCreate} disabled={!name.trim()}>
                <Text style={{ color: '#fff', fontWeight: '800' }}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 10, paddingBottom: 8, gap: 6 },
  backBtn: { padding: 6 },
  headerTitle: { fontSize: fs(17), fontWeight: '800', flex: 1 },
  addBtn: { padding: 6 },
  tabsRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 20, marginBottom: 6 },
  tabBtn: { paddingBottom: 8 },
  tabLabel: { fontSize: fs(14), fontWeight: '700' },
  listPad: { paddingHorizontal: 16, paddingBottom: 20 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6, paddingBottom: 12 },
  sectionTitle: { fontSize: fs(15), fontWeight: '800' },
  blank: { paddingHorizontal: 40, paddingTop: 60, alignItems: 'center' },
  plRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  plThumb: { width: 84, height: 52, borderRadius: 8, backgroundColor: '#000' },
  plName: { fontSize: fs(14), fontWeight: '700' },
  plMeta: { fontSize: fs(11), marginTop: 2 },
  overlay: { flex: 1, backgroundColor: 'rgba(16,11,26,0.6)', alignItems: 'center', justifyContent: 'center' },
  modal: { width: '86%', borderRadius: 16, padding: 18 },
  modalTitle: { fontSize: fs(16), fontWeight: '800', marginBottom: 12 },
  modalInput: { borderRadius: 10, paddingHorizontal: 12, height: 44, fontSize: fs(14) },
  modalBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 18 },
  modalBtnPrimary: { paddingHorizontal: 20 },
});