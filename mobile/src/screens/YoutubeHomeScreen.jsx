// YouTube surface container: Home feed (categories + shorts strip + continue
// watching + subscriptions), in-surface Search / Channel / Playlist / Library
// sub-screens and the full player modal.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, ScrollView, Image, StyleSheet, ActivityIndicator,
  Platform, InteractionManager, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { SERVER_URL } from '../config';
import { fs } from '../utils/size';
import { enqueue, subscribe, thumbUrl } from '../services/downloadsStore';
import { VideoCard } from '../components/YouTubeCards';
import { initLibrary, subscribeLibrary, storeSnapshot } from '../services/library';
import { flushWatchWrites, getRecommendationSeeds, getWatchedVideoIds, recordWatched, subscribeRecommendationChanged } from '../services/recommendation';
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
const FEED_CACHE_TTL = 5 * 60 * 1000;
const STRIP_CACHE_TTL = 10 * 60 * 1000;
const SUBFEED_TTL = 5 * 60 * 1000;
const REFRESH_COOLDOWN = 20 * 1000;
const REC_CHANGED_DEBOUNCE = 45 * 1000;
const MAX_SUB_IDS = 15;
const MAX_STRIP = 8;
const CACHE_WRITES_CAP = 24;
const memoryCache = new Map();

async function readStored(key) {
  if (memoryCache.has(key)) return memoryCache.get(key);
  const raw = await AsyncStorage.getItem(key);
  memoryCache.set(key, raw);
  return raw;
}

async function writeStored(key, payload) {
  memoryCache.set(key, payload);
  try { await AsyncStorage.setItem(key, payload); } catch (e) {}
}

async function getSignals() {
  try {
    const [seeds, watched] = await Promise.all([getRecommendationSeeds(8), getWatchedVideoIds(250)]);
    return { seeds, watched };
  } catch (e) {
    return { seeds: [], watched: [] };
  }
}

