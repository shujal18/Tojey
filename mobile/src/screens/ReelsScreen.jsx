import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { SERVER_URL } from '../config';
import Toast from '../components/Toast';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const YOUTUBE_IFRAME_API_JS = `
  (function() {
    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = function() {
      var iframe = document.getElementById('tojey-youtube-player');
      if (!iframe) {
        var iframes = document.getElementsByTagName('iframe');
        if (iframes.length > 0) {
          iframe = iframes[0];
          iframe.id = 'tojey-youtube-player';
        }
      }
      if (iframe && !window.ytPlayer) {
        window.ytPlayer = new YT.Player(iframe, {
          events: {
            'onReady': function(event) {
              window.postMessage(JSON.stringify({type: 'ytPlayerReady', videoId: event.target.getVideoData().video_id}), '*');
            },
            'onStateChange': function(event) {
              if (event.data === YT.PlayerState.ENDED) {
                event.target.seekTo(0);
                event.target.playVideo();
              } else if (event.data === YT.PlayerState.PLAYING) {
                window.postMessage(JSON.stringify({type: 'ytPlayerPlaying'}), '*');
              } else if (event.data === YT.PlayerState.BUFFERING) {
                window.postMessage(JSON.stringify({type: 'ytPlayerBuffering'}), '*');
              }
            },
            'onError': function(event) {
              var errorCode = event.data;
              window.postMessage(JSON.stringify({type: 'ytPlayerError', errorCode: errorCode}), '*');
            }
          }
        });
      }
    };
  })();
`;

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

const ITEM_HEIGHT = SCREEN_H;
const PERMANENT_YT_ERRORS = new Set([2, 5, 100, 101, 150, 153]);

