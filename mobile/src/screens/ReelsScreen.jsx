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
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { SERVER_URL } from '../config';
import Toast from '../components/Toast';
import { REELS_PLAYER_HTML } from './ReelsPlayerHTML';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const STORAGE_KEY_FEED_CACHE = '@tojey_reels_feed_cache';
const STORAGE_KEY_FEED_CACHE_TIMESTAMP = '@tojey_reels_feed_cache_timestamp';
const FEED_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes cache

const CATEGORIES = [
  { id: 'trending', label: 'Trending' },
  { id: 'love', label: 'Love' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'funny', label: 'Funny' },
  { id: 'education', label: 'Education' },
  { id: 'motivation', label: 'Motivation' },
  { id: 'nepali', label: 'Nepali' },
  { id: 'hindi', label: 'Hindi' },
  { id: 'foreign', label: 'Foreign' },
  { id: 'music', label: 'Music' },
  { id: 'memes', label: 'Memes' },
];

// Auto-rotate categories every session
const getRandomCategory = () => {
  return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)].id;
};

const ITEM_HEIGHT = SCREEN_H;

function parseYTErrorCode(errorCode) {
  if (typeof errorCode === 'number') return errorCode;
  if (typeof errorCode === 'string') {
    const parts = errorCode.trim().split(/[\s,-]+/);
    const code = parseInt(parts[0], 10);
    if (!isNaN(code)) return code;
  }
  return null;
}

function isPlayableError(errorCode) {
  const code = parseYTErrorCode(errorCode);
  if (code === null) return false;
  // Codes indicating the video cannot be played at all.
  return [2, 5, 100, 101, 102, 103, 104, 105, 150, 152, 153, 154, 155].includes(code);
}

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

