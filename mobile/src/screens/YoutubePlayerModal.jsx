// LibreTube-style player modal: device-resolved streams (react-native-video)
// with quality/speed/audio-only, backend metadata (RYD + SponsorBlock), chapters,
// related videos, watch history and save/playlist/subscribe actions. Falls back
// to the YouTube embed if direct streaming fails.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Image, ScrollView, FlatList,
  StyleSheet, ActivityIndicator, Dimensions,
} from 'react-native';
import Video from 'react-native-video';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { thumbUrl } from '../services/downloadsStore';
import { getStreams } from '../services/innertube';
import makeYoutubeApi from '../services/youtubeApi';
import {
  addHistory, isBookmarked, toggleBookmark, isSubscribed, toggleSubscribe,
  playlistNames, itemInPlaylist, togglePlaylistItem,
} from '../services/library';

const QUALITIES = [144, 240, 360, 480, 720, 1080, 2160];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function fmt(sec) {
  if (!sec || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export default function YoutubePlayerModal({ item: initial, authHeaders, token, onClose, onOpenChannel, onOpenPlaylist, onDownload, dlMap }) {
  const { theme } = useTheme();
  const [cur, setCur] = useState(initial);
  const videoRef = useRef(null);

  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stream, setStream] = useState(null);
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [useNative, setUseNative] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [maxHeight, setMaxHeight] = useState(720);
  const [streaming, setStreaming] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [saved, setSaved] = useState(isBookmarked(initial.videoId));
  const [subbed, setSubbed] = useState(isSubscribed(initial.channelId));
  const [playlistsDirty, setPlaylistsDirty] = useState(0);

  useEffect(() => {
    playlistNames();
  }, [playlistsDirty]);

  const api = makeYoutubeApi(token);

  const loadVideo = (v) => {
    setCur(v);
    setLoading(true);
    setInfo(null);
    setStream(null);
    setPos(0);
    setDur(0);
    setMaxHeight(720);
    setSpeed(1);
    setUseNative(true);
    setAudioOnly(false);
    setSaved(isBookmarked(v.videoId));
    setSubbed(isSubscribed(v.channelId));
    addHistory(v).catch(() => {});
    Promise.all([
      api.video(v.videoId).catch(() => null),
      getStreams(v.videoId, { maxHeight: 720 }).catch(() => null),
    ]).then(([i, s]) => {
      setInfo(i);
      setStream(s);
      if (i && i.lengthSeconds) setDur(i.lengthSeconds);
      setLoading(false);
    });
  };

  useEffect(() => {
    loadVideo(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.videoId]);

  const selectQuality = async (height) => {
    if (height === maxHeight || loading) return;
    setStreaming(true);
    try {
      const s = await getStreams(cur.videoId, { maxHeight: height });
      if (s) {
        setMaxHeight(height);
        setStream(s);
      }
    } catch (e) {}
    setStreaming(false);
  };

  const onProgress = (p) => {
    const t = p.currentTime || 0;
    setPos(t);
    const segs = info?.sponsorSegments || [];
    for (const seg of segs) {
      if (t >= seg.start && t < seg.end) {
        if (videoRef.current) videoRef.current.seek(seg.end);
        return;
      }
    }
  };

  const toggleSaved = async () => {
    setSaved(await toggleBookmark({
      videoId: cur.videoId,
      title: info?.title || cur.title,
      thumbnailUrl: cur.thumbnailUrl,
      durationSeconds: dur || cur.durationSeconds,
      channelTitle: cur.channelTitle || info?.channel,
      channelId: cur.channelId || info?.channelId,
    }));
  };

  const toggleSub = async () => {
    const ch = {
      channelId: cur.channelId || info?.channelId,
      channelTitle: cur.channelTitle || info?.channel,
      avatar: cur.thumbnailUrl || (info?.channel ? '' : ''),
    };
    if (!ch.channelId) return;
    setSubbed(await toggleSubscribe(ch));
  };

  const togglePlaylist = async (name) => {
    await togglePlaylistItem(name, {
      videoId: cur.videoId,
      title: info?.title || cur.title,
      thumbnailUrl: cur.thumbnailUrl,
      durationSeconds: dur || cur.durationSeconds,
      channelTitle: cur.channelTitle || info?.channel,
      channelId: cur.channelId || info?.channelId,
    });
    setPlaylistsDirty((x) => x + 1);
  };

  const dl = dlMap || {};
  const dlState = dl[cur.videoId];

  const streamSrc = (audioOnly ? stream?.audioUrl : stream?.videoUrl) || stream?.videoUrl;

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { backgroundColor: theme.background }]}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Icon name="chevron-down" size={24} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.textSecondary }]} numberOfLines={1}>
            Now playing
          </Text>
          <View style={{ width: 30 }} />
        </View>

        <View style={styles.videoWrap}>
          {loading ? (
            <View style={styles.videoLoading}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : useNative && stream && streamSrc ? (
            <Video
              ref={videoRef}
              source={{ uri: streamSrc }}
              style={styles.video}
              paused={!playing}
              resizeMode="contain"
              controls
              onLoad={(m) => { if (m.duration) setDur(m.duration); }}
              onProgress={onProgress}
              onEnd={() => setPlaying(false)}
              onError={() => setUseNative(false)}
              rate={speed}
              playInBackground={audioOnly}
              ignoreSilentSwitch="ignore"
              mixWithOthers="inherit"
            />
          ) : (
            <WebView
              source={{ uri: `https://www.youtube-nocookie.com/embed/${cur.videoId}?autoplay=1&playsinline=1&rel=0&modestbranding=1${Math.round(pos) ? `&start=${Math.round(pos)}` : ''}` }}
              style={{ flex: 1 }}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              androidLayerType="hardware"
            />
          )}
          {streaming && (
            <View style={styles.streamingBadge}>
              <ActivityIndicator color="#fff" size="small" />
            </View>
          )}
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: theme.text }]}>{info?.title || cur.title}</Text>
            <TouchableOpacity
              onPress={() => {
                onClose && onClose();
                onOpenChannel && onOpenChannel({
                  channelId: cur.channelId || info?.channelId,
                  channelTitle: cur.channelTitle || info?.channel,
                  avatar: cur.thumbnailUrl || '',
                });
              }}
            >
              <Text style={[styles.channel, { color: theme.primary }]}>{cur.channelTitle || info?.channel}</Text>
            </TouchableOpacity>
            <View style={styles.metaRow}>
              {info?.viewCount ? <Text style={[styles.meta, { color: theme.textSecondary }]}>{Number(info.viewCount).toLocaleString()} views</Text> : null}
              {info?.publishedTime ? <Text style={[styles.meta, { color: theme.textSecondary }]}>{info.publishedTime}</Text> : null}
              {info?.likeCount ? <Text style={[styles.meta, { color: theme.textSecondary }]}>👍 {info.likeCount}</Text> : null}
              {info?.ryd?.dislikes ? <Text style={[styles.meta, { color: theme.textSecondary }]}>👎 {info.ryd.dislikes.toLocaleString()}</Text> : null}
            </View>

            <View style={styles.toolRow}>
              <TouchableOpacity style={styles.toolBtn} onPress={() => onDownload && onDownload(cur)}>
                <Icon name={dlState && dlState.status === 'done' ? 'checkmark-circle' : 'download-outline'} size={20} color={theme.text} />
                <Text style={[styles.toolText, { color: theme.text }]}>Download</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolBtn} onPress={toggleSaved}>
                <Icon name={saved ? 'bookmark' : 'bookmark-outline'} size={20} color={saved ? theme.primary : theme.text} />
                <Text style={[styles.toolText, { color: theme.text }]}>{saved ? 'Saved' : 'Save'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolBtn} onPress={toggleSub} disabled={!cur.channelId && !info?.channelId}>
                <Icon name={subbed ? 'notifications' : 'notifications-outline'} size={20} color={subbed ? theme.primary : theme.text} />
                <Text style={[styles.toolText, { color: theme.text }]}>{subbed ? 'Subscribed' : 'Subscribe'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolBtn} onPress={() => setShowPlaylist(!showPlaylist)}>
                <Icon name="list-outline" size={20} color={theme.text} />
                <Text style={[styles.toolText, { color: theme.text }]}>Playlist</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolBtn} onPress={() => setAudioOnly(!audioOnly)} disabled={!stream?.audioUrl}>
                <Icon name="headset-outline" size={20} color={audioOnly ? theme.primary : theme.text} />
                <Text style={[styles.toolText, { color: theme.text }]}>Audio</Text>
              </TouchableOpacity>
            </View>

            {showPlaylist && (
              <View style={[styles.playlistPanel, { backgroundColor: theme.inputBg }]}>
                <Text style={[styles.playlistTitle, { color: theme.text }]}>Add to playlist</Text>
                {playlistNames().length === 0 ? (
                  <Text style={{ color: theme.textSecondary, fontSize: fs(12) }}>Create a playlist in Library first.</Text>
                ) : (
                  playlistNames().map((name) => (
                    <TouchableOpacity key={name} style={styles.playlistRow} onPress={() => togglePlaylist(name)}>
                      <Icon name={itemInPlaylist(name, cur.videoId) ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={itemInPlaylist(name, cur.videoId) ? theme.primary : theme.textSecondary} />
                      <Text style={{ color: theme.text, fontSize: fs(13), fontWeight: '600', marginLeft: 8 }}>{name}</Text>
                    </TouchableOpacity>
                  ))
                )}
              </View>
            )}

            <View style={styles.speedRow}>
              <Text style={[styles.speedLabel, { color: theme.textSecondary }]}>Speed</Text>
              {SPEEDS.map((s) => (
                <TouchableOpacity key={s} style={[styles.speedChip, { backgroundColor: speed === s ? theme.primary : theme.inputBg }]} onPress={() => setSpeed(s)}>
                  <Text style={{ color: speed === s ? '#fff' : theme.text, fontSize: fs(12), fontWeight: '700' }}>{s}×</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.speedRow}>
              <Text style={[styles.speedLabel, { color: theme.textSecondary }]}>Quality</Text>
              {QUALITIES.map((h) => (
                <TouchableOpacity key={h} style={[styles.speedChip, { backgroundColor: maxHeight === h ? theme.primary : theme.inputBg }]} onPress={() => selectQuality(h)}>
                  <Text style={{ color: maxHeight === h ? '#fff' : theme.text, fontSize: fs(12), fontWeight: '700' }}>{h}p</Text>
                </TouchableOpacity>
              ))}
            </View>

            {dur > 0 && (
              <View style={styles.progressRow}>
                <Text style={[styles.progressText, { color: theme.textSecondary }]}>{fmt(pos)}</Text>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${dur ? Math.min(100, (pos / dur) * 100) : 0}%` }]} />
                </View>
                <Text style={[styles.progressText, { color: theme.textSecondary }]}>{fmt(dur)}</Text>
              </View>
            )}

            {!!info?.sponsorSegments && info.sponsorSegments.length > 0 && (
              <Text style={{ color: theme.textSecondary, fontSize: fs(11), marginTop: 8 }}>
                ⏭ SponsorBlock: {info.sponsorSegments.length} segment{info.sponsorSegments.length > 1 ? 's' : ''} will be skipped
              </Text>
            )}

            {!!info?.description && (
              <View style={[styles.descBox, { backgroundColor: theme.inputBg }]}>
                <Text style={[styles.desc, { color: theme.text }]} numberOfLines={descOpen ? 0 : 4}>
                  {info.description}
                </Text>
                <TouchableOpacity onPress={() => setDescOpen(!descOpen)}>
                  <Text style={{ color: theme.primary, fontSize: fs(12), fontWeight: '700', marginTop: 4 }}>
                    {descOpen ? 'Show less' : 'Show more'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {!!info?.chapters && info.chapters.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Chapters</Text>
              {info.chapters.map((ch, i) => (
                <TouchableOpacity key={i} style={styles.chapterRow} onPress={() => { if (videoRef.current && useNative) videoRef.current.seek(ch.start); }}>
                  <Text style={[styles.chapterTime, { color: theme.primary }]}>{fmt(ch.start)}</Text>
                  <Text style={[styles.chapterTitle, { color: theme.text }]} numberOfLines={2}>{ch.title}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Up next</Text>
            {loading || !info ? (
              <ActivityIndicator color={theme.primary} style={{ marginVertical: 20 }} />
            ) : info.related && info.related.length ? (
              <FlatList
                data={info.related}
                keyExtractor={(r, i) => r.videoId || r.playlistId || `r${i}`}
                scrollEnabled={false}
                renderItem={({ item: r }) => {
                  if (r.type === 'playlist') {
                    return (
                      <TouchableOpacity style={styles.relRow} onPress={() => { onClose && onClose(); onOpenPlaylist && onOpenPlaylist(r.playlistId); }}>
                        <View style={styles.relThumbWrap}>
                          <Image source={{ uri: thumbUrl(r) }} style={styles.relThumb} resizeMode="cover" />
                          <View style={styles.relPlayBadge}>
                            <Icon name="play" size={12} color="#fff" />
                          </View>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.relText, { color: theme.text }]} numberOfLines={2}>{r.title}</Text>
                          <Text style={{ color: theme.textSecondary, fontSize: fs(11) }} numberOfLines={1}>{r.channelTitle}</Text>
                        </View>
                        <Icon name="list" size={15} color={theme.textSecondary} />
                      </TouchableOpacity>
                    );
                  }
                  if (r.type === 'channel') {
                    return (
                      <TouchableOpacity style={styles.relRow} onPress={() => { onClose && onClose(); onOpenChannel && onOpenChannel(r); }}>
                        <Image source={{ uri: thumbUrl(r) }} style={styles.relAvatar} resizeMode="cover" />
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.relText, { color: theme.text }]} numberOfLines={1}>{r.channelTitle}</Text>
                          <Text style={{ color: theme.textSecondary, fontSize: fs(11) }}>{r.subscribers}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  }
                  return (
                    <TouchableOpacity style={styles.relRow} onPress={() => loadVideo(r)}>
                      <View style={styles.relThumbWrap}>
                        <Image source={{ uri: thumbUrl(r) }} style={styles.relThumb} resizeMode="cover" />
                        <View style={styles.relDur}>
                          <Text style={{ color: '#fff', fontSize: fs(10), fontWeight: '700' }}>{fmt(r.durationSeconds)}</Text>
                        </View>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.relText, { color: theme.text }]} numberOfLines={2}>{r.title}</Text>
                        <Text style={{ color: theme.textSecondary, fontSize: fs(11) }} numberOfLines={1}>{r.channelTitle}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />
            ) : (
              <Text style={{ color: theme.textSecondary, fontSize: fs(13), textAlign: 'center', marginTop: 16 }}>No related videos.</Text>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6 },
  headerBtn: { padding: 6, width: 30 },
  headerTitle: { fontSize: fs(13), fontWeight: '600' },
  videoWrap: { height: Dimensions.get('window').width * 9 / 16, backgroundColor: '#000' },
  video: { flex: 1 },
  videoLoading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  streamingBadge: { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(16,11,26,0.7)', borderRadius: 14, padding: 8 },
  titleBlock: { paddingHorizontal: 16, paddingTop: 12 },
  title: { fontSize: fs(16), fontWeight: '800', lineHeight: 22 },
  channel: { fontSize: fs(14), fontWeight: '700', marginTop: 8 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  meta: { fontSize: fs(12) },
  toolRow: { flexDirection: 'row', marginTop: 14, gap: 18 },
  toolBtn: { alignItems: 'center', gap: 3, minWidth: 40 },
  toolText: { fontSize: fs(11), fontWeight: '600' },
  playlistPanel: { borderRadius: 12, padding: 12, marginTop: 12 },
  playlistTitle: { fontSize: fs(13), fontWeight: '800', marginBottom: 8 },
  playlistRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  speedRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  speedLabel: { fontSize: fs(12), fontWeight: '700', marginRight: 4 },
  speedChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  progressText: { fontSize: fs(11), fontWeight: '600' },
  progressTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: '#8B5CF6' },
  descBox: { borderRadius: 12, padding: 12, marginTop: 12 },
  desc: { fontSize: fs(12), lineHeight: 18 },
  section: { paddingHorizontal: 16, marginTop: 22 },
  sectionTitle: { fontSize: fs(15), fontWeight: '800', marginBottom: 10 },
  chapterRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  chapterTime: { fontSize: fs(12), fontWeight: '700', width: 52 },
  chapterTitle: { flex: 1, fontSize: fs(13) },
  relRow: { flexDirection: 'row', marginBottom: 12, gap: 10 },
  relThumbWrap: { width: 150, height: 84, borderRadius: 10, overflow: 'hidden', backgroundColor: '#000' },
  relThumb: { width: '100%', height: '100%' },
  relText: { fontSize: fs(13), fontWeight: '700' },
  relDur: { position: 'absolute', right: 4, bottom: 4, backgroundColor: 'rgba(16,11,26,0.85)', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  relPlayBadge: { position: 'absolute', right: 4, bottom: 4, backgroundColor: 'rgba(16,11,26,0.7)', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  relAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#000' },
});