export default function ReelsScreen({ token, user }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');

  const flatListRef = useRef(null);
  const activeIndexRef = useRef(0);
  const videoPlayersRef = useRef({});
  const playerReadyRef = useRef({});
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const loadingPageRef = useRef(false);
  const appVisibleRef = useRef(true);
  const userInteractedRef = useRef(false);
  const touchStartYRef = useRef(0);
  const touchStartXRef = useRef(0);
  const touchStartTimeRef = useRef(0);
  const failedVideoIdsRef = useRef(new Set());
  const pendingSkipRef = useRef(false);

  const viewabilityConfig = useMemo(() => ({
    itemVisiblePercentThreshold: 75,
    minimumViewTime: 100,
    waitForInteraction: true,
  }), []);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    if (!viewableItems || !viewableItems.length) return;
    const newIndex = viewableItems[0].index;
    if (newIndex !== activeIndexRef.current) {
      activeIndexRef.current = newIndex;
      userInteractedRef.current = false;
      pendingSkipRef.current = false;

      const newPlayer = videoPlayersRef.current[newIndex];
      const newPlayerReady = playerReadyRef.current[newIndex];
      if (newPlayer && newPlayerReady) {
        newPlayer.injectJavaScript(`
          if (window.ytPlayer && typeof window.ytPlayer.seekTo === 'function' && typeof window.ytPlayer.playVideo === 'function') {
            window.ytPlayer.seekTo(0);
            window.ytPlayer.playVideo();
          }
        `);
      }

      Object.keys(videoPlayersRef.current).forEach(key => {
        const idx = parseInt(key, 10);
        if (idx !== newIndex) {
          const player = videoPlayersRef.current[idx];
          if (player) {
            player.injectJavaScript(`
              if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') {
                window.ytPlayer.pauseVideo();
              }
            `);
          }
        }
      });

      const nextIdx = newIndex + 1;
      if (nextIdx >= videos.length - 3) {
        loadMore();
      }
    }
  }, [videos.length]);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  const fetchFeed = useCallback(async (cat, isRefresh = false, append = false, pageToken = null) => {
    const currentRequestId = ++requestIdRef.current;
    if (loadingPageRef.current) return;
    loadingPageRef.current = true;

    try {
      if (!append) setLoading(true);
      if (isRefresh) setRefreshing(true);
      setError(null);

      const url = new URL(`${SERVER_URL}/api/reels/feed`);
      url.searchParams.set('category', cat);
      url.searchParams.set('refresh', isRefresh ? 'true' : 'false');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString(), { headers: authHeaders });
      const data = await res.json();

      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;

      if (!res.ok) {
        throw new Error(data.error || 'Failed to load feed');
      }

      const validVideos = (data.videos || []).filter(v => 
        v.videoId && typeof v.videoId === 'string' && v.videoId.trim().length > 0 &&
        !failedVideoIdsRef.current.has(v.videoId)
      );

      if (append) {
        setVideos(prev => {
          const existingIds = new Set(prev.map(v => v.videoId));
          const newVideos = validVideos.filter(v => !existingIds.has(v.videoId));
          return [...prev, ...newVideos];
        });
      } else {
        setVideos(validVideos);
        failedVideoIdsRef.current.clear();
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
  }, [authHeaders]);

  const handleCategoryChange = useCallback((cat) => {
    if (cat === category) return;

    Object.values(videoPlayersRef.current).forEach(p => {
      if (p) {
        p.injectJavaScript("if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') { window.ytPlayer.pauseVideo(); }");
      }
    });

    playerReadyRef.current = {};
    videoPlayersRef.current = {};
    activeIndexRef.current = 0;
    failedVideoIdsRef.current.clear();
    prefetchedRef.current.clear();

    setCategory(cat);
    setVideos([]);
    fetchFeed(cat, false, false);
  }, [category, fetchFeed]);

  const loadMore = useCallback(() => {
    if (videos.length && !loading && !loadingPageRef.current) {
      fetchFeed(category, false, true);
    }
  }, [category, videos.length, loading, fetchFeed]);

  const onVideoRef = useCallback((index, ref) => {
    if (ref) {
      videoPlayersRef.current[index] = ref;
    } else {
      delete videoPlayersRef.current[index];
      delete playerReadyRef.current[index];
    }
  }, []);

  const handleWebViewMessage = useCallback((event, index) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'ytPlayerReady') {
        playerReadyRef.current[index] = true;
        if (index === activeIndexRef.current && !userInteractedRef.current && appVisibleRef.current) {
          const player = videoPlayersRef.current[index];
          if (player) {
            player.injectJavaScript(`
              if (window.ytPlayer && typeof window.ytPlayer.playVideo === 'function') {
                window.ytPlayer.playVideo();
              }
            `);
          }
        }
      } else if (data.type === 'ytPlayerError') {
        const errorCode = data.errorCode;
        const currentIndex = activeIndexRef.current;
        
        if (index === currentIndex && isMountedRef.current && !pendingSkipRef.current) {
          console.error('[Reels] YouTube player error:', errorCode, 'videoId:', videos[currentIndex]?.videoId);
          
          if (PERMANENT_YT_ERRORS.has(errorCode)) {
            failedVideoIdsRef.current.add(videos[currentIndex]?.videoId);
            pendingSkipRef.current = true;
            
            setTimeout(() => {
              if (isMountedRef.current && activeIndexRef.current === currentIndex) {
                const nextIdx = currentIndex + 1;
                if (nextIdx < videos.length && flatListRef.current) {
                  flatListRef.current.scrollToIndex({ index: nextIdx, animated: true });
                } else if (videos.length === 0) {
                  setToast('No more videos available');
                }
              }
            }, 300);
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, [videos]);

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

    const isTap = deltaY < 15 && deltaX < 15 && deltaTime < 200;

    if (isTap) {
      const index = activeIndexRef.current;
      const player = videoPlayersRef.current[index];
      const ready = playerReadyRef.current[index];
      if (player && ready) {
        player.injectJavaScript(`
          if (window.ytPlayer) {
            var state = window.ytPlayer.getPlayerState();
            if (state === YT.PlayerState.PLAYING) {
              window.ytPlayer.pauseVideo();
            } else {
              window.ytPlayer.playVideo();
            }
          }
        `);
      }
      userInteractedRef.current = !userInteractedRef.current;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    requestIdRef.current = 0;
    fetchFeed(category, false, false);

    const subscription = AppState.addEventListener('change', (nextState) => {
      appVisibleRef.current = nextState === 'active';
      if (nextState === 'active') {
        const player = videoPlayersRef.current[activeIndexRef.current];
        const ready = playerReadyRef.current[activeIndexRef.current];
        if (player && ready && !userInteractedRef.current) {
          player.injectJavaScript(`
            if (window.ytPlayer && typeof window.ytPlayer.playVideo === 'function') {
              window.ytPlayer.playVideo();
            }
          `);
        }
      } else {
        Object.keys(videoPlayersRef.current).forEach(key => {
          const player = videoPlayersRef.current[key];
          if (player) {
            player.injectJavaScript(`
              if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') {
                window.ytPlayer.pauseVideo();
              }
            `);
          }
        });
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.remove();
      Object.keys(videoPlayersRef.current).forEach(key => {
        try {
          const player = videoPlayersRef.current[key];
          if (player) {
            player.injectJavaScript(`
              if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') {
                window.ytPlayer.pauseVideo();
              }
            `);
          }
        } catch (e) {}
      });
    };
  }, [category, fetchFeed]);

  const prefetchedRef = useRef(new Set());

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
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.categoryBar}>
        <FlatList
          data={CATEGORIES}
          keyExtractor={item => item.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryList}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => handleCategoryChange(item.id)}
              style={[
                styles.categoryChip,
                category === item.id && styles.categoryChipActive,
                { backgroundColor: category === item.id ? theme.primary : theme.primaryLight }
              ]}
            >
              <Text style={[
                styles.categoryLabel,
                category === item.id ? { color: '#fff' } : { color: theme.text }
              ]}>
                {item.label}
              </Text>
            </TouchableOpacity>
          )}
        />
      </View>

      <FlatList
        ref={flatListRef}
        data={videos}
        keyExtractor={item => item.videoId}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        disableIntervalMomentum
        showsVerticalScrollIndicator={false}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        onScrollEndDrag={loadMore}
        onMomentumScrollEnd={loadMore}
        renderItem={({ item, index }) => (
          <View style={styles.videoContainer}>
            <WebView
              ref={ref => onVideoRef(index, ref)}
              source={{
                uri: `https://www.youtube-nocookie.com/embed/${item.videoId}?autoplay=0&playsinline=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&enablejsapi=1&widgetid=1`,
              }}
              style={styles.video}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              mediaPlaybackRequiresUserAction={false}
              allowsInlineMediaPlayback={true}
              userAgent="Mozilla/5.0 (Linux; Android 10; Tojey) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
              onMessage={(event) => handleWebViewMessage(event, index)}
              onTouchStart={onTouchStart}
              onTouchEnd={onTouchEnd}
              onTouchCancel={onTouchEnd}
              scrollEnabled={false}
              injectedJavaScript={YOUTUBE_IFRAME_API_JS}
              allowsBackForwardNavigationGestures={false}
              hardwareAccelerationEnabled={true}
              rendersToHardwareTextureAndroid={true}
            />
            <View style={styles.overlay}>
              <View style={styles.infoRow}>
                <TouchableOpacity style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    @{(item.channelTitle ? item.channelTitle.slice(0, 10) : '') || '?'}
                  </Text>
                </TouchableOpacity>
                <View style={styles.titleContainer}>
                  <Text style={styles.title} numberOfLines={2}>{item.title}</Text>
                  <Text style={styles.meta}>
                    {item.channelTitle} • {formatDuration(item.durationSeconds)}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="video-outline" size={52} color={theme.primaryLight} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>No videos found</Text>
          </View>
        }
        initialNumToRender={3}
        maxToRenderPerBatch={2}
        windowSize={4}
        removeClippedSubviews={true}
      />
      {toast && <Toast message={toast} onDismiss={() => setToast('')} />}
    </View>
  );
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins + ':' + String(secs).padStart(2, '0');
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  categoryBar: {
    height: 50,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  categoryList: { paddingHorizontal: 12, paddingVertical: 8 },
  categoryChip: {
    paddingHorizontal: fs(14),
    paddingVertical: fs(6),
    borderRadius: fs(20),
    marginRight: 8,
  },
  categoryChipActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  categoryLabel: { fontSize: fs(13), fontWeight: '600' },
  videoContainer: {
    width: SCREEN_W,
    height: ITEM_HEIGHT,
    position: 'relative',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    padding: fs(16),
    justifyContent: 'space-between',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  avatarText: { color: '#fff', fontSize: fs(11), fontWeight: '600' },
  titleContainer: { flex: 1, marginTop: 2 },
  title: { color: '#fff', fontSize: fs(15), fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
  meta: { color: 'rgba(255,255,255,0.8)', fontSize: fs(12), marginTop: 2 },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { fontSize: fs(15), marginTop: 12 },
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  errorText: { fontSize: fs(15), textAlign: 'center' },
  retryBtn: { paddingHorizontal: fs(24), paddingVertical: fs(10), borderRadius: fs(10) },
});