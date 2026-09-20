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
    // Prevent multiple initializations
    if (window.tojeyYTInitialized) {
      return;
    }
    window.tojeyYTInitialized = true;

    var tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    var firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = function() {
      // Find the iframe and ensure it has an ID
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
              // Ensure we can get video data
              try {
                var videoData = event.target.getVideoData();
                window.postMessage(JSON.stringify({type: 'ytPlayerReady', videoId: videoData?.video_id}), '*');
              } catch (e) {
                window.postMessage(JSON.stringify({type: 'ytPlayerReady', videoId: 'unknown'}), '*');
              }
            },
            'onStateChange': function(event) {
              if (event.data === YT.PlayerState.ENDED) {
                event.target.seekTo(0);
                event.target.playVideo();
              } else if (event.data === YT.PlayerState.PLAYING) {
                window.postMessage(JSON.stringify({type: 'ytPlayerPlaying'}), '*');
              } else if (event.data === YT.PlayerState.BUFFERING) {
                window.postMessage(JSON.stringify({type: 'ytPlayerBuffering'}), '*');
              } else if (event.data === YT.PlayerState.PAUSED) {
                window.postMessage(JSON.stringify({type: 'ytPlayerPaused'}), '*');
              } else if (event.data === YT.PlayerState.CUED) {
                window.postMessage(JSON.stringify({type: 'ytPlayerCued'}), '*');
              }
            },
            'onError': function(event) {
              var errorCode = event.data;
              console.log('[YouTube Player] Error:', errorCode);
              window.postMessage(JSON.stringify({type: 'ytPlayerError', errorCode: errorCode}), '*');
            },
            'onPlaybackQualityChange': function(event) {
              window.postMessage(JSON.stringify({type: 'ytPlaybackQualityChange', quality: event.data}), '*');
            }
          }
        });
      }
    };
  })();
