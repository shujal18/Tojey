import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Dimensions,
  Platform,
  Image,
  ActivityIndicator,
  RefreshControl,
  AppState,
} from 'react-native';
import Video from 'react-native-video';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { absUrl, SERVER_URL } from '../config';
import Toast from '../components/Toast';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

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
const PRELOAD_WINDOW = 2;

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
  const isMountedRef = useRef(true);
  const prefetchedRef = useRef(new Set());
  const loadingPageRef = useRef(false);
  const appVisibleRef = useRef(true);
  const userInteractedRef = useRef(false);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  const fetchFeed = useCallback(async (cat, isRefresh = false, append = false) => {
    if (loadingPageRef.current) return;
    loadingPageRef.current = true;

    try {
      if (!append) setLoading(true);
      if (isRefresh) setRefreshing(true);
      setError(null);

      const res = await fetch(`${SERVER_URL}/api/reels/feed?category=${cat}&refresh=${isRefresh}`, {
        headers: authHeaders,
      });
      const data = await res.json();

      if (!isMountedRef.current) return;

      if (!res.ok) {
        throw new Error(data.error || 'Failed to load feed');
      }

      if (append) {
        setVideos(prev => {
          const existingIds = new Set(prev.map(v => v.videoId));
          const newVideos = data.videos.filter(v => !existingIds.has(v.videoId));
          return [...prev, ...newVideos];
        });
      } else {
        setVideos(data.videos);
      }
    } catch (e) {
      if (!isMountedRef.current) return;
      setError(e.message);
      setToast(e.message);
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingPageRef.current = false;
      }
    }
  }, [authHeaders]);

  const handleCategoryChange = useCallback((cat) => {
    if (cat === category) return;
    setCategory(cat);
    setVideos([]);
    fetchFeed(cat, false, false);
  }, [category, fetchFeed]);

  const loadMore = useCallback(() => {
    if (videos.length && !loading && !loadingPageRef.current) {
      fetchFeed(category, false, true);
    }
  }, [category, videos.length, loading, fetchFeed]);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    if (!viewableItems || !viewableItems.length) return;
    const newIndex = viewableItems[0].index;
    if (newIndex !== activeIndexRef.current) {
      activeIndexRef.current = newIndex;
      userInteractedRef.current = false;

      const newPlayer = videoPlayersRef.current[newIndex];
      if (newPlayer) {
        newPlayer.seek(0);
        newPlayer.play();
      }

      Object.keys(videoPlayersRef.current).forEach(key => {
        const idx = parseInt(key, 10);
        if (idx !== newIndex) {
          const player = videoPlayersRef.current[idx];
          if (player) player.pause();
        }
      });

      const nextIdx = newIndex + 1;
      const prevIdx = newIndex - 1;

      if (nextIdx < videos.length && !prefetchedRef.current.has(nextIdx)) {
        prefetchedRef.current.add(nextIdx);
        const nextPlayer = videoPlayersRef.current[nextIdx];
        if (nextPlayer) nextPlayer.load();
      }
      if (prevIdx >= 0 && !prefetchedRef.current.has(prevIdx)) {
        prefetchedRef.current.add(prevIdx);
        const prevPlayer = videoPlayersRef.current[prevIdx];
        if (prevPlayer) prevPlayer.load();
      }

      if (nextIdx >= videos.length - 3) {
        loadMore();
      }
    }
  }, [videos.length, loadMore]);

  const onVideoRef = useCallback((index, ref) => {
    videoPlayersRef.current[index] = ref;
    if (prefetchedRef.current.has(index) && ref) {
      ref.load();
    }
  }, []);

  const handleVideoEnd = useCallback((index) => {
    if (index === activeIndexRef.current && isMountedRef.current) {
      const player = videoPlayersRef.current[index];
      if (player) {
        player.seek(0);
        player.play();
      }
    }
  }, []);

  const handleVideoError = useCallback((index) => {
    if (index === activeIndexRef.current && isMountedRef.current) {
      setToast('Video unavailable, skipping...');
      setTimeout(() => {
        if (index < videos.length - 1 && flatListRef.current) {
          flatListRef.current.scrollToIndex({ index: index + 1, animated: true });
        }
      }, 1000);
    }
  }, [videos.length]);

  const handleVideoLoad = useCallback((index) => {
    if (index === activeIndexRef.current && !userInteractedRef.current && appVisibleRef.current) {
      const player = videoPlayersRef.current[index];
      if (player) player.play();
    }
  }, []);

  const onTouchStart = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  const onTouchEnd = useCallback((index) => {
    if (index === activeIndexRef.current) {
      const player = videoPlayersRef.current[index];
      if (player) player.pause();
      userInteractedRef.current = true;
    }
  }, []);

  const onTouchEndResume = useCallback((index) => {
    if (index === activeIndexRef.current) {
      const player = videoPlayersRef.current[index];
      if (player) player.play();
      userInteractedRef.current = false;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    fetchFeed(category, false, false);

    const subscription = AppState.addEventListener('change', (nextState) => {
      appVisibleRef.current = nextState === 'active';
      if (nextState === 'active') {
        const player = videoPlayersRef.current[activeIndexRef.current];
        if (player) player.play();
      } else {
        Object.values(videoPlayersRef.current).forEach(p => {
          if (p) p.pause();
        });
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.remove();
      Object.values(videoPlayersRef.current).forEach(p => {
        try { if (p) p.pause(); } catch (e) {}
      });
    };
  }, [category]);

  useEffect(() => {
    const interval = setInterval(() => {
      clearOldCache();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const clearOldCache = async () => {
    try {
      await fetch(`${SERVER_URL}/api/reels/feed?category=trending&refresh=true`, { method: 'GET', headers: authHeaders });
    } catch (e) {}
  };

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
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{
          itemVisiblePercentThreshold: 75,
          minimumViewTime: 100,
          waitForInteraction: true,
        }}
        viewabilityConfigCallbackPairs={[{ viewabilityConfig: { itemVisiblePercentThreshold: 75 }, onViewableItemsChanged }]}
        onScrollEndDrag={loadMore}
        onMomentumScrollEnd={loadMore}
        renderItem={({ item, index }) => (
          <View style={styles.videoContainer} onTouchStart={onTouchStart}>
            <Video
              ref={ref => onVideoRef(index, ref)}
              source={{ uri: `https://www.youtube.com/watch?v=${item.videoId}` }}
              style={styles.video}
              resizeMode="cover"
              paused={index !== activeIndexRef.current || !appVisibleRef.current}
              repeat={true}
              muted={false}
              volume={1.0}
              rate={1.0}
              onLoad={() => handleVideoLoad(index)}
              onEnd={() => handleVideoEnd(index)}
              onError={() => handleVideoError(index)}
              onTouchStart={onTouchStart}
              onTouchEnd={() => onTouchEnd(index)}
              onTouchCancel={() => onTouchEnd(index)}
              progressUpdateInterval={500}
              useTextureView={true}
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
              <View style={styles.actions}>
                <TouchableOpacity style={styles.actionBtn} onPress={() => {}}>
                  <Icon name="heart-outline" size={28} color="#fff" />
                  <Text style={styles.actionLabel}>Like</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => {}}>
                  <Icon name="chatbubble-outline" size={28} color="#fff" />
                  <Text style={styles.actionLabel}>Comment</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => {}}>
                  <Icon name="share-outline" size={28} color="#fff" />
                  <Text style={styles.actionLabel}>Share</Text>
                </TouchableOpacity>
              </View>
            </View>
            <TouchableOpacity
              onPress={() => onTouchEndResume(index)}
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
            />
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingBottom: 30,
    paddingHorizontal: 20,
  },
  actionBtn: {
    alignItems: 'center',
    gap: 4,
    opacity: 0.9,
  },
  actionLabel: { color: '#fff', fontSize: fs(11), fontWeight: '500' },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyText: { fontSize: fs(15), marginTop: 12 },
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  errorText: { fontSize: fs(15), textAlign: 'center' },
  retryBtn: { paddingHorizontal: fs(24), paddingVertical: fs(10), borderRadius: fs(10) },
});