function parseCache(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function isFresh(ts, ttl) {
  return typeof ts === 'number' && Date.now() - ts < ttl;
}

function rememberWrite(writes, key, value) {
  if (writes.current.get(key) === value) return false;
  writes.current.set(key, value);
  if (writes.current.size > CACHE_WRITES_CAP) {
    const oldest = writes.current.keys().next().value;
    writes.current.delete(oldest);
  }
  return true;
}

function YoutubeHomeScreenInner({ token, refreshTick = 0, onOpenChats, onOpenSettings, onChangeToShorts, initialWatch, onInitialWatchConsumed, registerBackHandler }) {
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
  const [categories] = useState(FALLBACK_CATEGORIES);
  const [headerReady, setHeaderReady] = useState(false);
  const [shortsSignalTick, setShortsSignalTick] = useState(0);

  const requestIdRef = useRef(0);
  const nonceRef = useRef(0);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(new Set());
  const cacheWritesRef = useRef(new Map());
  const dlSigRef = useRef('');
  const snapSigRef = useRef('');
  const refreshTickRef = useRef(refreshTick);
  const shortsTickRef = useRef(refreshTick);
  const shortsSignalTickRef = useRef(shortsSignalTick);
  const shortsAuthRef = useRef(null);
  const shortsFetchedAtRef = useRef(0);
  const shortsInFlightRef = useRef(false);
  const subTickRef = useRef(refreshTick);
  const subAuthRef = useRef(null);
  const subKeyRef = useRef(null);
  const subFetchedAtRef = useRef(0);
  const subInFlightRef = useRef(false);
  const subLoadedRef = useRef(false);
  const loadMoreInFlightRef = useRef(false);
  const lastInitialWatchRef = useRef(null);
  const recChangedRef = useRef({ timer: null, lastRun: 0 });

  const [view, setView] = useState('home');
  const [channelRoute, setChannelRoute] = useState(null);
  const [playlistRoute, setPlaylistRoute] = useState(null);
  const [watch, setWatch] = useState(null);
  const backStateRef = useRef({ watch, view });
  backStateRef.current = { watch, view };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      inFlightRef.current.clear();
      shortsInFlightRef.current = false;
      subInFlightRef.current = false;
      loadMoreInFlightRef.current = false;
      flushWatchWrites();
    };
  }, []);

  useEffect(() => {
    if (typeof registerBackHandler !== 'function') return undefined;
    const onBack = () => {
      const state = backStateRef.current;
      if (state.watch) {
        setWatch(null);
        return true;
      }
      if (state.view !== 'home') {
        setView('home');
        return true;
      }
      return false;
    };
    registerBackHandler(onBack);
    return () => {
      if (typeof registerBackHandler === 'function') registerBackHandler(null);
    };
  }, [registerBackHandler]);

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

  useEffect(() => {
    let cancelled = false;
    const show = () => { if (!cancelled && aliveRef.current) setHeaderReady(true); };
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      const handle = InteractionManager.runAfterInteractions(show);
      return () => {
        cancelled = true;
        if (handle && typeof handle.cancel === 'function') handle.cancel();
      };
    }
    const timer = setTimeout(show, 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  useEffect(() => subscribe((list) => {
    const m = {};
    list.forEach((e) => {
      if (e.status === 'done' || e.status === 'downloading' || e.status === 'resolving' || e.status === 'error') {
        m[`${e.videoId}:${e.kind || 'video'}`] = e;
      }
    });
    const sig = JSON.stringify(m);
    if (sig === dlSigRef.current) return;
    dlSigRef.current = sig;
    if (aliveRef.current) setDlMap(m);
  }), []);

  const updateSnap = useCallback((next) => {
    const value = next || {};
    const sig = JSON.stringify([
      (value.history || []).slice(0, 10).map((h) => h.videoId),
      (value.subs || []).map((s) => s.channelId),
    ]);
    if (sig === snapSigRef.current) return;
    snapSigRef.current = sig;
    setSnap(next);
  }, []);

  useEffect(() => {
    initLibrary().then(() => {
      if (aliveRef.current) updateSnap(storeSnapshot());
    }).catch(() => {});
    const unsub = subscribeLibrary((next) => {
      if (aliveRef.current) updateSnap(next);
    });
    return () => { unsub(); };
  }, [updateSnap]);

  const fetchPage = useCallback(
    async (cat, pageToken, opts = {}) => {
      if (!aliveRef.current) return;
      const replace = !!opts.replace;
      const background = !!opts.background;
      const force = !!opts.force;
      const key = `${cat}|${pageToken || ''}|${replace ? 'r' : 'p'}|${force ? 'f' : ''}`;
      if (inFlightRef.current.has(key)) return;
      inFlightRef.current.add(key);
      try {
        if (replace) requestIdRef.current += 1;
        if (force) nonceRef.current += 1;
        const reqId = requestIdRef.current;
        try {
          if (aliveRef.current) {
            setError('');
            if (replace && !background) setLoading(true);
            else if (!replace) setLoadingMore(true);
          }
          const q = [`category=${encodeURIComponent(cat)}`, `refresh=${force ? 'true' : 'false'}`];
          if (pageToken) q.push(`pageToken=${encodeURIComponent(pageToken)}`);
          if (cat === 'recommended') {
            const { seeds, watched } = await getSignals();
            if (seeds.length) q.push(`seeds=${encodeURIComponent(JSON.stringify(seeds))}`);
            if (watched.length) q.push(`exclude=${encodeURIComponent(JSON.stringify(watched))}`);
            q.push(`nonce=${nonceRef.current}`);
          }
          const res = await fetch(`${SERVER_URL}/api/youtube/feed?${q.join('&')}`, { headers: authHeaders });
          const data = await res.json();
          if (!aliveRef.current || reqId !== requestIdRef.current) return;
          const nextVideos = replace ? (data.videos || []) : null;
          setVideos((prev) => (replace ? (data.videos || []) : [...prev, ...(data.videos || [])]));
          nextPageTokenRef.current = data.nextPageToken || null;
          setHasMore(!!data.hasMore);
          if (data.videos && data.videos.length === 0 && !replace) setHasMore(false);
          if (data.warning) setError(data.warning);
          if (replace) {
            const cacheKey = `${FEED_CACHE_KEY}_${cat}`;
            const payload = JSON.stringify({
              videos: nextVideos || [],
              nextPageToken: data.nextPageToken || null,
              hasMore: !!data.hasMore,
              ts: Date.now(),
            });
            if (rememberWrite(cacheWritesRef, cacheKey, payload)) {
              await writeStored(cacheKey, payload);
            }
          }
        } catch (e) {
          if (aliveRef.current && reqId === requestIdRef.current && replace && !background) {
            setError('Could not load the feed right now.');
          }
        } finally {
          if (aliveRef.current && reqId === requestIdRef.current) {
            setLoading(false);
            setLoadingMore(false);
          }
        }
      } finally {
        inFlightRef.current.delete(key);
      }
    },
    [authHeaders]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const raw = await readStored(`${FEED_CACHE_KEY}_${category}`);
        if (!active || !aliveRef.current) return;
        const cached = parseCache(raw);
        if (cached && Array.isArray(cached.videos) && cached.videos.length) {
          setVideos(cached.videos);
          nextPageTokenRef.current = cached.nextPageToken || null;
          setHasMore(!!cached.hasMore);
          setLoading(false);
          if (isFresh(cached.ts, FEED_CACHE_TTL)) return;
          fetchPage(category, null, { replace: true, background: true });
          return;
        }
      } catch (e) {}
      if (active && aliveRef.current) fetchPage(category, null, { replace: true });
    })();
    return () => { active = false; };
  }, [category, fetchPage]);

  useEffect(() => {
    if (refreshTick === refreshTickRef.current) return;
    refreshTickRef.current = refreshTick;
    fetchPage(category, null, { replace: true, background: true });
  }, [refreshTick, category, fetchPage]);

  useEffect(() => {
    const handler = () => {
      if (!aliveRef.current) return;
      const state = recChangedRef.current;
      if (state.timer) return;
      const delay = Math.max(0, REC_CHANGED_DEBOUNCE - (Date.now() - state.lastRun));
      state.timer = setTimeout(() => {
        state.timer = null;
        state.lastRun = Date.now();
        if (!aliveRef.current) return;
        if (category === 'recommended') fetchPage(category, null, { replace: true, background: true });
        setShortsSignalTick((tick) => tick + 1);
      }, delay);
    };
    const unsub = subscribeRecommendationChanged(handler);
    return () => {
      unsub();
      if (recChangedRef.current.timer) clearTimeout(recChangedRef.current.timer);
      recChangedRef.current.timer = null;
    };
  }, [category, fetchPage]);

  useEffect(() => {
    let active = true;
    const authChanged = shortsAuthRef.current !== null && shortsAuthRef.current !== authHeaders;
    shortsAuthRef.current = authHeaders;
    const tickChanged = refreshTick !== shortsTickRef.current;
    const forced = tickChanged || authChanged;
    shortsTickRef.current = refreshTick;
    shortsSignalTickRef.current = shortsSignalTick;
    (async () => {
      try {
        const raw = await readStored(STRIP_CACHE_KEY);
        const cached = parseCache(raw);
        if (active && aliveRef.current && Array.isArray(cached?.items)) {
          setShortsStrip(cached.items.slice(0, MAX_STRIP));
          shortsFetchedAtRef.current = cached.ts || Date.now();
        }
      } catch (e) {}
      if (!active || !aliveRef.current) return;
      if (!forced && Date.now() - shortsFetchedAtRef.current < STRIP_CACHE_TTL) return;
      if (shortsInFlightRef.current) return;
      shortsInFlightRef.current = true;
      try {
        const { seeds, watched } = await getSignals();
        const q = ['category=trending', 'refresh=false'];
        if (seeds.length) q.push(`seeds=${encodeURIComponent(JSON.stringify(seeds))}`);
        if (watched.length) q.push(`exclude=${encodeURIComponent(JSON.stringify(watched))}`);
        const res = await fetch(`${SERVER_URL}/api/shorts/feed?${q.join('&')}`, { headers: authHeaders });
        const d = await res.json();
        if (!active || !aliveRef.current || !Array.isArray(d.items)) return;
        const items = d.items.slice(0, MAX_STRIP);
        setShortsStrip(items);
        shortsFetchedAtRef.current = Date.now();
        const payload = JSON.stringify({ items, ts: Date.now() });
        if (rememberWrite(cacheWritesRef, STRIP_CACHE_KEY, payload)) {
          await writeStored(STRIP_CACHE_KEY, payload);
        }
      } catch (e) {} finally {
        shortsInFlightRef.current = false;
      }
    })();
    return () => { active = false; };
  }, [authHeaders, refreshTick, shortsSignalTick]);

  const subIdsKey = useMemo(() => {
    const ids = (snap?.subs || []).map((s) => s.channelId).filter(Boolean).slice(0, MAX_SUB_IDS);
    return [...new Set(ids)].sort().join(',');
  }, [snap]);

  useEffect(() => {
    if (!subIdsKey) {
      setSubFeed([]);
      return undefined;
    }
    let active = true;
    const authChanged = subAuthRef.current !== null && subAuthRef.current !== authHeaders;
    subAuthRef.current = authHeaders;
    const keyChanged = subKeyRef.current !== null && subKeyRef.current !== subIdsKey;
    subKeyRef.current = subIdsKey;
    const tickChanged = refreshTick !== subTickRef.current;
    subTickRef.current = refreshTick;
    const forced = authChanged || keyChanged || tickChanged;
    (async () => {
      if (!subLoadedRef.current) {
        subLoadedRef.current = true;
        try {
          const raw = await readStored(SUBFEED_CACHE_KEY);
          const cached = parseCache(raw);
          if (active && aliveRef.current && Array.isArray(cached?.items)) {
            setSubFeed(cached.items);
            subFetchedAtRef.current = cached.ts || Date.now();
          }
        } catch (e) {}
      }
      if (!active || !aliveRef.current) return;
      if (!forced && Date.now() - subFetchedAtRef.current < SUBFEED_TTL) return;
      if (forced && !keyChanged && !authChanged && Date.now() - subFetchedAtRef.current < REFRESH_COOLDOWN) return;
      if (subInFlightRef.current) return;
      subInFlightRef.current = true;
      try {
        const res = await fetch(`${SERVER_URL}/api/yt/subfeed?channels=${encodeURIComponent(subIdsKey)}&per=4&cap=20`, { headers: authHeaders });
        const d = res.ok ? await res.json() : { items: [] };
        if (!active || !aliveRef.current) return;
        const items = d.items || [];
        setSubFeed(items);
        subFetchedAtRef.current = Date.now();
        const payload = JSON.stringify({ items, ts: Date.now() });
        if (rememberWrite(cacheWritesRef, SUBFEED_CACHE_KEY, payload)) {
          await writeStored(SUBFEED_CACHE_KEY, payload);
        }
      } catch (e) {} finally {
        subInFlightRef.current = false;
      }
    })();
    return () => { active = false; };
  }, [subIdsKey, authHeaders, refreshTick]);

  const loadMore = useCallback(() => {
    if (loadMoreInFlightRef.current || !hasMore || loadingMore || loading) return;
    const pageToken = nextPageTokenRef.current;
    if (!pageToken) return;
    loadMoreInFlightRef.current = true;
    Promise.resolve(fetchPage(category, pageToken, {})).finally(() => {
      loadMoreInFlightRef.current = false;
    });
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

  const closeWatch = useCallback(() => setWatch(null), []);
  const goHome = useCallback(() => setView('home'), []);
  const goSearch = useCallback(() => setView('search'), []);
  const goLibrary = useCallback(() => setView('library'), []);

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

  const sub =
    view === 'search' ? (
      <YoutubeSearchScreen
        token={token}
        onBack={goHome}
        onPlay={openWatch}
        onOpenChannel={openChannel}
        onOpenPlaylist={openPlaylist}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'channel' && channelRoute ? (
      <YoutubeChannelScreen
        token={token}
        channelId={channelRoute.channelId}
        onBack={goHome}
        onPlay={openWatch}
        onOpenPlaylist={openPlaylist}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'playlist' && playlistRoute ? (
      <YoutubePlaylistScreen
        token={token}
        playlist={playlistRoute}
        onBack={goHome}
        onPlay={openWatch}
        onOpenChannel={openChannel}
        dlMap={dlMap}
        onDownload={startDownload}
      />
    ) : view === 'library' ? (
      <YoutubeLibraryScreen
        token={token}
        onBack={goHome}
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
  const subsArr = useMemo(() => (snap?.subs || []).slice(0, 12), [snap]);
  const sectionLabel = useMemo(() => {
    const label = categories.find((c) => c.id === category)?.label || 'Recommended for you';
    return label === 'Recommended for you' ? label : `${label} videos`;
  }, [categories, category]);

  const videoKey = useCallback((v) => v.videoId, []);
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
      {headerReady && historyArr.length > 0 && (
        <View style={styles.strip}>
          <Text style={[styles.stripTitle, { color: theme.text }]}>Continue watching</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripContent}>
            {historyArr.map((h) => <React.Fragment key={h.videoId}>{renderHistoryItem({ item: h })}</React.Fragment>)}
          </ScrollView>
        </View>
      )}

      {headerReady && subsArr.length > 0 && (
        <View style={styles.strip}>
          <Text style={[styles.stripTitle, { color: theme.text }]}>Subscriptions</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.subsContent}>
            {subsArr.map((s) => <React.Fragment key={s.channelId}>{renderSubscription({ item: s })}</React.Fragment>)}
          </ScrollView>
        </View>
      )}

      {headerReady && subFeed.length > 0 && (
        <View style={styles.strip}>
          <Text style={[styles.stripTitle, { color: theme.text }]}>New from your subscriptions</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stripContent}>
            {subFeed.map((v) => <React.Fragment key={v.videoId}>{renderSubFeedItem({ item: v })}</React.Fragment>)}
          </ScrollView>
        </View>
      )}

      {headerReady && shortsStrip.length > 0 && (
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
      <Text style={[styles.sectionTitle, { color: theme.text }]}>{sectionLabel}</Text>
    </View>
  ), [headerReady, historyArr, subsArr, subFeed, shortsStrip, theme, onChangeToShorts, sectionLabel, renderHistoryItem, renderSubscription, renderSubFeedItem]);

  const emptyComponent = useMemo(() => (
    !loading ? (
      <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 30 }}>No videos yet.</Text>
    ) : null
  ), [loading, theme.textSecondary]);

  const footerComponent = useMemo(() => (
    loadingMore ? <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} /> : null
  ), [loadingMore, theme.primary]);

  const retry = useCallback(() => fetchPage(category, null, { replace: true, force: true }), [category, fetchPage]);

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
            <TouchableOpacity onPress={goSearch} style={styles.headerBtn}>
              <Icon name="search" size={22} color={theme.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={goLibrary} style={[styles.headerBtn, { marginLeft: 12 }]}>
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
              <TouchableOpacity style={styles.retry} onPress={retry}>
                <Text style={{ color: theme.primary, fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <FlatList
              data={videos}
              keyExtractor={videoKey}
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
              ListEmptyComponent={emptyComponent}
              ListFooterComponent={footerComponent}
              contentContainerStyle={styles.feedContent}
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
          onClose={closeWatch}
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
  stripContent: { paddingHorizontal: 16, gap: 10 },
  subsContent: { paddingHorizontal: 16, gap: 14 },
  continueThumb: { width: 140, height: 79, borderRadius: 10, backgroundColor: '#000' },
  subAvatar: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#000' },
  sectionTitle: { fontSize: fs(15), fontWeight: '800', marginHorizontal: 16, marginTop: 16, marginBottom: 8 },
  row: { gap: 12, marginBottom: 12 },
  feedContent: { paddingHorizontal: 16, paddingBottom: 12 },
  shortsHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16 },
  shortsHeader: { fontSize: fs(16), fontWeight: '800' },
  shortsRow: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 10, gap: 8 },
  shortsThumb: { width: 92, height: 126, borderRadius: 10, backgroundColor: '#000' },
});

export default memo(YoutubeHomeScreenInner);
