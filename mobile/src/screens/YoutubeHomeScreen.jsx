// YouTube surface container: Home feed (categories + shorts strip + continue
// watching + subscriptions), in-surface Search / Channel / Playlist / Library
// sub-screens and the full player modal.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Image, StyleSheet, ActivityIndicator,
  Platform, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { SERVER_URL } from '../config';
import { fs } from '../utils/size';
import { enqueue, subscribe, thumbUrl } from '../services/downloadsStore';
import { VideoCard } from '../components/YouTubeCards';
import { initLibrary, subscribeLibrary, storeSnapshot } from '../services/library';
import { getRecommendationSeeds, getWatchedVideoIds, recordWatched } from '../services/recommendation';
import YoutubePlayerModal from './YoutubePlayerModal';
import YoutubeSearchScreen from './YoutubeSearchScreen';
import YoutubeChannelScreen from './YoutubeChannelScreen';
import YoutubePlaylistScreen from './YoutubePlaylistScreen';
import YoutubeLibraryScreen from './YoutubeLibraryScreen';

const FALLBACK_CATEGORIES = [
  { id: 'recommended', label: 'Recommended for you' },
  { id: 'trending', label: 'Trending' },
  { id: 'music', label: 'Music' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'news', label: 'News' },
];

const FEED_CACHE_KEY = 'yt_home_feed_v1';
const STRIP_CACHE_KEY = 'yt_home_shorts_strip_v1';
const SUBFEED_CACHE_KEY = 'yt_home_subfeed_v1';

