// Playlist page: header (title / channel / count / play-all), paginated
// numbered video list.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { ItemRow } from '../components/YouTubeCards';
import makeYoutubeApi from '../services/youtubeApi';

export default function YoutubePlaylistScreen({ token, playlist, onBack, onPlay, onOpenChannel, dlMap, onDownload }) {
  const { theme } = useTheme();
  const api = makeYoutubeApi(token);
  const playlistId = playlist?.playlistId || '';
  const localMode = !!playlist?.local;
  const [pl, setPl] = useState(null);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const nextTokenRef = useRef(null);
  const reqIdRef = useRef(0);

  const fetchPage = useCallback(
    async (navToken, replace) => {
      if (replace) reqIdRef.current += 1;
      const rid = reqIdRef.current;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError('');
      try {
        const res = await api.playlist(playlistId, navToken);
        if (rid !== reqIdRef.current) return;
        if (res.title) setPl(res);
        const next = res.videos || [];
        setVideos((prev) => (replace ? next : [...prev, ...next]));
        nextTokenRef.current = res.nextToken || null;
        setHasMore(!!res.hasMore && !!res.nextToken);
      } catch (e) {
        if (rid === reqIdRef.current && replace) setError('Could not load this playlist.');
      } finally {
        if (rid === reqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, playlistId]
  );

  useEffect(() => {
    if (localMode) {
      setPl({ title: playlist.title || 'Playlist', videoCount: playlist.count, channelTitle: '' });
      setVideos(playlist.videos || []);
      setHasMore(false);
      setLoading(false);
      return;
    }
    fetchPage(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistId]);

  const loadMore = () => {
    if (!hasMore || loadingMore || loading) return;
    fetchPage(nextTokenRef.current, false);
  };

  const playAll = () => {
    if (videos.length && onPlay) onPlay(videos[0]);
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="arrow-back" size={23} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>{pl?.title || 'Playlist'}</Text>
      </View>

      {loading && !pl ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : error && !pl ? (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => fetchPage(null, true)}>
            <Text style={{ color: theme.primary, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={videos}
          keyExtractor={(v, i) => v.videoId || `k${i}`}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
          renderItem={({ item }) => (
            <ItemRow
              item={item}
              index={item.index}
              dlMap={dlMap}
              onPress={onPlay}
              onDownload={onDownload}
            />
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <View>
              <View style={styles.hero}>
                {pl?.thumbnailUrl ? (
                  <Image source={{ uri: pl.thumbnailUrl }} style={styles.heroThumb} resizeMode="cover" />
                ) : (
                  <View style={[styles.heroThumb, { backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center' }]}>
                    <Icon name="list" size={34} color={theme.textSecondary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.playlistTitle, { color: theme.text }]} numberOfLines={2}>{pl?.title}</Text>
                  <TouchableOpacity onPress={() => onOpenChannel && onOpenChannel({ channelTitle: pl?.channelTitle })} disabled={!pl?.channelTitle}>
                    <Text style={[styles.playlistChannel, { color: theme.textSecondary }]} numberOfLines={1}>{pl?.channelTitle}</Text>
                  </TouchableOpacity>
                  <Text style={[styles.playlistMeta, { color: theme.textSecondary }]}>
                    {pl?.videoCount ? `${pl.videoCount} videos` : `${videos.length} videos`}
                  </Text>
                </View>
              </View>
              <TouchableOpacity style={[styles.playAllBtn, { backgroundColor: theme.primary }]} onPress={playAll} disabled={!videos.length}>
                <Icon name="play" size={16} color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: fs(14), marginLeft: 6 }}>Play all</Text>
              </TouchableOpacity>
            </View>
          }
          ListEmptyComponent={
            loading ? null : (
              <Text style={[styles.hint, { color: theme.textSecondary, textAlign: 'center', marginTop: 24 }]}>
                {error || 'No videos here.'}
              </Text>
            )
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator color={theme.primary} style={{ marginVertical: 16 }} /> : null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 10, paddingBottom: 8, gap: 6 },
  backBtn: { padding: 6 },
  headerTitle: { fontSize: fs(15), fontWeight: '700', flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: fs(13), paddingHorizontal: 30, textAlign: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 18 },
  hero: { flexDirection: 'row', gap: 14, marginTop: 10 },
  heroThumb: { width: 132, height: 88, borderRadius: 12, backgroundColor: '#000' },
  playlistTitle: { fontSize: fs(16), fontWeight: '800', lineHeight: 21 },
  playlistChannel: { fontSize: fs(13), fontWeight: '600', marginTop: 6, color: '#8B5CF6' },
  playlistMeta: { fontSize: fs(12), marginTop: 3 },
  playAllBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 11, borderRadius: 20, marginVertical: 16 },
});