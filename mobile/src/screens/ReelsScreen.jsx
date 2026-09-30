import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Image,
  Animated,
  AppState,
  Alert,
  Share as RNShare,
  ScrollView,
} from 'react-native';
import Video from 'react-native-video';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { SERVER_URL } from '../config';
import Toast from '../components/Toast';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const STORAGE_KEY_FEED_CACHE = '@tojey_reels_feed_cache';
const STORAGE_KEY_FEED_CACHE_TIMESTAMP = '@tojey_reels_feed_cache_timestamp';
const FEED_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes local metadata cache
const STORAGE_KEY_SEEN = '@tojey_reels_seen_v2';
const STORAGE_KEY_CURSOR = '@tojey_reels_cursor_v2';
const SEEN_MAX_IDS = 500;
const AUTO_ADVANCE_MAX_PAGES = 4;
const MIN_FRESH_BATCH = 8;
const MAX_LIST_LENGTH = 60;
const MAX_STREAM_CACHE = 8;
const LIKES_STORAGE_KEY = '@tojey_reels_likes';

const ITEM_HEIGHT = SCREEN_H;

// ---- small helpers ----------------------------------------------------------

function validateVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return false;
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId.trim());
}

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (validateVideoId(trimmed)) return trimmed;
  return null;
}

function thumbnailUrlFor(item) {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) {
    return item.thumbnailUrl.trim();
  }
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
}

// react-native-video type -> Media3 content type. Progressive URLs are inferred
// from the URL itself; manifests need an explicit extension.
function mediaType(kind) {
  if (kind === 'hls') return 'm3u8';
  if (kind === 'dash') return 'mpd';
  return undefined;
}

// ---- persistent seen / cursor / feed cache ----------------------------------

