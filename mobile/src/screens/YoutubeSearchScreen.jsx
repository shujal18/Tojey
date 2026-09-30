// YouTube search: query box with Google suggestions, filter chips, paginated
// mixed results (videos / channels / playlists / shorts).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, Dimensions,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { VideoCard, ItemRow, ChannelRow } from '../components/YouTubeCards';
import makeYoutubeApi from '../services/youtubeApi';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'videos', label: 'Videos' },
  { id: 'channels', label: 'Channels' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'shorts', label: 'Shorts' },
];

export default function YoutubeSearchScreen({ token, onBack, onPlay, onOpenChannel, onOpenPlaylist, dlMap, onDownload }) {
  const { theme } = useTheme();
  const api = useMemo(() => makeYoutubeApi(token), [token]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [suggestions, setSuggestions] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const nextTokenRef = useRef(null);
  const reqIdRef = useRef(0);
  const width = Dimensions.get('window').width;
  const cardW = (width - 20 - 16 * 2) / 2;

  // Debounced suggestions.
  useEffect(() => {
    if (!query.trim()) {
      setSuggestions((s) => (s.length === 0 ? s : []));
      return;
    }
    const t = setTimeout(() => {
      api.suggestions(query).then(setSuggestions).catch(() => setSuggestions([]));
    }, 220);
    return () => clearTimeout(t);
  }, [query, api]);

  const runSearch = useCallback(
    async (q, f, tokenValue, replace) => {
      if (!q.trim()) {
        setItems([]);
        setHasMore(false);
        return;
      }
      if (replace) reqIdRef.current += 1;
      const rid = reqIdRef.current;
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError('');
      try {
        const res = await api.search(q, f, tokenValue);
        if (rid !== reqIdRef.current) return;
        setItems((prev) => (replace ? res.items || [] : [...prev, ...(res.items || [])]));
        nextTokenRef.current = res.nextToken || null;
        setHasMore(!!res.hasMore && !!res.nextToken);
      } catch (e) {
        if (rid === reqIdRef.current && replace) setError('Search unavailable right now.');
      } finally {
        if (rid === reqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api]
  );

  const submit = () => {
    setSuggestions([]);
    if (query.trim()) runSearch(query, filter, null, true);
  };

  const submitSuggestion = (s) => {
    setQuery(s);
    setSuggestions([]);
    runSearch(s, filter, null, true);
  };

  const changeFilter = (f) => {
    setFilter(f);
    if (query.trim()) runSearch(query, f, null, true);
  };

  const loadMore = () => {
    if (!hasMore || loadingMore || loading) return;
    runSearch(query, filter, nextTokenRef.current, false);
  };

  const renderItem = ({ item }) => {
    if (item.type === 'channel') {
      return <ChannelRow item={item} onPress={(it) => onOpenChannel && onOpenChannel(it)} />;
    }
    if (item.type === 'playlist') {
      return (
        <ItemRow
          item={item}
          onPress={(it) => onOpenPlaylist && onOpenPlaylist(it.playlistId)}
          trailing={<Icon name="list" size={16} color={theme.textSecondary} />}
        />
      );
    }
    if (item.type === 'shorts' || filter === 'shorts') {
      return (
        <TouchableOpacity style={styles.shortsRow} activeOpacity={0.8} onPress={() => onPlay && onPlay(item)}>
          {item.thumbnailUrl ? (
            <Image source={{ uri: item.thumbnailUrl }} style={styles.shortThumb} resizeMode="cover" />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={[styles.shortTitle, { color: theme.text }]} numberOfLines={2}>{item.title}</Text>
            <Text style={[styles.shortMeta, { color: theme.textSecondary }]} numberOfLines={1}>{item.channelTitle}</Text>
          </View>
        </TouchableOpacity>
      );
    }
    if (filter === 'videos') return <VideoCard item={item} width={cardW} dlMap={dlMap} onPress={onPlay} onDownload={onDownload} />;
    return (
      <ItemRow
        item={item}
        dlMap={dlMap}
        onPress={onPlay}
        onDownload={onDownload}
        trailing={item.type === 'shorts' ? <Icon name="play-circle" size={16} color={theme.textSecondary} /> : undefined}
      />
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="arrow-back" size={23} color={theme.text} />
        </TouchableOpacity>
        <View style={[styles.inputWrap, { backgroundColor: theme.inputBg }]}>
          <Icon name="search" size={16} color={theme.textSecondary} />
          <TextInput
            style={[styles.input, { color: theme.text }]}
            placeholder="Search YouTube"
            placeholderTextColor={theme.textSecondary}
            value={query}
            onChangeText={setQuery}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Icon name="close-circle" size={16} color={theme.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {suggestions.length > 0 && (
        <FlatList
          data={suggestions}
          keyExtractor={(s, i) => `s${i}`}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item: s }) => (
            <TouchableOpacity style={styles.suggestion} onPress={() => submitSuggestion(s)}>
              <Icon name="search" size={15} color={theme.textSecondary} />
              <Text style={[styles.suggestionText, { color: theme.text }]} numberOfLines={1}>{s}</Text>
            </TouchableOpacity>
          )}
        />
      )}

      <View style={styles.chips}>
        {FILTERS.map((f) => {
          const active = f.id === filter;
          return (
            <TouchableOpacity
              key={f.id}
              style={[styles.chip, { backgroundColor: active ? theme.primary : theme.inputBg }]}
              onPress={() => changeFilter(f.id)}
            >
              <Text style={[styles.chipText, { color: active ? '#fff' : theme.textSecondary }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
        </View>
      ) : !query.trim() && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>Search for videos, channels and playlists</Text>
        </View>
      ) : error && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => runSearch(query, filter, null, true)}>
            <Text style={{ color: theme.primary, fontWeight: '700' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it, i) => it.videoId || it.channelId || it.playlistId || `k${i}`}
          numColumns={filter === 'all' ? 1 : filter === 'videos' ? 2 : 1}
          columnWrapperStyle={filter === 'videos' ? styles.row : null}
          contentContainerStyle={{ paddingHorizontal: filter === 'videos' ? 16 : 16, paddingBottom: 16 }}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          keyboardShouldPersistTaps="handled"
          key={filter === 'videos' ? 'grid2' : 'list1'}
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
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 22, paddingHorizontal: 12, height: 40, gap: 8 },
  input: { flex: 1, fontSize: fs(14), padding: 0 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  chip: { paddingHorizontal: 13, paddingVertical: 6, borderRadius: 16 },
  chipText: { fontSize: fs(12), fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: fs(13), paddingHorizontal: 30, textAlign: 'center' },
  retry: { marginTop: 14, paddingHorizontal: 20, paddingVertical: 8, borderRadius: 18 },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 10 },
  suggestionText: { fontSize: fs(13), flex: 1 },
  row: { gap: 10, marginBottom: 12 },
  shortsRow: { flexDirection: 'row', gap: 12, marginBottom: 14, alignItems: 'center' },
  shortThumb: { width: 92, height: 126, borderRadius: 10, backgroundColor: '#000' },
  shortTitle: { fontSize: fs(13), fontWeight: '700', lineHeight: 17 },
  shortMeta: { fontSize: fs(11), marginTop: 4 },
});