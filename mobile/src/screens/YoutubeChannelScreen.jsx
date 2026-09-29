// Channel page: banner/avatar header, subscribe toggle, tabs
// (Videos / Shorts / Playlists), paginated grid.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, Dimensions,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { VideoCard, ItemRow } from '../components/YouTubeCards';
import makeYoutubeApi from '../services/youtubeApi';
import { isSubscribed, toggleSubscribe } from '../services/library';

const TABS = [
  { id: 'videos', label: 'Videos' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'playlists', label: 'Playlists' },
];

export default function YoutubeChannelScreen({ token, channelId, onBack, onPlay, onOpenPlaylist, dlMap, onDownload }) {
  const { theme } = useTheme();
  const api = makeYoutubeApi(token);
  const [channel, setChannel] = useState(null);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState('videos');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const nextTokenRef = useRef(null);
  const reqIdRef = useRef(0);
  const width = Dimensions.get('window').width;
  const cardW = (width - 20 - 16 * 2) / 2;

  const fetchTab = useCallback(
    async (t, navToken, replace) => {
      if (replace) reqIdRef.current += 1;
      const rid = reqIdRef.current;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError('');
      try {
        const res = await api.channel(channelId, t, navToken);
        if (rid !== reqIdRef.current) return;
        if (res.channelTitle) setChannel(res);
        setItems((prev) => (replace ? res.items || [] : [...prev, ...(res.items || [])]));
        nextTokenRef.current = res.nextToken || null;
        setHasMore(!!res.hasMore && !!res.nextToken);
        if (replace && !res.items) setError(t === 'videos' ? '' : `No ${t} available.`);
      } catch (e) {
        if (rid === reqIdRef.current && replace) setError(`Could not load ${t}.`);
      } finally {
        if (rid === reqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, channelId]
  );

  useEffect(() => {
    fetchTab(tab, null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, tab]);

  const loadMore = () => {
    if (!hasMore || loadingMore || loading) return;
    fetchTab(tab, nextTokenRef.current, false);
  };

  const [subbed, setSubbed] = useState(isSubscribed(channelId));
  const onSubscribe = async () => {
    if (!channel) return;
    setSubbed(await toggleSubscribe({
      channelId: channel.channelId,
      channelTitle: channel.channelTitle,
      avatar: channel.avatar,
    }));
  };

  const subBtn = (
    <TouchableOpacity style={[styles.subBtn, { backgroundColor: subbed ? theme.primaryLight : theme.primary }]} onPress={onSubscribe}>
      <Text style={{ color: subbed ? theme.primary : '#fff', fontSize: fs(13), fontWeight: '800' }}>
        {subbed ? 'Subscribed' : 'Subscribe'}
      </Text>
    </TouchableOpacity>
  );

  const renderItem = ({ item }) => {
    if (item.type === 'playlist') {
      return (
        <ItemRow
          item={item}
          onPress={(it) => onOpenPlaylist && onOpenPlaylist(it.playlistId)}
          trailing={<Icon name="list" size={16} color={theme.textSecondary} />}
        />
      );
    }
    return <VideoCard item={item} width={cardW} dlMap={dlMap} onPress={onPlay} onDownload={onDownload} />;
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="arrow-back" size={23} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>{channel?.channelTitle || 'Channel'}</Text>
      </View>

      {loading && !channel ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : error && items.length === 0 && !channel ? (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => fetchTab(tab, null, true)}>
            <Text style={{ color: theme.primary, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it, i) => it.videoId || it.playlistId || `k${i}`}
          numColumns={tab === 'videos' ? 2 : 1}
          columnWrapperStyle={tab === 'videos' ? styles.row : null}
          contentContainerStyle={{ paddingHorizontal: tab === 'videos' ? 16 : 16, paddingBottom: 16 }}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          key={tab}
          ListHeaderComponent={
            <View>
              {channel?.banner ? (
                <Image source={{ uri: channel.banner }} style={styles.banner} resizeMode="cover" />
              ) : null}
              <View style={styles.channelHead}>
                {channel?.avatar ? (
                  <Image source={{ uri: channel.avatar }} style={styles.avatar} resizeMode="cover" />
                ) : (
                  <View style={[styles.avatar, { backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center' }]}>
                    <Icon name="person" size={30} color={theme.textSecondary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.channelName, { color: theme.text }]} numberOfLines={1}>{channel?.channelTitle || ''}</Text>
                  {channel?.subscribers ? (
                    <Text style={[styles.channelMeta, { color: theme.textSecondary }]} numberOfLines={1}>{channel.subscribers}</Text>
                  ) : null}
                </View>
                {subBtn}
              </View>
              <View style={styles.tabsRow}>
                {TABS.map((t) => {
                  const active = t.id === tab;
                  return (
                    <TouchableOpacity key={t.id} style={styles.tabBtn} onPress={() => setTab(t.id)}>
                      <Text style={[styles.tabLabel, { color: active ? theme.primary : theme.textSecondary }, active && styles.tabActive]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          }
          ListEmptyComponent={
            loading ? null : (
              <Text style={[styles.hint, { color: theme.textSecondary, textAlign: 'center', marginTop: 24 }]}>
                {error || 'Nothing here yet.'}
              </Text>
            )
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} /> : null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 10, paddingBottom: 8, gap: 6 },
  backBtn: { padding: 6 },
  headerTitle: { fontSize: fs(15), fontWeight: '700', flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: fs(13), paddingHorizontal: 30, textAlign: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 18 },
  banner: { width: '100%', aspectRatio: 21 / 9, backgroundColor: '#000' },
  channelHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#000' },
  channelName: { fontSize: fs(17), fontWeight: '800' },
  channelMeta: { fontSize: fs(12), marginTop: 3 },
  subBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18 },
  tabsRow: { flexDirection: 'row', paddingHorizontal: 16, marginBottom: 10, gap: 22 },
  tabBtn: { paddingBottom: 6 },
  tabLabel: { fontSize: fs(14), fontWeight: '700' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#8B5CF6', paddingBottom: 4 },
  row: { gap: 10, marginBottom: 12 },
});