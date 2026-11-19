import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Modal,
} from 'react-native';
import Video from 'react-native-video';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { SERVER_URL } from '../config';
import { getProxyPlayback } from '../services/ytPlayback';
import { getRecommendationSeeds, getWatchedVideoIds, recordWatched } from '../services/recommendation';
import Toast from '../components/Toast';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const STORAGE_KEY_SEEN = '@tojey_reels_seen_v2';
const REEL_CYCLE_SIZE = 50;
const SEEN_MAX_IDS = 200;
const MAX_STREAM_CACHE = 12;
const LIKES_STORAGE_KEY = '@tojey_reels_likes';
const QUALITY_STORAGE_KEY = '@tojey_reels_quality';
const SPEED_STORAGE_KEY = '@tojey_reels_speed';

const QUALITY_OPTIONS = [
  { label: 'Auto', value: 'auto', maxHeight: 1080 },
  { label: '1080p', value: '1080', maxHeight: 1080 },
  { label: '720p', value: '720', maxHeight: 720 },
  { label: '480p', value: '480', maxHeight: 480 },
  { label: '360p', value: '360', maxHeight: 360 },
];

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const ITEM_HEIGHT = SCREEN_H;

function validateVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return false;
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId.trim());
}

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  return validateVideoId(trimmed) ? trimmed : null;
}

