import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Image, StyleSheet, Modal, ActivityIndicator, Dimensions,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { SERVER_URL } from '../config';
import { fs } from '../utils/size';
import { enqueue, subscribe, thumbUrl, fmtSize } from '../services/downloadsStore';

const FALLBACK_CATEGORIES = [
  { id: 'trending', label: 'Trending' },
  { id: 'music', label: 'Music' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'news', label: 'News' },
];

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export default function YoutubeHomeScreen({ token, refreshTick = 0, onOpenChats, onOpenSettings, onChangeToShorts }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const nextPageTokenRef = useRef(null);
  const [error, setError] = useState('');
  const [watch, setWatch] = useState(null);
  const [shortsStrip, setShortsStrip] = useState([]);
  const [dlMap, setDlMap] = useState({});
  const requestIdRef = useRef(0);
  const [categories] = useState(FALLBACK_CATEGORIES);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  useEffect(() => {
    return subscribe((list) => {
      const m = {};
      list.forEach((e) => {
        if (e.status === 'done' || e.status === 'downloading' || e.status === 'resolving' || e.status === 'error') {
          m[e.videoId] = e;
        }
      });
      setDlMap(m);
    });
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
        if (opts.replace) nextPageTokenRef.current = data.nextPageToken;
        else nextPageTokenRef.current = data.nextPageToken;
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

  // Fast "Shorts" strip under the categories (lightweight, reused reels feed).
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
    enqueue(v).catch(() => {});
  };

  const width = Dimensions.get('window').width;
  const cardW = (width - 20 - 16 * 2) / 2;

  const renderCard = ({ item }) => {
    const dl = dlMap[item.videoId];
    return (
      <TouchableOpacity
        style={[styles.card, { width: cardW }]}
        activeOpacity={0.82}
        onPress={() => setWatch(item)}
      >
        <View style={styles.thumbWrap}>
          <Image source={{ uri: thumbUrl(item) }} style={styles.thumb} resizeMode="cover" />
          <View style={styles.thumbBadge}>
            <Text style={styles.thumbBadgeText}>{fmtDuration(item.durationSeconds)}</Text>
          </View>
          <TouchableOpacity
            style={styles.dlBtn}
            onPress={() => (dl && dl.status === 'done' ? null : startDownload(item))}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {dl ? (
              <Icon name={dl.status === 'done' ? 'checkmark-circle' : 'time-outline'} size={16} color="#fff" />
            ) : (
              <Icon name="download-outline" size={16} color="#fff" />
            )}
          </TouchableOpacity>
          {dl && (dl.status === 'downloading' || dl.status === 'resolving') && (
            <View style={styles.dlBar}>
              <View style={[styles.dlBarFill, { width: `${Math.max(3, dl.progress)}%` }]} />
            </View>
          )}
        </View>
        <Text style={[styles.cardTitle, { color: theme.text }]} numberOfLines={2}>{item.title}</Text>
        <Text style={[styles.cardChannel, { color: theme.textSecondary }]} numberOfLines={1}>{item.channelTitle}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.brand, { color: theme.primary }]}>Tojey</Text>
          <Text style={[styles.tagline, { color: theme.textSecondary }]}>YouTube inside</Text>
        </View>
        <TouchableOpacity onPress={onOpenChats} style={styles.headerBtn}>
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
          renderItem={renderCard}
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

      {!!watch && (
        <WatchModal item={watch} authHeaders={authHeaders} onClose={() => setWatch(null)} dlMap={dlMap} onDownload={startDownload} />
      )}
    </View>
  );
}

function WatchModal({ item, authHeaders, onClose, dlMap, onDownload }) {
  const { theme } = useTheme();
  const dl = dlMap[item.videoId];
  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <View style={[styles.watchHeader, { backgroundColor: theme.background }]}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Icon name="arrow-back" size={22} color={theme.text} />
          </TouchableOpacity>
          <View style={{ flex: 1, marginHorizontal: 10 }}>
            <Text style={{ color: theme.text, fontSize: fs(14), fontWeight: '700' }} numberOfLines={2}>{item.title}</Text>
            <Text style={{ color: theme.textSecondary, fontSize: fs(12) }} numberOfLines={1}>{item.channelTitle}</Text>
          </View>
          <TouchableOpacity
            style={[styles.watchDl, { backgroundColor: dl && dl.status === 'done' ? theme.primaryLight : theme.primary }]}
            onPress={() => (dl && dl.status === 'done' ? null : onDownload(item))}
          >
            {dl && (dl.status === 'downloading' || dl.status === 'resolving') ? (
              <Text style={{ color: theme.primary, fontWeight: '800', fontSize: fs(12) }}>{Math.max(0, Math.round(dl.progress))}%</Text>
            ) : (
              <Icon name={dl && dl.status === 'done' ? 'checkmark' : 'download-outline'} size={18} color={dl && dl.status === 'done' ? theme.primary : '#fff'} />
            )}
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <WebView
            source={{ uri: `https://www.youtube-nocookie.com/embed/${item.videoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1` }}
            style={{ flex: 1 }}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            androidLayerType="hardware"
          />
        </View>
      </View>
    </Modal>
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
  sectionTitle: { fontSize: fs(15), fontWeight: '800', marginHorizontal: 16, marginTop: 16, marginBottom: 8 },
  row: { paddingHorizontal: 8, gap: 8, marginBottom: 12 },
  card: { marginBottom: 12 },
  thumbWrap: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  thumb: { width: '100%', height: '100%' },
  thumbBadge: {
    position: 'absolute', right: 6, bottom: 6,
    backgroundColor: 'rgba(16,11,26,0.85)',
    borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1,
  },
  thumbBadgeText: { color: '#fff', fontSize: fs(10), fontWeight: '700' },
  dlBtn: {
    position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(16,11,26,0.7)', alignItems: 'center', justifyContent: 'center',
  },
  dlBar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  dlBarFill: { height: 3, backgroundColor: '#8B5CF6' },
  cardTitle: { fontSize: fs(13), fontWeight: '600', marginTop: 6, paddingHorizontal: 2, lineHeight: 17 },
  cardChannel: { fontSize: fs(11), marginTop: 2, paddingHorizontal: 2 },
  shortsHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16 },
  shortsHeader: { fontSize: fs(16), fontWeight: '800' },
  shortsRow: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 10, gap: 8 },
  shortsThumb: { width: 92, height: 126, borderRadius: 10, backgroundColor: '#000' },
  watchHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
  },
  watchDl: {
    width: 38, height: 38, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
});