async function loadFeedCache(category) {
  try {
    const [storedData, storedTimestamp] = await Promise.all([
      AsyncStorage.getItem(`${STORAGE_KEY_FEED_CACHE}_${category}`),
      AsyncStorage.getItem(`${STORAGE_KEY_FEED_CACHE_TIMESTAMP}_${category}`),
    ]);

    if (storedData && storedTimestamp) {
      const timestamp = parseInt(storedTimestamp, 10);
      const now = Date.now();
      if (now - timestamp < FEED_CACHE_MAX_AGE_MS) {
        const parsed = JSON.parse(storedData);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('[Reels] Loaded feed from cache for category:', category);
          return parsed;
        }
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
    console.log('[Reels] Saved feed cache for category:', category);
  } catch (e) {
    console.warn('[Reels] Failed to save feed cache:', e);
  }
}

export default function ReelsScreen({ token, user }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState(() => getRandomCategory());
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');

  const flatListRef = useRef(null);
  const webViewRef = useRef(null);
  const overlayTranslateY = useRef(new Animated.Value(0)).current;
  const scrollOffsetYRef = useRef(0);
  const activeIndexRef = useRef(0);
  const currentVideoIdRef = useRef(null);
  const playerStateRef = useRef('idle'); // idle, loading, ready, playing, paused, buffering, error
  const webViewReadyRef = useRef(false);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const loadingPageRef = useRef(false);
  const appVisibleRef = useRef(true);
  const touchStartYRef = useRef(0);
  const touchStartXRef = useRef(0);
  const touchStartTimeRef = useRef(0);
  const failedVideoIdsRef = useRef(new Set());
  const pendingSkipRef = useRef(false);

  // Session-seen videos for feed rotation
  const seenVideoIdsRef = useRef(new Set());

  const nextPageTokenRef = useRef(null);
  const hasMoreRef = useRef(true);
  const isLoadingMoreRef = useRef(false);

  // Latest values for stable callbacks (avoids FlatList viewability warnings).
  const videosRef = useRef([]);
  const loadMoreRef = useRef(null);
  const loadVideoRef = useRef(null);
  const skipToIndexRef = useRef(null);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  // Stable WebView source so the single player is never reloaded by re-renders.
  const webViewSource = useMemo(() => ({ html: REELS_PLAYER_HTML }), []);

  const skipToIndex = useCallback((index) => {
    if (pendingSkipRef.current || !isMountedRef.current) return;
    pendingSkipRef.current = true;
    const list = videosRef.current;
    const nextIdx = index + 1;
    console.log('[Reels] Skipping video, scrolling to next:', nextIdx);

    if (nextIdx < list.length && flatListRef.current) {
      setTimeout(() => {
        if (!isMountedRef.current || !flatListRef.current) return;
        try {
          flatListRef.current.scrollToIndex({ index: nextIdx, animated: true });
        } catch (e) {
          flatListRef.current.scrollToOffset({ offset: nextIdx * ITEM_HEIGHT, animated: true });
        }
      }, 250);
    } else if (list.length === 0) {
      setToast('No more videos available');
    } else if (loadMoreRef.current) {
      loadMoreRef.current();
    }
  }, []);

  const loadVideo = useCallback((item, index) => {
    if (!webViewReadyRef.current || !item) return;

    const videoId = sanitizeVideoId(item.videoId);
    if (!videoId) {
      console.warn('[Reels] Invalid videoId, skipping:', item.videoId);
      failedVideoIdsRef.current.add(item.videoId);
      if (skipToIndexRef.current) skipToIndexRef.current(index);
      return;
    }

    // Don't restart the same video that is already loading/playing.
    if (
      currentVideoIdRef.current === videoId &&
      playerStateRef.current !== 'idle' &&
      playerStateRef.current !== 'error'
    ) {
      return;
    }

    const thumb = thumbnailUrlFor(item);
    currentVideoIdRef.current = videoId;
    playerStateRef.current = 'loading';
    activeIndexRef.current = index;

    const safeThumb = thumb.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    if (webViewRef.current) {
      webViewRef.current.injectJavaScript(
        `window.__loadVideo('${videoId}', '${safeThumb}'); true;`
      );
    }
  }, []);

  const fetchFeed = useCallback(async (cat, isRefresh = false, append = false, pageToken = null) => {
    const currentRequestId = ++requestIdRef.current;
    if (loadingPageRef.current) return;
    loadingPageRef.current = true;

    try {
      if (!append) setLoading(true);
      if (isRefresh) setRefreshing(true);
      setError(null);

      if (!isRefresh && !append && !pageToken) {
        const cachedVideos = await loadFeedCache(cat);
        if (cachedVideos && cachedVideos.length > 0) {
          const validCachedVideos = cachedVideos.filter(v =>
            v.videoId && typeof v.videoId === 'string' && v.videoId.trim().length > 0 &&
            !failedVideoIdsRef.current.has(v.videoId)
          );

          if (validCachedVideos.length > 0) {
            const unseenVideos = validCachedVideos.filter(v => !seenVideoIdsRef.current.has(v.videoId));
            const videosToUse = unseenVideos.length >= 3 ? unseenVideos : validCachedVideos;
            const entryCount = seenVideoIdsRef.current.size;
            let validVideos = videosToUse;
            if (videosToUse.length > 1) {
              const rotateBy = Math.min(entryCount, videosToUse.length - 1);
              validVideos = [...videosToUse.slice(rotateBy), ...videosToUse.slice(0, rotateBy)];
            }

            validVideos.forEach(v => seenVideoIdsRef.current.add(v.videoId));

            if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;

            videosRef.current = validVideos;
            setVideos(validVideos);
            failedVideoIdsRef.current.clear();
            nextPageTokenRef.current = null;
            hasMoreRef.current = true;
            setLoading(false);
            setRefreshing(false);
            loadingPageRef.current = false;
            console.log('[Reels] Rendered feed from local cache');

            // Reset to the first item for the freshly-rendered feed.
            activeIndexRef.current = 0;
            scrollOffsetYRef.current = 0;
            overlayTranslateY.setValue(0);
            currentVideoIdRef.current = null;
            playerStateRef.current = 'idle';
            if (webViewReadyRef.current && loadVideoRef.current) {
              loadVideoRef.current(validVideos[0], 0);
            }
          }
        }
      }

      const queryParts = [`category=${encodeURIComponent(cat)}`, `refresh=${isRefresh ? 'true' : 'false'}`];
      if (pageToken) queryParts.push(`pageToken=${encodeURIComponent(pageToken)}`);

      const res = await fetch(`${SERVER_URL}/api/reels/feed?${queryParts.join('&')}`, { headers: authHeaders });
      const data = await res.json();

      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(data.error || 'Failed to load feed');
      }

      let validVideos = (data.videos || []).filter(v =>
        v.videoId && typeof v.videoId === 'string' && v.videoId.trim().length > 0 &&
        !failedVideoIdsRef.current.has(v.videoId)
      );

      if (!append && !pageToken && !isRefresh) {
        const unseenVideos = validVideos.filter(v => !seenVideoIdsRef.current.has(v.videoId));
        const videosToUse = unseenVideos.length >= 3 ? unseenVideos : validVideos;
        const entryCount = seenVideoIdsRef.current.size;
        if (videosToUse.length > 1) {
          const rotateBy = Math.min(entryCount, videosToUse.length - 1);
          validVideos = [...videosToUse.slice(rotateBy), ...videosToUse.slice(0, rotateBy)];
        } else {
          validVideos = videosToUse;
        }
      }

      validVideos.forEach(v => seenVideoIdsRef.current.add(v.videoId));

      if (append) {
        setVideos(prev => {
          const existingIds = new Set(prev.map(v => v.videoId));
          const newVideos = validVideos.filter(v => !existingIds.has(v.videoId));
          const merged = [...prev, ...newVideos];
          videosRef.current = merged;
          return merged;
        });
      } else {
        videosRef.current = validVideos;
        setVideos(validVideos);
        failedVideoIdsRef.current.clear();

        // Fresh feed -> restart at the first video.
        activeIndexRef.current = 0;
        scrollOffsetYRef.current = 0;
        overlayTranslateY.setValue(0);
        currentVideoIdRef.current = null;
        playerStateRef.current = 'idle';
        if (webViewReadyRef.current && loadVideoRef.current && validVideos[0]) {
          loadVideoRef.current(validVideos[0], 0);
        }
      }

      nextPageTokenRef.current = data.nextPageToken || null;
      hasMoreRef.current = data.hasMore === true;

      if (!append && !pageToken && validVideos.length > 0) {
        saveFeedCache(cat, validVideos);
      }

      if (data.warning) setToast(data.warning);
      if (data.quota?.exceeded) {
        console.warn('[Reels] YouTube quota exceeded:', data.quota);
      }
    } catch (e) {
      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;
      setError(e.message);
      setToast(e.message);
    } finally {
      if (isMountedRef.current && currentRequestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingPageRef.current = false;
      }
    }
  }, [authHeaders, overlayTranslateY]);

  const loadMore = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRef.current || loadingPageRef.current) return;

    const tokenToUse = nextPageTokenRef.current;
    if (!tokenToUse) return;

    isLoadingMoreRef.current = true;
    loadingPageRef.current = true;

    try {
      const res = await fetch(
        `${SERVER_URL}/api/reels/feed?category=${encodeURIComponent(category)}&refresh=false&pageToken=${encodeURIComponent(tokenToUse)}`,
        { headers: authHeaders }
      );
      const data = await res.json();

      if (!isMountedRef.current) return;

      if (res.ok && data.videos && data.videos.length > 0) {
        const validVideos = data.videos.filter(v =>
          v.videoId && typeof v.videoId === 'string' && v.videoId.trim().length > 0 &&
          !failedVideoIdsRef.current.has(v.videoId) &&
          !seenVideoIdsRef.current.has(v.videoId)
        );

        validVideos.forEach(v => seenVideoIdsRef.current.add(v.videoId));

        setVideos(prev => {
          const existingIds = new Set(prev.map(v => v.videoId));
          const newVideos = validVideos.filter(v => !existingIds.has(v.videoId));
          const merged = [...prev, ...newVideos];
          videosRef.current = merged;
          return merged;
        });

        nextPageTokenRef.current = data.nextPageToken || null;
        hasMoreRef.current = data.hasMore === true;
      }
    } catch (e) {
      console.warn('[Reels] loadMore failed:', e.message);
    } finally {
      if (isMountedRef.current) {
        loadingPageRef.current = false;
        isLoadingMoreRef.current = false;
      }
    }
  }, [authHeaders, category]);

  // Keep stable refs pointing at the latest callbacks.
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);
  useEffect(() => {
    loadVideoRef.current = loadVideo;
  }, [loadVideo]);
  useEffect(() => {
    skipToIndexRef.current = skipToIndex;
  }, [skipToIndex]);

  const handleWebViewMessage = useCallback((event) => {
    try {
      const data = typeof event.nativeEvent?.data === 'string' ? JSON.parse(event.nativeEvent.data) : null;
      if (!data || !data.type) return;

      if (data.type === 'ytPlayerEvent') {
        // Drop stale events from a video we no longer target.
        if (currentVideoIdRef.current && data.videoId && data.videoId !== currentVideoIdRef.current) {
          return;
        }

        const evt = data.event;
        if (evt === 'ready') {
          playerStateRef.current = 'ready';
        } else if (evt === 'playing') {
          playerStateRef.current = 'playing';
        } else if (evt === 'paused') {
          playerStateRef.current = 'paused';
        } else if (evt === 'buffering') {
          playerStateRef.current = 'buffering';
        } else if (evt === 'cued') {
          playerStateRef.current = 'ready';
        }
      } else if (data.type === 'ytPlayerError') {
        const errorCode = parseYTErrorCode(data.errorCode);
        const currentIndex = activeIndexRef.current;

        if (currentVideoIdRef.current && data.videoId && data.videoId !== currentVideoIdRef.current) {
          return; // stale error from a different target
        }

        if (currentIndex < videosRef.current.length && isMountedRef.current) {
          console.log('[Reels] YouTube player error (skip?):', errorCode, 'videoId:', currentVideoIdRef.current);
          const shouldSkip = isPlayableError(errorCode) || errorCode === 'API_LOAD_FAILED';

          if (shouldSkip) {
            const item = videosRef.current[currentIndex];
            if (item && item.videoId) {
              failedVideoIdsRef.current.add(item.videoId);
            }
            if (skipToIndexRef.current) skipToIndexRef.current(currentIndex);
          } else {
            playerStateRef.current = 'error';
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, []);

  const handleScroll = useCallback((event) => {
    const y = event.nativeEvent.contentOffset.y;
    scrollOffsetYRef.current = y;
    // The overlay tracks the currently-settled cell while the list is dragged,
    // so the playing video moves with its own cell instead of jumping early.
    overlayTranslateY.setValue(activeIndexRef.current * ITEM_HEIGHT - y);
  }, [overlayTranslateY]);

  const settleToIndex = useCallback((index) => {
    const list = videosRef.current;
    if (index < 0 || index >= list.length) return;

    activeIndexRef.current = index;
    pendingSkipRef.current = false;
    scrollOffsetYRef.current = index * ITEM_HEIGHT;
    overlayTranslateY.setValue(0);

    if (loadVideoRef.current) loadVideoRef.current(list[index], index);
  }, [overlayTranslateY]);

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

  const onScrollEndDrag = useCallback(() => {
    // Fallback for a release that produces no momentum: settle after the snap.
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

    if (deltaX < 15 && deltaY < 15 && deltaTime < 250 && webViewReadyRef.current) {
      const index = activeIndexRef.current;
      const item = videosRef.current[index];
      const videoId = item && sanitizeVideoId(item.videoId);
      if (!videoId) return;

      if (playerStateRef.current === 'playing' || playerStateRef.current === 'buffering') {
        if (webViewRef.current) webViewRef.current.injectJavaScript('window.__pause(); true;');
        playerStateRef.current = 'paused';
      } else if (playerStateRef.current === 'paused') {
        if (webViewRef.current) webViewRef.current.injectJavaScript('window.__play(); true;');
        playerStateRef.current = 'playing';
      }
    }
  }, []);

  // Boot feed and handle app lifecycle.
  useEffect(() => {
    isMountedRef.current = true;
    fetchFeed(category, false, false);

    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasActive = appVisibleRef.current;
      const isActive = nextState === 'active';
      appVisibleRef.current = isActive;

      if (isActive && !wasActive) {
        seenVideoIdsRef.current.clear();
        nextPageTokenRef.current = null;
        hasMoreRef.current = true;
        fetchFeed(category, true, false);
      } else if (!isActive) {
        if (webViewRef.current && webViewReadyRef.current) {
          webViewRef.current.injectJavaScript('window.__pause(); true;');
          playerStateRef.current = 'paused';
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.remove();
      if (webViewRef.current && webViewReadyRef.current) {
        try {
          webViewRef.current.injectJavaScript('window.__destroy(); true;');
        } catch (e) {}
      }
    };
  }, [category, fetchFeed]);

  const onWebViewLoadEnd = useCallback(() => {
    webViewReadyRef.current = true;
    const item = videosRef.current[activeIndexRef.current];
    if (item && loadVideoRef.current) {
      loadVideoRef.current(item, activeIndexRef.current);
    }
  }, []);

  const onWebViewError = useCallback(() => {
    playerStateRef.current = 'error';
  }, []);

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
          <TouchableOpacity onPress={() => fetchFeed(category, true)} style={[styles.retryBtn, { backgroundColor: theme.primary }]}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      <FlatList
        ref={flatListRef}
        data={videos}
        keyExtractor={(item) => item.videoId}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScrollEndDrag={onScrollEndDrag}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        getItemLayout={(data, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        renderItem={({ item }) => {
          const videoId = sanitizeVideoId(item.videoId);
          const thumb = thumbnailUrlFor(item);
          return (
            <View style={styles.videoContainer}>
              {videoId ? (
                <Image source={{ uri: thumb }} style={styles.thumbImage} resizeMode="cover" />
              ) : (
                <View style={styles.solidThumb} />
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="video-outline" size={52} color={theme.primaryLight} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              {toast || 'No videos available right now'}
            </Text>
            {toast && (
              <TouchableOpacity
                onPress={() => fetchFeed(category, true)}
                style={[styles.retryBtn, { backgroundColor: theme.primary, marginTop: 16 }]}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        }
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={4}
        removeClippedSubviews={true}
      />

      {/* Single active player: one WebView hosting one YT player, translated to follow the active cell. */}
      <Animated.View
        style={[styles.playerOverlay, { transform: [{ translateY: overlayTranslateY }] }]}
        pointerEvents="none"
      >
        <WebView
          ref={webViewRef}
          source={webViewSource}
          style={styles.video}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          allowsFullscreenVideo={false}
          setSupportMultipleWindows={false}
          onMessage={handleWebViewMessage}
          onLoadEnd={onWebViewLoadEnd}
          onError={onWebViewError}
          onHttpError={onWebViewError}
          scrollEnabled={false}
          originWhitelist={['*']}
          mixedContentMode="always"
          hardwareAccelerationEnabled={true}
        />
      </Animated.View>

      {toast && <Toast message={toast} onDismiss={() => setToast('')} />}
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
  solidThumb: {
    flex: 1,
    backgroundColor: '#111',
  },
  playerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_W,
    height: ITEM_HEIGHT,
  },
  video: {
    flex: 1,
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
  },
  retryBtn: {
    paddingHorizontal: fs(24),
    paddingVertical: fs(10),
    borderRadius: fs(10),
  },
});