function thumbnailUrlFor(item) {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) {
    return item.thumbnailUrl.trim();
  }
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg` : '';
}

function mediaType(kind) {
  if (kind === 'hls') return 'm3u8';
  if (kind === 'dash') return 'mpd';
  if (kind === 'progressive') return 'mp4';
  return undefined;
}

function maxHeightFor(value) {
  const found = QUALITY_OPTIONS.find((q) => q.value === value);
  return found ? found.maxHeight : 1080;
}

const keyExtractor = (item) => item.videoId;

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
    await AsyncStorage.setItem(`${STORAGE_KEY_SEEN}/${userId}`, JSON.stringify(Array.from(set)));
  } catch (e) {
    console.warn('[Reels] Failed to save seen set:', e);
  }
}

async function loadPreference(key, fallback) {
  try {
    const value = await AsyncStorage.getItem(key);
    return value || fallback;
  } catch (e) {
    return fallback;
  }
}

async function savePreference(key, value) {
  try {
    await AsyncStorage.setItem(key, String(value));
  } catch (e) {}
}

export default function ReelsScreen({ token, user, refreshTick = 0, onBack }) {
  const { theme } = useTheme();
  const category = 'trending';
  const [activeIdx, setActiveIdx] = useState(0);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');
  const [cycleId, setCycleId] = useState(null);
  const [likedIds, setLikedIds] = useState(() => new Set());
  const [muted, setMuted] = useState(false);
  const [activePaused, setActivePaused] = useState(false);
  const [resolved, setResolved] = useState(() => new Map());
  const [quality, setQuality] = useState('auto');
  const [speed, setSpeed] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const mutedRef = useRef(false);
  const flatListRef = useRef(null);
  const activeIndexRef = useRef(0);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const loadingRef = useRef(false);
  const appVisibleRef = useRef(true);
  const pendingSkipRef = useRef(false);
  const failedVideoIdsRef = useRef(new Set());
  const staleReportRef = useRef(new Set());
  const lastRecordedRef = useRef(null);
  const seenSetRef = useRef(new Set());
  const seenLoadedRef = useRef(false);
  const qualityRef = useRef('auto');
  const speedRef = useRef(1);
  const streamCacheRef = useRef(new Map());
  const inflightStreamRef = useRef(new Map());
  const failedStreamsRef = useRef(new Set());
  const playErrorTriesRef = useRef(new Map());
  const thumbAnims = useRef(new Map());
  const videosRef = useRef([]);
  const fetchCycleRef = useRef(null);
  const primeWindowRef = useRef(null);
  const skipToIndexRef = useRef(null);
  const settleToIndexRef = useRef(null);
  const prevRefreshTickRef = useRef(refreshTick);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  useEffect(() => { videosRef.current = videos; }, [videos]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      loadPreference(QUALITY_STORAGE_KEY, 'auto'),
      loadPreference(SPEED_STORAGE_KEY, '1'),
    ]).then(([savedQuality, savedSpeed]) => {
      if (!alive) return;
      const nextQuality = QUALITY_OPTIONS.some((q) => q.value === savedQuality) ? savedQuality : 'auto';
      const parsedSpeed = Number(savedSpeed);
      const nextSpeed = SPEED_OPTIONS.includes(parsedSpeed) ? parsedSpeed : 1;
      qualityRef.current = nextQuality;
      speedRef.current = nextSpeed;
      setQuality(nextQuality);
      setSpeed(nextSpeed);
    });
    return () => { alive = false; };
  }, []);

  const ensureThumbAnim = useCallback((id) => {
    let value = thumbAnims.current.get(id);
    if (!value) {
      value = new Animated.Value(1);
      thumbAnims.current.set(id, value);
    }
    return value;
  }, []);

  const fadeOutThumb = useCallback((id) => {
    const value = thumbAnims.current.get(id);
    if (value) Animated.timing(value, { toValue: 0, duration: 220, useNativeDriver: true }).start();
  }, []);

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

  const resolveFor = useCallback((item, opts = {}) => {
    if (!item || !item.videoId || !validateVideoId(item.videoId)) return Promise.resolve(null);
    const id = item.videoId;
    if (!opts.retry && failedStreamsRef.current.has(id)) return Promise.resolve(null);

    const cached = opts.retry ? null : streamCacheRef.current.get(id);
    if (cached) {
      setResolved((prev) => (prev.has(id) ? prev : new Map(prev).set(id, cached)));
      return Promise.resolve(cached);
    }

    const inflight = opts.retry ? null : inflightStreamRef.current.get(id);
    if (inflight) return inflight;

    const promise = (async () => {
      const playback = await getProxyPlayback(id, token, {
        maxHeight: maxHeightFor(qualityRef.current),
        skipCache: opts.retry === true,
        retry: opts.retry === true,
      });
      let url = playback.videoUrl;
      if (opts.retry) url += `${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
      const entry = {
        source: { url, kind: 'progressive', height: playback.height || 0 },
        itag: playback.itag,
        via: playback.source,
      };
      const cache = streamCacheRef.current;
      cache.delete(id);
      cache.set(id, entry);
      if (cache.size > MAX_STREAM_CACHE) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      setResolved((prev) => new Map(prev).set(id, entry));
      return entry;
    })();

    if (!opts.retry) {
      inflightStreamRef.current.set(id, promise);
      promise.finally(() => inflightStreamRef.current.delete(id)).catch(() => {});
    }
    return promise;
  }, [token]);

  const primeWindow = useCallback((index) => {
    const list = videosRef.current;
    [0, 1].forEach((offset) => {
      const target = list[index + offset];
      if (target) resolveFor(target);
    });
  }, [resolveFor]);

  useEffect(() => { primeWindowRef.current = primeWindow; }, [primeWindow]);
  useEffect(() => { primeWindow(activeIdx); }, [activeIdx, primeWindow]);

  const handleVideoError = useCallback((item, index, payload) => {
    if (!item || !item.videoId) return;
    const detail = payload && payload.error
      ? `code=${payload.error.code}${payload.error.message ? ` msg=${payload.error.message}` : ''}`
      : 'no error payload';
    const id = item.videoId;
    const tries = playErrorTriesRef.current.get(id) || 0;

    if (tries < 2) {
      playErrorTriesRef.current.set(id, tries + 1);
      streamCacheRef.current.delete(id);
      inflightStreamRef.current.delete(id);
      console.log(`[Reels] video error, re-resolving (${tries + 1}/2):`, id, detail);
      resolveFor(item, { retry: true }).then((entry) => {
        if (entry) playErrorTriesRef.current.set(id, 0);
      }).catch(() => {});
      return;
    }

    console.log('[Reels] video error after retries, excluding:', id, detail);
    playErrorTriesRef.current.set(id, 0);
    failedVideoIdsRef.current.add(id);
    failedStreamsRef.current.add(id);
    streamCacheRef.current.delete(id);
    markSeenIds([id]);
    staleReportRef.current.add(id);
    if (index === activeIndexRef.current && skipToIndexRef.current) skipToIndexRef.current(index);
  }, [markSeenIds, resolveFor]);

  const skipToIndex = useCallback((index) => {
    if (pendingSkipRef.current || !isMountedRef.current) return;
    pendingSkipRef.current = true;
    const list = videosRef.current;
    const failed = failedVideoIdsRef.current;
    const seen = seenSetRef.current;
    let target = -1;
    for (let t = index + 1; t < list.length; t += 1) {
      const id = list[t] && sanitizeVideoId(list[t].videoId);
      if (id && !failed.has(id) && !seen.has(id) && !failedStreamsRef.current.has(id)) {
        target = t;
        break;
      }
    }
    if (target === -1) {
      for (let t = index + 1; t < list.length; t += 1) {
        if (!failed.has(list[t].videoId)) {
          target = t;
          break;
        }
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
      return;
    }
    pendingSkipRef.current = false;
    if (index >= list.length - 1) setToast('You reached the end of this 50-reel cycle');
  }, []);

  useEffect(() => { skipToIndexRef.current = skipToIndex; }, [skipToIndex]);

  const fetchCycle = useCallback(async (opts = {}) => {
    const requestId = ++requestIdRef.current;
    if (loadingRef.current) return;
    loadingRef.current = true;

    const hasList = videosRef.current.length > 0;
    if (hasList) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      if (!seenLoadedRef.current) {
        seenSetRef.current = await loadSeen(user.id);
        seenLoadedRef.current = true;
      }

      const [seedsResult, watchedResult] = await Promise.allSettled([
        getRecommendationSeeds(8),
        getWatchedVideoIds(250),
      ]);
      const seeds = seedsResult.status === 'fulfilled' && Array.isArray(seedsResult.value)
        ? seedsResult.value.slice(0, 8)
        : [];
      const watched = watchedResult.status === 'fulfilled' && Array.isArray(watchedResult.value)
        ? watchedResult.value
        : [];
      const exclude = Array.from(new Set([
        ...watched,
        ...seenSetRef.current,
        ...failedVideoIdsRef.current,
        ...failedStreamsRef.current,
      ])).slice(-300);
      const nonce = opts.nonce || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const response = await fetch(`${SERVER_URL}/api/shorts/refresh`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ category, seeds, exclude, nonce, requestId: nonce }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.detail || 'Failed to refresh reels');

      const ids = new Set();
      const unique = [];
      for (const raw of (Array.isArray(data.items) ? data.items : [])) {
        const id = sanitizeVideoId(raw && raw.videoId);
        if (!id || ids.has(id)) continue;
        if (failedVideoIdsRef.current.has(id) || failedStreamsRef.current.has(id)) continue;
        ids.add(id);
        unique.push({ ...raw, videoId: id });
        if (unique.length >= REEL_CYCLE_SIZE) break;
      }
      if (!unique.length) throw new Error(data.message || 'No reels available right now');

      videosRef.current = unique;
      setVideos(unique);
      setCycleId(data.cycleId || null);
      failedVideoIdsRef.current.clear();
      failedStreamsRef.current.clear();
      playErrorTriesRef.current.clear();
      streamCacheRef.current.clear();
      inflightStreamRef.current.clear();
      setResolved(new Map());
      thumbAnims.current.clear();

      activeIndexRef.current = 0;
      setActiveIdx(0);
      setActivePaused(false);
      pendingSkipRef.current = false;
      scrollOffsetReset();
      if (primeWindowRef.current) primeWindowRef.current(0);
      if (data.message) setToast(data.message);
    } catch (e) {
      if (!isMountedRef.current || requestId !== requestIdRef.current) return;
      console.warn('[Reels] cycle error:', e.message);
      if (!videosRef.current.length) {
        setError(e.message);
        setToast(e.message);
      } else {
        setToast(e.message);
      }
    } finally {
      if (isMountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingRef.current = false;
      }
    }
  }, [authHeaders, user.id]);

  function scrollOffsetReset() {
    if (flatListRef.current) {
      try { flatListRef.current.scrollToOffset({ offset: 0, animated: false }); } catch (e) {}
    }
  }

  useEffect(() => { fetchCycleRef.current = fetchCycle; }, [fetchCycle]);

  const refreshCycle = useCallback(() => {
    if (refreshing) return;
    if (fetchCycleRef.current) fetchCycleRef.current({ nonce: `refresh-${Date.now()}` });
  }, [refreshing]);

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
            const response = await fetch(`${SERVER_URL}/api/reels/report`, {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({ videoIds: [item.videoId] }),
            });
            if (!response.ok) throw new Error(`report ${response.status}`);
            setToast('Reported');
          } catch (e) {
            setToast('Could not report this reel');
          }
        },
      },
    ]);
  }, [authHeaders]);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!staleReportRef.current.size) return;
      const ids = Array.from(staleReportRef.current);
      try {
        const response = await fetch(`${SERVER_URL}/api/reels/report`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ videoIds: ids }),
        });
        if (response.ok) staleReportRef.current.clear();
      } catch (e) {}
    }, 10000);
    return () => clearInterval(interval);
  }, [authHeaders]);

  const settleToIndex = useCallback((index) => {
    const list = videosRef.current;
    if (index < 0 || index >= list.length) return;
    activeIndexRef.current = index;
    pendingSkipRef.current = false;
    setActiveIdx(index);
    setActivePaused(false);
  }, []);

  useEffect(() => { settleToIndexRef.current = settleToIndex; }, [settleToIndex]);

  const onMomentumScrollEnd = useCallback((event) => {
    const y = event.nativeEvent.contentOffset.y;
    const settledIndex = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / ITEM_HEIGHT)));
    settleToIndex(settledIndex);
  }, [settleToIndex]);

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
    if (settingsOpen) return;
    if (deltaX < 15 && deltaY < 15 && deltaTime < 300 &&
        touchStartYRef.current > 120 && touchStartXRef.current < SCREEN_W - 96) {
      setActivePaused((p) => !p);
    }
  }, [settingsOpen]);

  useEffect(() => {
    isMountedRef.current = true;
    const subscription = AppState.addEventListener('change', (nextState) => {
      const isActive = nextState === 'active';
      const wasActive = appVisibleRef.current;
      appVisibleRef.current = isActive;
      if (isActive && !wasActive) setActivePaused(false);
      else if (!isActive) setActivePaused(true);
    });
    return () => {
      isMountedRef.current = false;
      subscription.remove();
      streamCacheRef.current.clear();
      inflightStreamRef.current.clear();
      thumbAnims.current.clear();
    };
  }, []);

  useEffect(() => {
    if (isMountedRef.current) {
      requestIdRef.current += 1;
      loadingRef.current = false;
      setVideos([]);
      videosRef.current = [];
      setResolved(new Map());
      streamCacheRef.current.clear();
      inflightStreamRef.current.clear();
      failedStreamsRef.current.clear();
      setActivePaused(false);
      if (fetchCycleRef.current) fetchCycleRef.current({ nonce: `open-${Date.now()}` });
    }
  }, []);

  useEffect(() => {
    const item = videos[activeIdx];
    if (!item || !validateVideoId(item.videoId)) return;
    if (lastRecordedRef.current === item.videoId) return;
    lastRecordedRef.current = item.videoId;
    markSeenIds([item.videoId]);
    recordWatched({
      videoId: item.videoId,
      title: item.title || '',
      channelTitle: item.channelTitle || '',
    }).catch(() => {});
  }, [activeIdx, videos, markSeenIds]);

  useEffect(() => {
    if (!refreshTick || refreshTick === prevRefreshTickRef.current) return;
    prevRefreshTickRef.current = refreshTick;
    if (fetchCycleRef.current) fetchCycleRef.current({ nonce: `tick-${refreshTick}-${Date.now()}` });
  }, [refreshTick]);

  const selectQuality = useCallback((option) => {
    qualityRef.current = option.value;
    setQuality(option.value);
    savePreference(QUALITY_STORAGE_KEY, option.value);
    setSettingsOpen(false);
    setResolved(new Map());
    streamCacheRef.current.clear();
    inflightStreamRef.current.clear();
    const item = videosRef.current[activeIndexRef.current];
    if (item) resolveFor(item, { retry: true }).catch(() => {});
  }, [resolveFor]);

  const selectSpeed = useCallback((value) => {
    speedRef.current = value;
    setSpeed(value);
    savePreference(SPEED_STORAGE_KEY, value);
    setSettingsOpen(false);
  }, []);

  const activeItem = videos[activeIdx];
  const activeResolution = activeItem && resolved.get(activeItem.videoId)
    ? resolved.get(activeItem.videoId).source.height
    : 0;

  const renderItem = useCallback(({ item, index }) => {
    const isActive = index === activeIdx;
    const inWindow = Math.abs(index - activeIdx) <= 1;
    const res = resolved.get(item.videoId);
    const hasVideo = inWindow && !!res && !!res.source;
    const thumbAnim = ensureThumbAnim(item.videoId);
    const mt = hasVideo ? mediaType(res.source.kind) : undefined;
    return (
      <View style={styles.videoContainer}>
        {hasVideo ? (
          <Video
            key={`${item.videoId}-${quality}-${res.itag}`}
            source={{ uri: res.source.url, ...(mt ? { type: mt } : {}) }}
            style={styles.video}
            resizeMode="cover"
            paused={!isActive || activePaused}
            muted={muted || !isActive}
            rate={speed}
            repeat
            playInBackground={false}
            onLoad={() => { playErrorTriesRef.current.delete(item.videoId); fadeOutThumb(item.videoId); }}
            onReadyForDisplay={() => fadeOutThumb(item.videoId)}
            onError={(payload) => handleVideoError(item, index, payload)}
          />
        ) : null}
        <Animated.View style={[styles.thumbOverlay, { opacity: thumbAnim }]} pointerEvents="none">
          <Image source={{ uri: thumbnailUrlFor(item) }} style={styles.thumbImage} resizeMode="cover" />
        </Animated.View>
      </View>
    );
  }, [activeIdx, activePaused, muted, quality, resolved, speed, ensureThumbAnim, fadeOutThumb, handleVideoError]);

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
          <TouchableOpacity onPress={refreshCycle} style={[styles.retryBtn, { backgroundColor: theme.primary }]}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

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
        keyExtractor={keyExtractor}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        showsVerticalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumScrollEnd}
        getItemLayout={(data, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        updateCellsBatchingPeriod={30}
        windowSize={3}
        removeClippedSubviews={false}
        renderItem={renderItem}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="video-outline" size={52} color={theme.primaryLight} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              {toast || 'No videos available right now'}
            </Text>
            <TouchableOpacity onPress={refreshCycle} style={[styles.retryBtn, { backgroundColor: theme.primary, marginTop: 16 }]}>
              <Text style={{ color: '#fff', fontWeight: '600' }}>Refresh Reels</Text>
            </TouchableOpacity>
          </View>
        }
      />

      {toast && <Toast message={toast} onDismiss={() => setToast('')} />}

      <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityLabel="Back to chats">
        <Icon name="chevron-back" size={26} color="#fff" />
      </TouchableOpacity>

      {videos.length > 0 && (
        <View style={styles.cycleBadge} pointerEvents="none">
          <Text style={styles.cycleText}>{activeIdx + 1}/{videos.length}</Text>
        </View>
      )}

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
            <Icon
              name={likedIds.has(activeItem.videoId) ? 'heart' : 'heart-outline'}
              size={30}
              color={likedIds.has(activeItem.videoId) ? '#FF2C55' : '#fff'}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => shareVideo(activeItem)} accessibilityLabel="Share reel">
            <Icon name="share-social" size={27} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={toggleMute} accessibilityLabel={muted ? 'Unmute' : 'Mute'}>
            <Icon name={muted ? 'volume-mute' : 'volume-high'} size={27} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => setSettingsOpen(true)} accessibilityLabel="Video settings">
            <Icon name="settings-outline" size={26} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.railBtn} onPress={() => reportVideo(activeItem)} accessibilityLabel="More options">
            <Icon name="ellipsis-horizontal" size={25} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}

      {activeIdx === videos.length - 1 && videos.length > 0 ? (
        <TouchableOpacity onPress={refreshCycle} disabled={refreshing} style={styles.refreshReelsBtn}>
          <Icon name="refresh-outline" size={18} color="#fff" />
          <Text style={styles.refreshReelsText}>{refreshing ? 'Refreshing...' : 'Refresh Reels'}</Text>
        </TouchableOpacity>
      ) : null}

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

      <Modal
        visible={settingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setSettingsOpen(false)}>
          <View style={[styles.settingsSheet, { backgroundColor: theme.surface || '#1E1A27' }]} onStartShouldSetResponder={() => true}>
            <Text style={[styles.settingsTitle, { color: theme.text || '#fff' }]}>Video settings</Text>
            <Text style={[styles.settingsSection, { color: theme.textSecondary || '#B9B3C6' }]}>
              Quality{activeResolution ? ` (current ${activeResolution}p)` : ''}
            </Text>
            <View style={styles.optionRow}>
              {QUALITY_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option.value}
                  onPress={() => selectQuality(option)}
                  style={[styles.optionChip, { borderColor: quality === option.value ? theme.primary : '#443E52' }]}
                >
                  <Text style={[styles.optionText, { color: quality === option.value ? theme.primary : '#fff' }]}>{option.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={[styles.settingsSection, { color: theme.textSecondary || '#B9B3C6' }]}>Speed</Text>
            <View style={styles.optionRow}>
              {SPEED_OPTIONS.map((option) => (
                <TouchableOpacity
                  key={option}
                  onPress={() => selectSpeed(option)}
                  style={[styles.optionChip, { borderColor: speed === option ? theme.primary : '#443E52' }]}
                >
                  <Text style={[styles.optionText, { color: speed === option ? theme.primary : '#fff' }]}>{option}x</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.settingsHint}>Cycle {cycleId ? 'ready' : 'loading'} - {REEL_CYCLE_SIZE} reels per refresh</Text>
          </View>
        </TouchableOpacity>
      </Modal>
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
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: fs(15),
    marginTop: 12,
    textAlign: 'center',
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
  cycleBadge: {
    position: 'absolute',
    top: 32,
    right: 12,
    zIndex: 50,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  cycleText: {
    color: '#fff',
    fontSize: fs(12),
    fontWeight: '700',
  },
  railWrap: {
    position: 'absolute',
    right: 10,
    top: '38%',
    zIndex: 48,
    alignItems: 'center',
    gap: 16,
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
  refreshReelsBtn: {
    position: 'absolute',
    bottom: 132,
    alignSelf: 'center',
    zIndex: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 24,
    backgroundColor: '#6C3CE9',
  },
  refreshReelsText: {
    color: '#fff',
    fontSize: fs(14),
    fontWeight: '700',
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  settingsSheet: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 18,
    padding: 20,
  },
  settingsTitle: {
    fontSize: fs(18),
    fontWeight: '800',
    marginBottom: 14,
  },
  settingsSection: {
    fontSize: fs(13),
    fontWeight: '700',
    marginTop: 8,
    marginBottom: 10,
  },
  optionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
  },
  optionText: {
    fontSize: fs(13),
    fontWeight: '600',
  },
  settingsHint: {
    color: '#9A93A8',
    fontSize: fs(11),
    marginTop: 16,
    textAlign: 'center',
  },
});
