// YouTube surface container: Home feed (categories + shorts strip + continue
// watching + subscriptions), in-surface Search / Channel / Playlist / Library
// sub-screens and the full player modal.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Image, StyleSheet, ActivityIndicator, Dimensions,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { SERVER_URL } from '../config';
import { fs } from '../utils/size';
import { enqueue, subscribe, thumbUrl } from '../services/downloadsStore';
import { VideoCard } from '../components/YouTubeCards';
import { initLibrary, subscribeLibrary, storeSnapshot } from '../services/library';
import YoutubePlayerModal from './YoutubePlayerModal';
import YoutubeSearchScreen from './YoutubeSearchScreen';
import YoutubeChannelScreen from './YoutubeChannelScreen';
import YoutubePlaylistScreen from './YoutubePlaylistScreen';
import YoutubeLibraryScreen from './YoutubeLibraryScreen';

const FALLBACK_CATEGORIES = [
  { id: 'trending', label: 'Trending' },
  { id: 'music', label: 'Music' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'news', label: 'News' },
];

export default function YoutubeHomeScreen({ token, refreshTick = 0, onOpenChats, onOpenSettings, onChangeToShorts }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const nextPageTokenRef = useRef(null);
  const [error, setError] = useState('');
  const [shortsStrip, setShortsStrip] = useState([]);
  const [dlMap, setDlMap] = useState({});
  const [snap, setSnap] = useState(null);
  const requestIdRef = useRef(0);
  const [categories] = useState(FALLBACK_CATEGORIES);

  // Sub-view routing: search | channel | playlist | library | home
  const [view, setView] = useState('home');
  const [channelRoute, setChannelRoute] = useState(null);
  const [playlistRoute, setPlaylistRoute] = useState(null);
  const [watch, setWatch] = useState(null);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  useEffect(() => subscribe((list) => {
    const m = {};
    list.forEach((e) => {
      if (e.status === 'done' || e.status === 'downloading' || e.status === 'resolving' || e.status === 'error') {
        m[e.videoId] = e;
      }
    });
    setDlMap(m);
  }), []);

  useEffect(() => {
    let active = true;
    initLibrary().then(() => {
      if (active) setSnap(storeSnapshot());
    });
    const unsub = subscribeLibrary(() => setSnap(storeSnapshot()));
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const fetchPage = useCallback(
    async (cat, pageToken, opts = {}) => {
      if (opts.replace) requestIdRef.current += 1;
      const reqId = requestIdRef.current;
      try {
        setError('');
        if (opts.replace) setLoading(true);
        else setLoadingMore(true);
        const q = [`category=${encodeURIComponent(cat)}`, `refresh=${opts.refresh ? 'true' : 'false'}`];
        if (pageToken) q.push(`pageToken=${encodeURIComponent(pageToken)}`);
        const res = await fetch(`${SERVER_URL}/api/youtube/feed?${q.join('&')}`, { headers: authHeaders });
        const data = await res.json();
        if (reqId !== requestIdRef.current) return;
        setVideos((prev) => (opts.replace ? data.videos || [] : [...prev, ...(data.videos || [])]));
        nextPageTokenRef.current = data.nextPageToken;
        setHasMore(!!data.hasMore);
        if (data.videos && data.videos.length === 0 && !opts.replace) setHasMore(false);
        if (data.warning) setError(data.warning);
      } catch (e) {
        if (reqId === requestIdRef.current && opts.replace) setError('Could not load the feed right now.');
      } finally {
        if (reqId === requestIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [authHeaders]
  );

  useEffect(() => {
    let mounted = true;
    fetch(`${SERVER_URL}/api/reels/feed?category=trending`, { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => {
        if (mounted && Array.isArray(d.videos)) setShortsStrip(d.videos.slice(0, 8));
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [authHeaders]);

  useEffect(() => {
    fetchPage(category, null, { replace: true });
  }, [category]);

  useEffect(() => {
    if (refreshTick > 0) fetchPage(category, null, { replace: true, refresh: true });
  }, [refreshTick]);

  const loadMore = () => {
    if (!hasMore || loadingMore || loading) return;
    fetchPage(category, nextPageTokenRef.current, {});
  };

  const startDownload = (v) => {
    console.log('[Download] enqueue', v.videoId);
    enqueue(v).catch(() => {});
  };

  const openChannel = (item) => {
    setChannelRoute(item && (item.channelId || item.channelTitle) ? {
      channelId: item.channelId || '',
      channelTitle: item.channelTitle || item.title || '',
      avatar: item.avatar || item.thumbnailUrl || '',
    } : item);
    setView('channel');
  };

  const openPlaylist = (pl) => {
    const route = typeof pl === 'string' ? { playlistId: pl } : pl;
    setPlaylistRoute(route);
    setView('playlist');
  };

  // --- sub-screens ---------------------------------------------------------
  const sub =
    view === 'search' ? (
      <YoutubeSearchScreen
        token={token}
        onBack={() => setView('home')}
        onPlay={setWatch}
        onOpenChannel={openChannel}
        onOpenPlaylist={(id) => openPlaylist(id)}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'channel' && channelRoute ? (
      <YoutubeChannelScreen
        token={token}
        channelId={channelRoute.channelId}
        onBack={() => setView('home')}
        onPlay={setWatch}
        onOpenPlaylist={(id) => openPlaylist(id)}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'playlist' && playlistRoute ? (
      <YoutubePlaylistScreen
        token={token}
        playlist={playlistRoute}
        onBack={() => setView('home')}
        onPlay={setWatch}
        onOpenChannel={openChannel}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'library' ? (
      <YoutubeLibraryScreen
        token={token}
        onBack={() => setView('home')}
        onPlay={setWatch}
        onOpenChannel={openChannel}
        onOpenPlaylist={openPlaylist}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : null;

  const width = Dimensions.get('window').width;
  const cardW = (width - 20 - 16 * 2) / 2;
  const historyArr = snap?.history || [];
  const subsArr = snap?.subs || [];

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      {sub ? (
        sub
      ) : (
        <>
          <View style={[styles.header, { backgroundColor: theme.background }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.brand, { color: theme.primary }]}>Tojey</Text>
              <Text style={[styles.tagline, { color: theme.textSecondary }]}>YouTube inside</Text>
            </View>
            <TouchableOpacity onPress={() => setView('search')} style={styles.headerBtn}>
              <Icon name="search" size={22} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setView('library')} style={[styles.headerBtn, { marginLeft: 12 }]}>
              <Icon name="library-outline" size={22} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onOpenChats} style={[styles.headerBtn, { marginLeft: 12 }]}>
              <Icon name="chatbubbles-outline" size={23} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onOpenSettings} style={[styles.headerBtn, { marginLeft: 12 }]}>
              <Icon name="settings-outline" size={22} color={theme.primary} />
            </TouchableOpacity>
          </View>

      {loading && videos.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : error && videos.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: theme.textSecondary, paddingHorizontal: 30, textAlign: 'center' }}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => fetchPage(category, null, { replace: true })}>
            <Text style={{ color: theme.primary, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={videos}
          keyExtractor={(v) => v.videoId}
          numColumns={2}
          columnWrapperStyle={styles.row}
          renderItem={({ item }) => (
            <VideoCard item={item} width={cardW} dlMap={dlMap} onPress={setWatch} onDownload={startDownload} />
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View>
              <View style={styles.chips}>
                {categories.map((c) => {
                  const active = c.id === category;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      style={[styles.chip, { backgroundColor: active ? theme.primary : theme.inputBg }]}
                      onPress={() => setCategory(c.id)}
                    >
                      <Text style={[styles.chipText, { color: active ? '#fff' : theme.textSecondary }]}>
                        {c.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {historyArr.length > 0 && (
                <View style={styles.strip}>
                  <Text style={[styles.stripTitle, { color: theme.text }]}>Continue watching</Text>
                  <FlatList
                    data={historyArr.slice(0, 10)}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyExtractor={(h) => h.videoId}
                    contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
                    renderItem={({ item }) => (
                      <TouchableOpacity style={{ width: 140 }} activeOpacity={0.85} onPress={() => setWatch(item)}>
                        <Image source={{ uri: thumbUrl(item) }} style={styles.continueThumb} resizeMode="cover" />
                        <Text style={{ color: theme.text, fontSize: fs(12), fontWeight: '600', marginTop: 4 }} numberOfLines={2}>{item.title}</Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {subsArr.length > 0 && (
                <View style={styles.strip}>
                  <Text style={[styles.stripTitle, { color: theme.text }]}>Subscriptions</Text>
                  <FlatList
                    data={subsArr}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyExtractor={(s) => s.channelId}
                    contentContainerStyle={{ paddingHorizontal: 16, gap: 14 }}
                    renderItem={({ item }) => (
                      <TouchableOpacity style={{ width: 64, alignItems: 'center' }} activeOpacity={0.85} onPress={() => openChannel(item)}>
                        {item.avatar ? (
                          <Image source={{ uri: item.avatar }} style={styles.subAvatar} resizeMode="cover" />
                        ) : (
                          <View style={[styles.subAvatar, { backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center' }]}>
                            <Icon name="person" size={22} color={theme.textSecondary} />
                          </View>
                        )}
                        <Text style={{ color: theme.textSecondary, fontSize: fs(10), marginTop: 4, textAlign: 'center' }} numberOfLines={2}>
                          {item.channelTitle || item.title}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {shortsStrip.length > 0 && (
                <TouchableOpacity onPress={onChangeToShorts} activeOpacity={0.85}>
                  <View style={[styles.shortsHeaderRow, { marginTop: 6 }]}>
                    <Icon name="play-circle" size={18} color={theme.primary} />
                    <Text style={[styles.shortsHeader, { color: theme.text }]}>Shorts</Text>
                    <Text style={{ color: theme.textSecondary, fontSize: fs(12) }}>→ watch full screen</Text>
                  </View>
                  <View style={styles.shortsRow}>
                    {shortsStrip.map((s) => (
                      <Image key={s.videoId} source={{ uri: thumbUrl(s) }} style={styles.shortsThumb} resizeMode="cover" />
                    ))}
                  </View>
                </TouchableOpacity>
              )}
              <Text style={[styles.sectionTitle, { color: theme.text }]}>
                {categories.find((c) => c.id === category)?.label} videos
              </Text>
            </View>
          }
          ListEmptyComponent={
            !loading ? (
              <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 30 }}>No videos yet.</Text>
            ) : null
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} /> : null
          }
          contentContainerStyle={{ paddingBottom: 12 }}
          removeClippedSubviews
          showsVerticalScrollIndicator={false}
        />
      )}
      </>
      )}

      {!!watch && (
        <YoutubePlayerModal
          item={watch}
          authHeaders={authHeaders}
          token={token}
          onClose={() => setWatch(null)}
          onOpenChannel={openChannel}
          onOpenPlaylist={openPlaylist}
          dlMap={dlMap}
          onDownload={startDownload}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  brand: { fontSize: fs(22), fontWeight: '900', letterSpacing: 0.2 },
  tagline: { fontSize: fs(11), marginTop: -1 },
  headerBtn: { padding: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 6, borderRadius: 16 },
  chipText: { fontSize: fs(12), fontWeight: '600' },
  strip: { marginTop: 18 },
  stripTitle: { fontSize: fs(15), fontWeight: '800', marginBottom: 10, paddingHorizontal: 16 },
  continueThumb: { width: 140, height: 79, borderRadius: 10, backgroundColor: '#000' },
  subAvatar: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#000' },
  sectionTitle: { fontSize: fs(15), fontWeight: '800', marginHorizontal: 16, marginTop: 16, marginBottom: 8 },
  row: { paddingHorizontal: 8, gap: 8, marginBottom: 12 },
  shortsHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16 },
  shortsHeader: { fontSize: fs(16), fontWeight: '800' },
  shortsRow: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 10, gap: 8 },
  shortsThumb: { width: 92, height: 126, borderRadius: 10, backgroundColor: '#000' },
});