async function loadSeen(userId) {
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_KEY_SEEN}/${userId}`);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    console.warn('[Reels] Failed to load seen set:', e);
  }
  return new Set();
}

async function saveSeen(userId, set) {
  try {
    const arr = Array.from(set);
    await AsyncStorage.setItem(`${STORAGE_KEY_SEEN}/${userId}`, JSON.stringify(arr));
  } catch (e) {
    console.warn('[Reels] Failed to save seen set:', e);
  }
}

async function loadCursor(userId, category) {
  try {
    return (await AsyncStorage.getItem(`${STORAGE_KEY_CURSOR}/${userId}/${category}`)) || null;
  } catch (e) {
    return null;
  }
}

async function saveCursor(userId, category, token) {
  try {
    if (token) await AsyncStorage.setItem(`${STORAGE_KEY_CURSOR}/${userId}/${category}`, token);
  } catch (e) {
    console.warn('[Reels] Failed to save cursor:', e);
  }
}

async function loadFeedCache(category) {
  try {
    const [storedData, storedTimestamp] = await Promise.all([
      AsyncStorage.getItem(`${STORAGE_KEY_FEED_CACHE}_${category}`),
      AsyncStorage.getItem(`${STORAGE_KEY_FEED_CACHE_TIMESTAMP}_${category}`),
    ]);
    if (storedData && storedTimestamp) {
      const timestamp = parseInt(storedTimestamp, 10);
      if (Date.now() - timestamp < FEED_CACHE_MAX_AGE_MS) {
        const parsed = JSON.parse(storedData);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    }
  } catch (e) {
    console.warn('[Reels] Failed to load feed cache:', e);
  }
  return null;
}

async function saveFeedCache(category, videos) {
  try {
    await Promise.all([
      AsyncStorage.setItem(`${STORAGE_KEY_FEED_CACHE}_${category}`, JSON.stringify(videos)),
      AsyncStorage.setItem(`${STORAGE_KEY_FEED_CACHE_TIMESTAMP}_${category}`, String(Date.now())),
    ]);
  } catch (e) {
    console.warn('[Reels] Failed to save feed cache:', e);
  }
}

// ---- component ---------------------------------------------------------------

export default function ReelsScreen({ token, user, refreshTick = 0, onBack }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [categories, setCategories] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');
  const [likedIds, setLikedIds] = useState(() => new Set());
  const [muted, setMuted] = useState(false);
  const [activePaused, setActivePaused] = useState(false);
  // videoId -> resolved { source:{url,kind,height}, audioSource }
  const [resolved, setResolved] = useState(() => new Map());

  const mutedRef = useRef(false);
  const flatListRef = useRef(null);
  const scrollOffsetYRef = useRef(0);
  const activeIndexRef = useRef(0);
  const currentCategoryRef = useRef(category);
  const playerStateRef = useRef('idle'); // idle, loading, ready, playing, paused
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const loadingPageRef = useRef(false);
  const appVisibleRef = useRef(true);
  const pendingSkipRef = useRef(false);
  const failedVideoIdsRef = useRef(new Set());
  const staleReportRef = useRef(new Set());

  // persistent (device-wide) seen history
  const seenSetRef = useRef(new Set());
  const seenLoadedRef = useRef(false);

  const nextPageTokenRef = useRef(null);
  const hasMoreRef = useRef(true);
  const isLoadingMoreRef = useRef(false);

  // stream metadata cache (bounded, memory only - never persisted)
  const streamCacheRef = useRef(new Map());
  const inflightStreamRef = useRef(new Map());
  const failedStreamsRef = useRef(new Set());

  // thumbnail fade animation per video id
  const thumbAnims = useRef(new Map());

  const videosRef = useRef([]);
  const fetchFeedRef = useRef(null);
  const loadMoreRef = useRef(null);
  const primeWindowRef = useRef(null);
  const skipToIndexRef = useRef(null);
  const settleToIndexRef = useRef(null);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);
  useEffect(() => {
    currentCategoryRef.current = category;
  }, [category]);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  const ensureThumbAnim = useCallback((id) => {
    let v = thumbAnims.current.get(id);
    if (!v) {
      v = new Animated.Value(1);
      thumbAnims.current.set(id, v);
    }
    return v;
  }, []);

  const fadeOutThumb = useCallback((id) => {
    const v = thumbAnims.current.get(id);
    if (v) Animated.timing(v, { toValue: 0, duration: 220, useNativeDriver: true }).start();
  }, []);

  // ---- seen-set helpers ------------------------------------------------------

  const markSeen = useCallback((list) => {
    if (!list || !list.length) return;
    const set = seenSetRef.current;
    list.forEach((v) => { if (v && v.videoId) set.add(v.videoId); });
    if (set.size > SEEN_MAX_IDS) {
      const arr = Array.from(set);
      seenSetRef.current = new Set(arr.slice(arr.length - SEEN_MAX_IDS));
    }
    saveSeen(user.id, seenSetRef.current);
  }, [user.id]);

  const markSeenIds = useCallback((ids) => {
    if (!ids || !ids.length) return;
    const set = seenSetRef.current;
    ids.forEach((id) => { if (id) set.add(id); });
    if (set.size > SEEN_MAX_IDS) {
      const arr = Array.from(set);
      seenSetRef.current = new Set(arr.slice(arr.length - SEEN_MAX_IDS));
    }
    saveSeen(user.id, seenSetRef.current);
  }, [user.id]);

  // ---- stream resolution (Piped, via backend) --------------------------------

  const resolveFor = useCallback((item) => {
    if (!item || !item.videoId || !validateVideoId(item.videoId)) return Promise.resolve(null);
    const id = item.videoId;
    if (failedStreamsRef.current.has(id)) return Promise.resolve(null);
    const cached = streamCacheRef.current.get(id);
    if (cached) {
      setResolved((prev) => (prev.has(id) ? prev : new Map(prev).set(id, cached)));
      return Promise.resolve(cached);
    }
    const inflight = inflightStreamRef.current.get(id);
    if (inflight) return inflight;
    const p = fetch(`${SERVER_URL}/api/piped/streams/${encodeURIComponent(id)}`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`))))
      .then((data) => {
        const source = data && data.source;
        if (!source || !source.url) throw new Error('no playable source');
        const entry = {
          source: { url: source.url, kind: source.kind || 'progressive', height: source.height || 0 },
          audioSource: data.audioSource || null,
        };
        const cache = streamCacheRef.current;
        cache.delete(id);
        cache.set(id, entry);
        if (cache.size > MAX_STREAM_CACHE) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        setResolved((prev) => {
          const next = new Map(prev);
          next.set(id, entry);
          return next;
        });
        return entry;
      })
      .catch(() => {
        failedStreamsRef.current.add(id);
        return null;
      });
    inflightStreamRef.current.set(id, p);
    p.finally(() => inflightStreamRef.current.delete(id)).catch(() => {});
    return p;
  }, [authHeaders]);

  const primeWindow = useCallback((index) => {
    const list = videosRef.current;
    for (let off = -1; off <= 1; off++) {
      const target = list[index + off];
      if (target) resolveFor(target);
    }
  }, [resolveFor]);

  useEffect(() => { primeWindowRef.current = primeWindow; }, [primeWindow]);
  useEffect(() => {
    primeWindow(activeIdx);
  }, [activeIdx, primeWindow]);

  // ---- video error / skip ----------------------------------------------------

  const handleVideoError = useCallback((item, index) => {
    if (!item || !item.videoId) return;
    console.log('[Reels] video error, excluding:', item.videoId);
    failedVideoIdsRef.current.add(item.videoId);
    failedStreamsRef.current.add(item.videoId);
    streamCacheRef.current.delete(item.videoId);
    markSeenIds([item.videoId]);
    staleReportRef.current.add(item.videoId);
    if (index === activeIndexRef.current && skipToIndexRef.current) {
      skipToIndexRef.current(index);
    }
  }, [markSeenIds]);

  const skipToIndex = useCallback((index) => {
    if (pendingSkipRef.current || !isMountedRef.current) return;
    pendingSkipRef.current = true;
    const list = videosRef.current;
    const failed = failedVideoIdsRef.current;
    const seen = seenSetRef.current;
    let target = -1;
    for (let t = index + 1; t < list.length; t++) {
      const id = list[t] && sanitizeVideoId(list[t].videoId);
      if (id && !failed.has(id) && !seen.has(id) && !failedStreamsRef.current.has(id)) { target = t; break; }
    }
    if (target === -1) {
      for (let t = index + 1; t < list.length; t++) {
        if (!failed.has(list[t].videoId)) { target = t; break; }
      }
    }
    if (target >= 0 && flatListRef.current) {
      primeWindowRef.current(target);
      setTimeout(() => {
        try {
          flatListRef.current.scrollToOffset({ offset: target * ITEM_HEIGHT, animated: false });
        } catch (e) {
          try { flatListRef.current.scrollToIndex({ index: target, animated: false }); } catch (e2) {}
        }
        if (settleToIndexRef.current) settleToIndexRef.current(target);
      }, 250);
    } else if (list.length === 0) {
      setToast('No more videos available');
    } else if (loadMoreRef.current) {
      loadMoreRef.current();
    }
  }, []);

  useEffect(() => { skipToIndexRef.current = skipToIndex; }, [skipToIndex]);

  // ---- feed fetching (Piped, seed rotation on refresh) -----------------------

  async function fetchFeedPage(cat, token, refresh) {
    const q = [`category=${encodeURIComponent(cat)}`];
    if (token) q.push(`nextpage=${encodeURIComponent(token)}`);
    if (refresh) q.push('refresh=1');
    const res = await fetch(`${SERVER_URL}/api/piped/feed?${q.join('&')}`, { headers: authHeaders });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load feed');
    return data;
  }

  const fetchFeed = useCallback(async (cat, opts = {}) => {
    const { refresh = false, append = false, pageToken = null } = opts;
    const reqId = ++requestIdRef.current;
    if (loadingPageRef.current) return;
    loadingPageRef.current = true;

    try {
      if (!append) setLoading(true);
      setError(null);

      if (!seenLoadedRef.current) {
        seenSetRef.current = await loadSeen(user.id);
        seenLoadedRef.current = true;
      }

      if (!append && !refresh && !pageToken) {
        const cached = await loadFeedCache(cat);
        if (
          cached && cached.length &&
          reqId === requestIdRef.current && isMountedRef.current &&
          !videosRef.current.length
        ) {
          const fresh = cached.filter((v) => v && v.videoId &&
            !seenSetRef.current.has(v.videoId) &&
            !failedVideoIdsRef.current.has(v.videoId));
          if (fresh.length) {
            videosRef.current = fresh;
            setVideos(fresh);
          }
        }
      }

      let data = await fetchFeedPage(cat, pageToken, refresh);
      if (!isMountedRef.current || reqId !== requestIdRef.current) return;

      let finalVideos = [];
      let cursor = data.nextpage || pageToken || null;
      let hasMore = data.hasMore === true;

      const novel = (list) =>
        (list || []).filter((v) => v && v.videoId && !seenSetRef.current.has(v.videoId) &&
          !failedVideoIdsRef.current.has(v.videoId) &&
          !failedStreamsRef.current.has(v.videoId));

      if (!append && !pageToken) {
        let unseen = novel(data.videos);

        if (!refresh) {
          const savedCursor = await loadCursor(user.id, cat);
          if (savedCursor && savedCursor !== data.nextpage) {
            try {
              const deeper = await fetchFeedPage(cat, savedCursor, false);
              if (!isMountedRef.current || reqId !== requestIdRef.current) return;
              unseen = novel(deeper.videos);
              data = deeper;
              cursor = deeper.nextpage || savedCursor;
              hasMore = deeper.hasMore === true;
            } catch (e) { /* keep page-1 data */ }
          }
        }

        finalVideos = unseen;
        if (finalVideos.length < MIN_FRESH_BATCH && data.nextpage && hasMore) {
          let token = data.nextpage;
          for (let i = 0; i < AUTO_ADVANCE_MAX_PAGES; i++) {
            const p = await fetchFeedPage(cat, token, false);
            if (!isMountedRef.current || reqId !== requestIdRef.current) return;
            finalVideos = [...finalVideos, ...novel(p.videos)];
            cursor = p.nextpage || token;
            hasMore = p.hasMore === true;
            if (finalVideos.length >= MIN_FRESH_BATCH || !hasMore || !p.nextpage) break;
            token = p.nextpage;
          }
        }

        if (finalVideos.length >= 3) {
          finalVideos = finalVideos.slice(0, MAX_LIST_LENGTH);
        } else if (data.videos && data.videos.length) {
          const stillFresh = data.videos.filter((v) => v && v.videoId &&
            !seenSetRef.current.has(v.videoId) && !failedVideoIdsRef.current.has(v.videoId));
          finalVideos = (stillFresh.length ? stillFresh : data.videos.filter((v) => v && v.videoId)).slice(0, MAX_LIST_LENGTH);
        }
      } else {
        finalVideos = (data.videos || []).filter((v) => v && v.videoId);
        cursor = data.nextpage || pageToken || null;
        hasMore = data.hasMore === true;
      }

      if (cursor) await saveCursor(user.id, cat, cursor);

      if (!append) {
        videosRef.current = finalVideos;
        setVideos(finalVideos);
        markSeen(finalVideos);
        failedVideoIdsRef.current.clear();
        failedStreamsRef.current.clear();
        nextPageTokenRef.current = cursor;
        hasMoreRef.current = hasMore && !!cursor;

        activeIndexRef.current = 0;
        setActiveIdx(0);
        setActivePaused(false);
        scrollOffsetYRef.current = 0;
        if (flatListRef.current) flatListRef.current.scrollToOffset({ offset: 0, animated: false });
        playerStateRef.current = 'idle';
        primeWindowRef.current(finalVideos.length ? 0 : -1);
        if (!refresh && finalVideos.length) saveFeedCache(cat, finalVideos.slice(0, 20));
        console.log('[Reels] Feed ready:', cat, finalVideos.length);
      } else {
        setVideos((prev) => {
          const ids = new Set(prev.map((v) => v.videoId));
          const fresh = finalVideos.filter((v) => !ids.has(v.videoId));
          const merged = [...prev, ...fresh];
          videosRef.current = merged;
          return merged;
        });
        markSeen(finalVideos);
      }
    } catch (e) {
      if (!isMountedRef.current || reqId !== requestIdRef.current) return;
      console.warn('[Reels] feed error:', e.message);
      if (!append || !videosRef.current.length) {
        setError(e.message);
        setToast(e.message);
      } else {
        setToast(e.message);
      }
    } finally {
      if (isMountedRef.current && reqId === requestIdRef.current) {
        setLoading(false);
        loadingPageRef.current = false;
      }
    }
  }, [authHeaders, user.id]);