`;

const YOUTUBE_EMBED_HEADERS = {
  'Referer': 'https://www.youtube-nocookie.com/',
  'Origin': 'https://www.youtube-nocookie.com',
};

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
const PERMANENT_YT_ERRORS = new Set([2, 5, 100, 101, 102, 103, 104, 105, 150, 152, 153, 154, 155]);

function parseYTErrorCode(errorCode) {
  if (typeof errorCode === 'number') return errorCode;
  if (typeof errorCode === 'string') {
    const parts = errorCode.trim().split(/[\s,-]+/);
    const code = parseInt(parts[0], 10);
    if (!isNaN(code)) return code;
  }
  return null;
}

function isPermanentYTError(errorCode) {
  const code = parseYTErrorCode(errorCode);
  return code !== null && PERMANENT_YT_ERRORS.has(code);
}

function isPlayableError(errorCode) {
  // Error codes that indicate the video cannot be played at all
  const code = parseYTErrorCode(errorCode);
  if (code === null) return false;
  // 2 = invalid parameter, 5 = HTML5 player error, 100 = video not found, 101/150 = embedding disabled, 152 = unavailable, 153 = embedding disabled
  return [2, 5, 100, 101, 102, 103, 104, 105, 150, 152, 153, 154, 155].includes(code);
}

function validateVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return false;
  // YouTube video IDs are 11 characters, alphanumeric plus hyphen and underscore
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId.trim());
}

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (validateVideoId(trimmed)) return trimmed;
  return null;
}

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
  const playerStateRef = useRef({}); // playing, paused, buffering, ended, error
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
  const preloadTriggeredRef = useRef(new Set());

  const viewabilityConfig = useMemo(() => ({
    itemVisiblePercentThreshold: 75,
    minimumViewTime: 100,
    waitForInteraction: true,
  }), []);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    if (!viewableItems || !viewableItems.length) return;
    const newIndex = viewableItems[0].index;
    if (newIndex !== activeIndexRef.current) {
      const oldIndex = activeIndexRef.current;
      activeIndexRef.current = newIndex;
      userInteractedRef.current = false;
      pendingSkipRef.current = false;

      // Pause old player
      if (oldIndex !== newIndex) {
        const oldPlayer = videoPlayersRef.current[oldIndex];
        if (oldPlayer && playerReadyRef.current[oldIndex]) {
          oldPlayer.injectJavaScript(`
            if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') {
              window.ytPlayer.pauseVideo();
            }
          `);
        }
        playerStateRef.current[oldIndex] = 'paused';
      }

      // Play new player
      const newPlayer = videoPlayersRef.current[newIndex];
      const newPlayerReady = playerReadyRef.current[newIndex];
      if (newPlayer && newPlayerReady) {
        newPlayer.injectJavaScript(`
          if (window.ytPlayer && typeof window.ytPlayer.seekTo === 'function' && typeof window.ytPlayer.playVideo === 'function') {
            window.ytPlayer.seekTo(0);
            window.ytPlayer.playVideo();
          }
        `);
        playerStateRef.current[newIndex] = 'playing';
      }

      // Trigger preload for next video (nextIdx + 1)
      const nextIdx = newIndex + 1;
      if (nextIdx < videos.length && !preloadTriggeredRef.current.has(nextIdx)) {
        preloadTriggeredRef.current.add(nextIdx);
        const nextPlayer = videoPlayersRef.current[nextIdx];
        if (nextPlayer && playerReadyRef.current[nextIdx]) {
          nextPlayer.injectJavaScript(`
            if (window.ytPlayer && typeof window.ytPlayer.cueVideoById === 'function') {
              var nextVideo = document.getElementById('tojey-youtube-player');
              if (nextVideo && nextVideo.getVideoData) {
                var data = nextVideo.getVideoData();
                if (data && data.video_id) {
                  window.ytPlayer.cueVideoById(data.video_id);
                }
              }
            }
          `);
        }
      }

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

      const queryParts = [`category=${encodeURIComponent(cat)}`, `refresh=${isRefresh ? 'true' : 'false'}`];
      if (pageToken) queryParts.push(`pageToken=${encodeURIComponent(pageToken)}`);

      const res = await fetch(`${SERVER_URL}/api/reels/feed?${queryParts.join('&')}`, { headers: authHeaders });
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
        preloadTriggeredRef.current.clear();
      }

      if (data.warning) {
        setToast(data.warning);
      }
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
  }, [authHeaders]);

  const loadMoreFromCache = useCallback(async () => {
    if (videos.length && !loading && !loadingPageRef.current) {
      loadingPageRef.current = true;
      try {
        const authHeaders = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token || ''}`,
        };
        const res = await fetch(`${SERVER_URL}/api/reels/feed?category=${encodeURIComponent(category)}&refresh=false`, { headers: authHeaders });
        const data = await res.json();
        
        if (!isMountedRef.current) return;
        
        if (res.ok && data.videos && data.videos.length > videos.length) {
          const validVideos = data.videos.filter(v => 
            v.videoId && typeof v.videoId === 'string' && v.videoId.trim().length > 0 &&
            !failedVideoIdsRef.current.has(v.videoId)
          );
          
          setVideos(prev => {
            const existingIds = new Set(prev.map(v => v.videoId));
            const newVideos = validVideos.filter(v => !existingIds.has(v.videoId));
            return [...prev, ...newVideos];
          });
        }
      } catch (e) {
        console.warn('[Reels] loadMore failed:', e.message);
      } finally {
        if (isMountedRef.current) {
          loadingPageRef.current = false;
        }
      }
    }
  }, [category, token, videos.length, loading]);

  const handleCategoryChange = useCallback((cat) => {
    if (cat === category) return;

    // Pause all current players before switching
    Object.values(videoPlayersRef.current).forEach(p => {
      if (p) {
        p.injectJavaScript("if (window.ytPlayer && typeof window.ytPlayer.pauseVideo === 'function') { window.ytPlayer.pauseVideo(); }");
      }
    });

    // Clear all player references and state
    playerReadyRef.current = {};
    videoPlayersRef.current = {};
    playerStateRef.current = {};
    activeIndexRef.current = 0;
    failedVideoIdsRef.current.clear();
    preloadTriggeredRef.current.clear();
    pendingSkipRef.current = false;

    setCategory(cat);
    setVideos([]);
    fetchFeed(cat, false, false);
  }, [category, fetchFeed]);

  const loadMore = loadMoreFromCache;

  const onVideoRef = useCallback((index, ref) => {
    if (ref) {
      videoPlayersRef.current[index] = ref;
    } else {
      delete videoPlayersRef.current[index];
      delete playerReadyRef.current[index];
      delete playerStateRef.current[index];
    }
  }, []);

  const handleWebViewMessage = useCallback((event, index) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'ytPlayerReady') {
        playerReadyRef.current[index] = true;
        playerStateRef.current[index] = 'cued';
        if (index === activeIndexRef.current && !userInteractedRef.current && appVisibleRef.current) {
          const player = videoPlayersRef.current[index];
          if (player) {
            player.injectJavaScript(`
              if (window.ytPlayer && typeof window.ytPlayer.playVideo === 'function') {
                window.ytPlayer.playVideo();
              }
            `);
            playerStateRef.current[index] = 'playing';
          }
        }
      } else if (data.type === 'ytPlayerError') {
        const errorCode = data.errorCode;
        const currentIndex = activeIndexRef.current;
        
        if (index === currentIndex && isMountedRef.current && !pendingSkipRef.current) {
          console.error('[Reels] YouTube player error:', errorCode, 'videoId:', videos[currentIndex]?.videoId);
          
          // Check if this is an error we should skip (any playable error)
          const shouldSkip = isPlayableError(errorCode);
          
          if (shouldSkip) {
            const failedVideoId = videos[currentIndex]?.videoId;
            if (failedVideoId) {
              failedVideoIdsRef.current.add(failedVideoId);
            }
            pendingSkipRef.current = true;
            
            // IMMEDIATE SKIP - no waiting, no fetchFeed call
            const nextIdx = currentIndex + 1;
            if (nextIdx < videos.length && flatListRef.current) {
              console.log('[Reels] Skipping failed video (error:', errorCode, '), scrolling to next:', nextIdx);
              flatListRef.current.scrollToIndex({ index: nextIdx, animated: true });
            } else if (videos.length === 0) {
              setToast('No more videos available');
            } else if (nextIdx >= videos.length) {
              // Try to load more videos
              loadMore();
            }
          }
        }
      } else if (data.type === 'ytPlayerPlaying') {
        playerStateRef.current[index] = 'playing';
      } else if (data.type === 'ytPlayerBuffering') {
        playerStateRef.current[index] = 'buffering';
      } else if (data.type === 'ytPlayerPaused') {
        playerStateRef.current[index] = 'paused';
      } else if (data.type === 'ytPlayerCued') {
        playerStateRef.current[index] = 'cued';
      } else if (data.type === 'ytPlaybackQualityChange') {
        console.log('[Reels] Quality change:', data.quality);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, [videos, category]);

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
      
      // Properly destroy all players on unmount
      Object.keys(videoPlayersRef.current).forEach(key => {
        try {
          const player = videoPlayersRef.current[key];
          if (player) {
            player.injectJavaScript(`
              if (window.ytPlayer) {
                if (typeof window.ytPlayer.destroy === 'function') {
                  window.ytPlayer.destroy();
                } else if (typeof window.ytPlayer.pauseVideo === 'function') {
                  window.ytPlayer.pauseVideo();
                }
              }
            `);
          }
        } catch (e) {}
      });
      
      // Clear all refs
      videoPlayersRef.current = {};
      playerReadyRef.current = {};
      playerStateRef.current = {};
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
        renderItem={({ item, index }) => {
            const isLocal = item.source === 'local';
            const rawVideoId = item.videoId;
            const videoId = sanitizeVideoId(rawVideoId);
            
            // Skip invalid video IDs
            if (!isLocal && !videoId) {
              console.warn('[Reels] Invalid videoId, skipping:', rawVideoId);
              return <View style={styles.videoContainer} />;
            }
            
            const videoUri = isLocal 
              ? `${SERVER_URL}${item.localUrl}` 
              : `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=0&playsinline=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&enablejsapi=1&widgetid=1`;
            
            const isActive = index === activeIndexRef.current;
            const playerState = playerStateRef.current[index] || 'loading';

            return (
              <View style={styles.videoContainer}>
                {isLocal ? (
                  <WebView
                    ref={ref => onVideoRef(index, ref)}
                    source={{ 
                      html: `
                        <html>
                          <head>
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <style>
                              body { margin: 0; background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; }
                              video { width: 100%; height: 100%; object-fit: cover; }
                            </style>
                          </head>
                          <body>
                            <video id="localVideo" playsinline webkit-playsinline controls="false" loop muted preload="metadata">
                              <source src="${videoUri}" type="video/mp4">
                            </video>
                            <script>
                              const video = document.getElementById('localVideo');
                              video.play().catch(e => console.log('Autoplay prevented:', e));
                              window.onVideoReady = () => {
                                window.postMessage(JSON.stringify({type: 'ytPlayerReady', videoId: 'local'}), '*');
                              };
                              video.oncanplay = window.onVideoReady;
                              video.onerror = (e) => {
                                window.postMessage(JSON.stringify({type: 'ytPlayerError', errorCode: 5}), '*');
                              };
                            </script>
                          </body>
                        </html>
                      `
                    }}
                    style={styles.video}
                    javaScriptEnabled={true}
                    domStorageEnabled={true}
                    mediaPlaybackRequiresUserAction={false}
                    allowsInlineMediaPlayback={true}
                    onMessage={(event) => handleWebViewMessage(event, index)}
                    onTouchStart={onTouchStart}
                    onTouchEnd={onTouchEnd}
                    onTouchCancel={onTouchEnd}
                    scrollEnabled={false}
                    allowsBackForwardNavigationGestures={false}
                    hardwareAccelerationEnabled={true}
                    rendersToHardwareTextureAndroid={true}
                  />
                ) : (
                  <WebView
                    ref={ref => onVideoRef(index, ref)}
                    source={{
                      uri: videoUri,
                      headers: YOUTUBE_EMBED_HEADERS,
                    }}
                    style={styles.video}
                    javaScriptEnabled={true}
                    domStorageEnabled={true}
                    mediaPlaybackRequiresUserAction={false}
                    allowsInlineMediaPlayback={true}
                    userAgent="Mozilla/5.0 (Linux; Android 10; Tojey) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
                    onMessage={(event) => handleWebViewMessage(event, index)}
                    onError={(event) => {
                      console.error('[Reels WebView] Error:', event.nativeEvent);
                      const errorCode = event.nativeEvent?.message || 'WEBVIEW_ERROR';
                      handleWebViewMessage({
                        nativeEvent: { data: JSON.stringify({ type: 'ytPlayerError', errorCode }) }
                      }, index);
                    }}
                    onHttpError={(event) => {
                      console.error('[Reels WebView] HTTP Error:', event.nativeEvent);
                      const statusCode = event.nativeEvent?.statusCode;
                      if (statusCode >= 400) {
                        handleWebViewMessage({
                          nativeEvent: { data: JSON.stringify({ type: 'ytPlayerError', errorCode: statusCode }) }
                        }, index);
                      }
                    }}
                    onLoadStart={() => {
                      console.log('[Reels WebView] Load start for index:', index);
                    }}
                    onLoad={() => {
                      console.log('[Reels WebView] Load complete for index:', index);
                    }}
                    onLoadEnd={() => {
                      console.log('[Reels WebView] Load end for index:', index);
                    }}
                    onTouchStart={onTouchStart}
                    onTouchEnd={onTouchEnd}
                    onTouchCancel={onTouchEnd}
                    scrollEnabled={false}
                    injectedJavaScript={YOUTUBE_IFRAME_API_JS}
                    allowsBackForwardNavigationGestures={false}
                    hardwareAccelerationEnabled={true}
                    rendersToHardwareTextureAndroid={true}
                  />
                )}
                <View style={[
                  styles.overlay,
                  playerState === 'buffering' && styles.bufferingOverlay,
                  playerState === 'error' && styles.errorOverlay,
                ]}>
                  {playerState === 'buffering' && (
                    <View style={styles.bufferingIndicator}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={styles.bufferingText}>Loading...</Text>
                    </View>
                  )}
                  {playerState === 'error' && (
                    <View style={styles.errorIndicator}>
                      <Icon name="alert-circle" size={24} color="#fff" />
                      <Text style={styles.errorText}>Video unavailable</Text>
                    </View>
                  )}
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
            );
          }}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
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
  bufferingOverlay: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorOverlay: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bufferingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  bufferingText: {
    color: '#fff',
    fontSize: fs(14),
  },
  errorIndicator: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  errorText: {
    color: '#fff',
    fontSize: fs(14),
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
  retryBtn: { paddingHorizontal: fs(24), paddingVertical: fs(10), borderRadius: fs(10) },
});