export default function YoutubeHomeScreen({ token, refreshTick = 0, onOpenChats, onOpenSettings, onChangeToShorts, initialWatch, onInitialWatchConsumed, registerBackHandler }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('recommended');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const nextPageTokenRef = useRef(null);
  const [error, setError] = useState('');
  const [shortsStrip, setShortsStrip] = useState([]);
  const [dlMap, setDlMap] = useState({});
  const [subFeed, setSubFeed] = useState([]);
  const [snap, setSnap] = useState(null);
  const requestIdRef = useRef(0);
  const nonceRef = useRef(0);
  const [categories] = useState(FALLBACK_CATEGORIES);

  // Sub-view routing: search | channel | playlist | library | home
  const [view, setView] = useState('home');
  const [channelRoute, setChannelRoute] = useState(null);
  const [playlistRoute, setPlaylistRoute] = useState(null);
  const [watch, setWatch] = useState(null);
  const lastInitialWatchRef = useRef(null);

  useEffect(() => {
    if (typeof registerBackHandler !== 'function') return undefined;
    registerBackHandler(() => {
      if (watch) {
        setWatch(null);
        return true;
      }
      if (view !== 'home') {
        setView('home');
        return true;
      }
      return false;
    });
    return () => {
      if (typeof registerBackHandler === 'function') registerBackHandler(null);
    };
  }, [watch, view, registerBackHandler]);

  // Open a video requested by the Watch Together room exactly once.
  useEffect(() => {
    if (!initialWatch || !initialWatch.videoId) return;
    if (lastInitialWatchRef.current === initialWatch.key) return;
    lastInitialWatchRef.current = initialWatch.key;
    setView('home');
    setWatch({
      videoId: initialWatch.videoId,
      title: initialWatch.title || 'Watch together',
      channelTitle: '',
      channelId: '',
      thumbnailUrl: '',
    });
    if (onInitialWatchConsumed) onInitialWatchConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWatch]);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  useEffect(() => subscribe((list) => {
    const m = {};
    list.forEach((e) => {
      if (e.status === 'done' || e.status === 'downloading' || e.status === 'resolving' || e.status === 'error') {
        m[`${e.videoId}:${e.kind || 'video'}`] = e;
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

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [stripRaw, subRaw] = await Promise.all([
          AsyncStorage.getItem(STRIP_CACHE_KEY),
          AsyncStorage.getItem(SUBFEED_CACHE_KEY),
        ]);
        if (!active) return;
        if (stripRaw) {
          const parsed = JSON.parse(stripRaw);
          if (Array.isArray(parsed) && parsed.length) setShortsStrip(parsed.slice(0, 8));
        }
        if (subRaw) {
          const parsed = JSON.parse(subRaw);
          if (Array.isArray(parsed)) setSubFeed(parsed);
        }
      } catch (e) {}
    })();
    return () => { active = false; };
  }, []);

  const fetchPage = useCallback(
    async (cat, pageToken, opts = {}) => {
      if (opts.replace) requestIdRef.current += 1;
      const reqId = requestIdRef.current;
      const background = !!opts.background;
      try {
        setError('');
        if (opts.replace && !background) setLoading(true);
        else if (!opts.replace) setLoadingMore(true);
        const q = [`category=${encodeURIComponent(cat)}`, `refresh=${opts.refresh ? 'true' : 'false'}`];
        if (pageToken) q.push(`pageToken=${encodeURIComponent(pageToken)}`);
        if (cat === 'recommended') {
          const [seeds, watched] = await Promise.all([
            getRecommendationSeeds(8),
            getWatchedVideoIds(250),
          ]);
          if (seeds.length) q.push(`seeds=${encodeURIComponent(JSON.stringify(seeds))}`);
          if (watched.length) q.push(`exclude=${encodeURIComponent(JSON.stringify(watched))}`);
          q.push(`nonce=${nonceRef.current++}`);
        }
        const res = await fetch(`${SERVER_URL}/api/youtube/feed?${q.join('&')}`, { headers: authHeaders });
        const data = await res.json();
        if (reqId !== requestIdRef.current) return;
        const nextVideos = opts.replace ? (data.videos || []) : null;
        setVideos((prev) => (opts.replace ? (data.videos || []) : [...prev, ...(data.videos || [])]));
        nextPageTokenRef.current = data.nextPageToken || null;
        setHasMore(!!data.hasMore);
        if (data.videos && data.videos.length === 0 && !opts.replace) setHasMore(false);
        if (data.warning) setError(data.warning);
        if (opts.replace) {
          try {
            await AsyncStorage.setItem(`${FEED_CACHE_KEY}_${cat}`, JSON.stringify({
              videos: nextVideos || [],
              nextPageToken: data.nextPageToken || null,
              hasMore: !!data.hasMore,
              ts: Date.now(),
            }));
          } catch (e) {}
        }
      } catch (e) {
        if (reqId === requestIdRef.current && opts.replace && !background) setError('Could not load the feed right now.');
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
    (async () => {
      try {
        const [seeds, watched] = await Promise.all([
          getRecommendationSeeds(8),
          getWatchedVideoIds(250),
        ]);
        const q = ['category=trending'];
        if (seeds.length) q.push(`seeds=${encodeURIComponent(JSON.stringify(seeds))}`);
        if (watched.length) q.push(`exclude=${encodeURIComponent(JSON.stringify(watched))}`);
        const res = await fetch(`${SERVER_URL}/api/shorts/feed?${q.join('&')}`, { headers: authHeaders });
        const d = await res.json();
        if (!mounted || !Array.isArray(d.items)) return;
        const items = d.items.slice(0, 8);
        setShortsStrip(items);
        try { await AsyncStorage.setItem(STRIP_CACHE_KEY, JSON.stringify(items)); } catch (e) {}
      } catch (e) {}
    })();
    return () => {
      mounted = false;
    };
  }, [authHeaders, refreshTick]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(`${FEED_CACHE_KEY}_${category}`);
        if (!active) return;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.videos)) {
            setVideos(parsed.videos);
            nextPageTokenRef.current = parsed.nextPageToken || null;
            setHasMore(!!parsed.hasMore);
            setLoading(false);
            fetchPage(category, null, { replace: true, background: true });
            return;
          }
        }
      } catch (e) {}
      if (active) fetchPage(category, null, { replace: true });
    })();
    return () => { active = false; };
  }, [category, fetchPage]);

  useEffect(() => {
    if (refreshTick > 0) fetchPage(category, null, { replace: true, refresh: true });
  }, [refreshTick, category, fetchPage]);

  const subIdsKey = useMemo(
    () => (snap?.subs || []).map((s) => s.channelId).filter(Boolean).sort().join(','),
    [snap]
  );

  useEffect(() => {
    if (!subIdsKey) {
      setSubFeed([]);
      return;
    }
    let active = true;
    fetch(`${SERVER_URL}/api/yt/subfeed?channels=${encodeURIComponent(subIdsKey)}&per=4&cap=20`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then(async (d) => {
        if (!active) return;
        const items = d.items || [];
        setSubFeed(items);
        try { await AsyncStorage.setItem(SUBFEED_CACHE_KEY, JSON.stringify(items)); } catch (e) {}
      })
      .catch(() => {});
    return () => { active = false; };
  }, [subIdsKey, authHeaders, refreshTick]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading) return;
    fetchPage(category, nextPageTokenRef.current, {});
  }, [hasMore, loadingMore, loading, category, fetchPage]);

  const startDownload = useCallback((v, opts) => {
    console.log('[Download] enqueue', v.videoId);
    enqueue(v, opts).catch(() => {});
  }, []);

  const openWatch = useCallback((item) => {
    setWatch(item);
    if (item && item.videoId) {
      recordWatched({
        videoId: item.videoId,
        title: item.title || '',
        channelTitle: item.channelTitle || '',
        thumbnailUrl: item.thumbnailUrl || '',
        durationSeconds: item.durationSeconds || 0,
      }).catch(() => {});
    }
  }, []);

  const openChannel = useCallback((item) => {
    setChannelRoute(item && (item.channelId || item.channelTitle) ? {
      channelId: item.channelId || '',
      channelTitle: item.channelTitle || item.title || '',
      avatar: item.avatar || item.thumbnailUrl || '',
    } : item);
    setView('channel');
  }, []);

  const openPlaylist = useCallback((pl) => {
    const route = typeof pl === 'string' ? { playlistId: pl } : pl;
    setPlaylistRoute(route);
    setView('playlist');
  }, []);

  // --- sub-screens ---------------------------------------------------------
  const sub =
    view === 'search' ? (
      <YoutubeSearchScreen
        token={token}
        onBack={() => setView('home')}
        onPlay={openWatch}
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
        onPlay={openWatch}
        onOpenPlaylist={(id) => openPlaylist(id)}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'playlist' && playlistRoute ? (
      <YoutubePlaylistScreen
        token={token}
        playlist={playlistRoute}
        onBack={() => setView('home')}
        onPlay={openWatch}
        onOpenChannel={openChannel}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'library' ? (
      <YoutubeLibraryScreen
        token={token}
        onBack={() => setView('home')}
        onPlay={openWatch}
        onOpenChannel={openChannel}
        onOpenPlaylist={openPlaylist}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : null;

  const { width } = useWindowDimensions();
  const cardW = (width - 32 - 12) / 2;
  const historyArr = useMemo(() => (snap?.history || []).slice(0, 10), [snap]);
  const subsArr = useMemo(() => snap?.subs || [], [snap]);

  const renderVideoCard = useCallback(({ item }) => (
    <VideoCard item={item} width={cardW} dlMap={dlMap} onPress={openWatch} onDownload={startDownload} />
  ), [cardW, dlMap, openWatch, startDownload]);

  const renderHistoryItem = useCallback(({ item }) => (
    <TouchableOpacity style={{ width: 140 }} activeOpacity={0.85} onPress={() => openWatch(item)}>
      <Image source={{ uri: thumbUrl(item) }} style={styles.continueThumb} resizeMode="cover" />
      <Text style={{ color: theme.text, fontSize: fs(12), fontWeight: '600', marginTop: 4 }} numberOfLines={2}>{item.title}</Text>
    </TouchableOpacity>
  ), [theme.text, openWatch]);

  const renderSubscription = useCallback(({ item }) => (
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
  ), [openChannel, theme.inputBg, theme.textSecondary]);

  const renderSubFeedItem = useCallback(({ item }) => (
    <VideoCard item={item} width={200} dlMap={dlMap} onPress={openWatch} onDownload={startDownload} showChannel />
  ), [dlMap, openWatch, startDownload]);

  const listHeader = useMemo(() => (
    <View>
      {historyArr.length > 0 && (
        <View style={styles.strip}>
          <Text style={[styles.stripTitle, { color: theme.text }]}>Continue watching</Text>
          <FlatList
            data={historyArr}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(h) => h.videoId}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
            renderItem={renderHistoryItem}
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
            renderItem={renderSubscription}
          />
        </View>
      )}

      {subFeed.length > 0 && (
        <View style={styles.strip}>
          <Text style={[styles.stripTitle, { color: theme.text }]}>New from your subscriptions</Text>
          <FlatList
            data={subFeed}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(v) => v.videoId}
            contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}
            renderItem={renderSubFeedItem}
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
        {(() => {
          const label = categories.find((c) => c.id === category)?.label || 'Recommended for you';
          return label === 'Recommended for you' ? label : `${label} videos`;
        })()}
      </Text>
    </View>
  ), [historyArr, subsArr, subFeed, shortsStrip, theme, onChangeToShorts, categories, category, renderHistoryItem, renderSubscription, renderSubFeedItem]);

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      {sub ? (
        sub
      ) : (
        <>
          <View style={[styles.header, { backgroundColor: theme.background }]}>
            <TouchableOpacity onPress={onOpenChats} style={[styles.headerBtn, { marginRight: 8 }]} accessibilityLabel="Back to chats">
              <Icon name="chevron-back" size={24} color={theme.primary} />
            </TouchableOpacity>
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
          renderItem={renderVideoCard}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={30}
          windowSize={7}
          removeClippedSubviews={Platform.OS === 'android'}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            !loading ? (
              <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 30 }}>No videos yet.</Text>
            ) : null
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} /> : null
          }
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
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
  strip: { marginTop: 18 },
  stripTitle: { fontSize: fs(15), fontWeight: '800', marginBottom: 10, paddingHorizontal: 16 },
  continueThumb: { width: 140, height: 79, borderRadius: 10, backgroundColor: '#000' },
  subAvatar: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#000' },
  sectionTitle: { fontSize: fs(15), fontWeight: '800', marginHorizontal: 16, marginTop: 16, marginBottom: 8 },
  row: { gap: 12, marginBottom: 12 },
  shortsHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16 },
  shortsHeader: { fontSize: fs(16), fontWeight: '800' },
  shortsRow: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 10, gap: 8 },
  shortsThumb: { width: 92, height: 126, borderRadius: 10, backgroundColor: '#000' },
});