useEffect(() => { fetchFeedRef.current = fetchFeed; }, [fetchFeed]);

const loadMore = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRef.current || loadingPageRef.current) return;
    const token = nextPageTokenRef.current;
    if (!token) return;
    isLoadingMoreRef.current = true;
    loadingPageRef.current = true;
    const currentCategory = currentCategoryRef.current;
    try {
      const data = await fetchFeedPage(currentCategory, token, false);
      if (!isMountedRef.current) return;
      const valid = (data.videos || []).filter((v) => v && v.videoId &&
        !failedVideoIdsRef.current.has(v.videoId) &&
        !failedStreamsRef.current.has(v.videoId) &&
        !seenSetRef.current.has(v.videoId));
      let merged;
      setVideos((prev) => {
        const ids = new Set(prev.map((v) => v.videoId));
        const fresh = valid.filter((v) => !ids.has(v.videoId));
        merged = [...prev, ...fresh].slice(0, MAX_LIST_LENGTH);
        videosRef.current = merged;
        return merged;
      });
      if (valid.length) markSeen(valid);
      const cursor = data.nextpage || token;
      nextPageTokenRef.current = cursor;
      hasMoreRef.current = data.hasMore === true && !!cursor;
      if (cursor) await saveCursor(user.id, currentCategory, cursor);
    } catch (e) {
      console.warn('[Reels] loadMore failed:', e.message);
    } finally {
      if (isMountedRef.current) {
        loadingPageRef.current = false;
        isLoadingMoreRef.current = false;
      }
    }
  }, [authHeaders, user.id, markSeen]);

  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);

  // ---- categories ------------------------------------------------------------

  useEffect(() => {
    fetch(`${SERVER_URL}/api/piped/categories`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((d) => { if (Array.isArray(d.categories) && d.categories.length) setCategories(d.categories); })
      .catch(() => {});
  }, [authHeaders]);

  // ---- actions ---------------------------------------------------------------

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(LIKES_STORAGE_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) setLikedIds(new Set(arr.filter((x) => typeof x === 'string')));
        }
      } catch (e) {}
    })();
  }, []);

  const toggleLike = useCallback((id) => {
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try { AsyncStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(Array.from(next))); } catch (e) {}
      return next;
    });
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
  }, []);

  const shareVideo = useCallback((item) => {
    if (!item || !item.videoId) return;
    RNShare.share({ message: `${item.title || 'Check this out'}\nhttps://youtube.com/shorts/${item.videoId}` }).catch(() => {});
  }, []);

  const reportVideo = useCallback((item) => {
    if (!item || !item.videoId) return;
    Alert.alert('Report video', 'Report this reel as unavailable or inappropriate?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: async () => {
          try {
            await fetch(`${SERVER_URL}/api/reels/report`, {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({ videoIds: [item.videoId] }),
            });
            setToast('Reported');
          } catch (e) {}
        },
      },
    ]);
  }, [authHeaders]);

  // Queue broken-reel ids for the server to exclude from cached feeds.
  useEffect(() => {
    const iv = setInterval(async () => {
      if (!staleReportRef.current.size) return;
      const ids = Array.from(staleReportRef.current);
      staleReportRef.current.clear();
      try {
        await fetch(`${SERVER_URL}/api/reels/report`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ videoIds: ids }),
        });
      } catch (e) {}
    }, 10000);
    return () => clearInterval(iv);
  }, [authHeaders]);

  // ---- scroll / settle --------------------------------------------------------

  const settleToIndex = useCallback((index) => {
    const list = videosRef.current;
    if (index < 0 || index >= list.length) return;
    activeIndexRef.current = index;
    pendingSkipRef.current = false;
    scrollOffsetYRef.current = index * ITEM_HEIGHT;
    setActiveIdx(index);
    setActivePaused(false);
  }, []);

  useEffect(() => { settleToIndexRef.current = settleToIndex; }, [settleToIndex]);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    if (!viewableItems || !viewableItems.length) return;
    const newIndex = viewableItems[0].index;
    if (newIndex == null) return;
    if (newIndex >= videosRef.current.length - 3 && loadMoreRef.current) {
      loadMoreRef.current();
    }
  }, []);

  const onMomentumScrollEnd = useCallback((event) => {
    const y = event.nativeEvent.contentOffset.y;
    const settledIndex = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / ITEM_HEIGHT)));
    settleToIndex(settledIndex);
  }, [settleToIndex]);

  const onScroll = useCallback((event) => {
    scrollOffsetYRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const onScrollEndDrag = useCallback(() => {
    setTimeout(() => {
      if (!isMountedRef.current) return;
      const y = scrollOffsetYRef.current;
      const settledIndex = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / ITEM_HEIGHT)));
      if (settledIndex !== activeIndexRef.current && Math.abs(y - settledIndex * ITEM_HEIGHT) < 8) {
        settleToIndex(settledIndex);
      }
    }, 320);
  }, [settleToIndex]);

  const viewabilityConfig = useMemo(() => ({
    itemVisiblePercentThreshold: 75,
    minimumViewTime: 100,
  }), []);

  const viewabilityConfigCallbackPairs = useMemo(() => [
    { viewabilityConfig, onViewableItemsChanged },
  ], [viewabilityConfig, onViewableItemsChanged]);

  // ---- tap to pause / resume --------------------------------------------------

  const touchStartYRef = useRef(0);
  const touchStartXRef = useRef(0);
  const touchStartTimeRef = useRef(0);

  const onTouchStart = useCallback((event) => {
    touchStartYRef.current = event.nativeEvent?.pageY ?? 0;
    touchStartXRef.current = event.nativeEvent?.pageX ?? 0;
    touchStartTimeRef.current = Date.now();
  }, []);

  const onTouchEnd = useCallback((event) => {
    const touchEndY = event.nativeEvent?.pageY ?? 0;
    const touchEndX = event.nativeEvent?.pageX ?? 0;
    const deltaY = Math.abs(touchEndY - touchStartYRef.current);
    const deltaX = Math.abs(touchEndX - touchStartXRef.current);
    const deltaTime = Date.now() - touchStartTimeRef.current;
    // Ignore chips/back row (top ~120px) and the right action rail (~96px).
    if (deltaX < 15 && deltaY < 15 && deltaTime < 300 &&
        touchStartYRef.current > 120 && touchStartXRef.current < SCREEN_W - 96) {
      setActivePaused((p) => !p);
    }
  }, []);

  // ---- lifecycle --------------------------------------------------------------

  useEffect(() => {
    isMountedRef.current = true;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const isActive = nextState === 'active';
      const wasActive = appVisibleRef.current;
      appVisibleRef.current = isActive;
      if (isActive && !wasActive) {
        setActivePaused(false); // restore active video
      } else if (!isActive) {
        setActivePaused(true); // pause all on background
      }
    });
    return () => {
      isMountedRef.current = false;
      subscription.remove();
      streamCacheRef.current.clear();
      inflightStreamRef.current.clear();
      thumbAnims.current.clear();
    };
  }, []);

  // Initial feed load + category changes (seed rotation server-side per session).
  useEffect(() => {
    if (isMountedRef.current) {
      requestIdRef.current += 1;
      loadingPageRef.current = false;
      isLoadingMoreRef.current = false;
      nextPageTokenRef.current = null;
      hasMoreRef.current = true;
      setVideos([]);
      videosRef.current = [];
      setResolved(new Map());
      failedStreamsRef.current.clear();
      streamCacheRef.current.clear();
      setActivePaused(false);
      if (fetchFeedRef.current) fetchFeedRef.current(category, { refresh: false });
    }
  }, [category]);

  // Reels nav icon tapped while already inside Reels -> fresh content.
  const prevRefreshTickRef = useRef(0);
  useEffect(() => {
    if (!refreshTick || refreshTick === prevRefreshTickRef.current) return;
    prevRefreshTickRef.current = refreshTick;
    if (fetchFeedRef.current) fetchFeedRef.current(currentCategoryRef.current, { refresh: true });
  }, [refreshTick]);

  // ---- render ------------------------------------------------------------------

  if (loading && !videos.length) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (error && !videos.length) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.errorContainer}>
          <Icon name="alert-circle" size={48} color={theme.danger} />
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          <TouchableOpacity
            onPress={() => fetchFeedRef.current && fetchFeedRef.current(currentCategoryRef.current, { refresh: true })}
            style={[styles.retryBtn, { backgroundColor: theme.primary }]}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const activeItem = videos[activeIdx];

  const renderItem = ({ item, index }) => {
    const isActive = index === activeIdx;
    const inWindow = Math.abs(index - activeIdx) <= 1;
    const res = resolved.get(item.videoId);
    const hasVideo = inWindow && !!res && !!res.source;
    const thumbAnim = ensureThumbAnim(item.videoId);
    const thumb = thumbnailUrlFor(item);
    const mt = hasVideo ? mediaType(res.source.kind) : undefined;
    return (
      <View style={styles.videoContainer}>
        <Image source={{ uri: thumb }} style={styles.thumbImage} resizeMode="cover" />
        {hasVideo ? (
          <Video
            key={item.videoId}
            source={{ uri: res.source.url, ...(mt ? { type: mt } : {}) }}
            style={styles.video}
            resizeMode="cover"
            paused={!isActive || activePaused}
            muted={muted || !isActive}
            repeat
            playInBackground={false}
            onLoad={() => fadeOutThumb(item.videoId)}
            onError={() => handleVideoError(item, index)}
          />
        ) : null}
        <Animated.View style={[styles.thumbOverlay, { opacity: thumbAnim }]} pointerEvents="none">
          <Image source={{ uri: thumb }} style={styles.thumbImage} resizeMode="cover" />
        </Animated.View>
      </View>
    );
  };

  return (
    <View
      style={[styles.container, { backgroundColor: '#000' }]}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <FlatList
        ref={flatListRef}
        data={videos}
        keyExtractor={(item) => item.videoId}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScrollEndDrag={onScrollEndDrag}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        getItemLayout={(data, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={7}
        removeClippedSubviews={false}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="video-outline" size={52} color={theme.primaryLight} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              {toast || 'No videos available right now'}
            </Text>
            {toast && (
              <TouchableOpacity
                onPress={() => fetchFeedRef.current && fetchFeedRef.current(currentCategoryRef.current, { refresh: true })}
                style={[styles.retryBtn, { backgroundColor: theme.primary, marginTop: 16 }]}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />

      {toast && <Toast message={toast} onDismiss={() => setToast('')} />}

      {/* Top-left back button */}
      <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityLabel="Back to chats">
        <Icon name="chevron-back" size={26} color="#fff" />
      </TouchableOpacity>

      {/* Category chips row */}
      {categories.length > 0 && (
        <View style={styles.chipsWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsContent}
          >
            {categories.map((c) => {
              const selected = c.id === category;
              return (
                <TouchableOpacity
                  key={c.id}
                  onPress={() => setCategory(c.id)}
                  style={[
                    styles.chip,
                    selected ? { backgroundColor: theme.primary } : { backgroundColor: 'rgba(15,15,15,0.55)' },
                  ]}
                >
                  <Text style={[styles.chipText, selected ? { color: '#fff', fontWeight: '800' } : { color: '#eee' }]}>
                    {c.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* YT-style right action rail */}
      {activeItem && sanitizeVideoId(activeItem.videoId) ? (
        <View style={styles.railWrap} pointerEvents="box-none">
          <View style={styles.railAvatar} pointerEvents="none">
            <Icon name="person" size={24} color="#fff" />
          </View>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={() => toggleLike(activeItem.videoId)}
            accessibilityLabel={likedIds.has(activeItem.videoId) ? 'Unlike' : 'Like'}
          >
            <Icon name={likedIds.has(activeItem.videoId) ? 'heart' : 'heart-outline'} size={30} color={likedIds.has(activeItem.videoId) ? '#FF2C55' : '#fff'} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => shareVideo(activeItem)} accessibilityLabel="Share reel">
            <Icon name="share-social" size={27} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={toggleMute} accessibilityLabel={muted ? 'Unmute' : 'Mute'}>
            <Icon name={muted ? 'volume-mute' : 'volume-high'} size={27} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => reportVideo(activeItem)} accessibilityLabel="More options">
            <Icon name="ellipsis-horizontal" size={25} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Caption overlay */}
      {activeItem ? (
        <View style={styles.caption} pointerEvents="none">
          <View style={styles.captionChannelRow}>
            <View style={styles.captionAvatar} pointerEvents="none">
              <Icon name="person" size={13} color="#fff" />
            </View>
            <Text numberOfLines={1} style={styles.captionChannel}>{activeItem.channelTitle || 'Tojey'}</Text>
          </View>
          <Text numberOfLines={2} style={styles.captionTitle}>{activeItem.title || ''}</Text>
          <Text numberOfLines={1} style={styles.captionMeta}>
            {activeItem.durationSeconds ? `${Math.round(activeItem.durationSeconds)}s` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  videoContainer: {
    width: SCREEN_W,
    height: ITEM_HEIGHT,
    backgroundColor: '#000',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  thumbOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  chipsWrap: {
    position: 'absolute',
    top: 26,
    left: 56,
    right: 0,
    zIndex: 52,
  },
  chipsContent: {
    paddingRight: 16,
  },
  chip: {
    paddingHorizontal: fs(14),
    paddingVertical: fs(7),
    borderRadius: fs(18),
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: fs(13),
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: fs(15),
    marginTop: 12,
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  errorText: {
    fontSize: fs(15),
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: fs(24),
    paddingVertical: fs(10),
    borderRadius: fs(10),
  },
  backBtn: {
    position: 'absolute',
    top: 26,
    left: 12,
    zIndex: 50,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  railWrap: {
    position: 'absolute',
    right: 10,
    top: '42%',
    zIndex: 48,
    alignItems: 'center',
    gap: 18,
  },
  railAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(15,15,15,0.55)',
    borderWidth: 1.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  railBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(15,15,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    position: 'absolute',
    left: 14,
    right: 92,
    bottom: 20,
    zIndex: 45,
  },
  captionChannelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  captionAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
  },
  captionChannel: {
    color: '#fff',
    fontSize: fs(14),
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
  captionTitle: {
    color: '#fff',
    fontSize: fs(14),
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
  captionMeta: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fs(12),
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
});