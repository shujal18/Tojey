// Native player modal: backend-proxied DASH (adaptive HD + AAC) with the same
// muxed progressive proxy as a fallback, quality/speed/audio-only controls,
// backend metadata (RYD + SponsorBlock), chapters, related videos, watch
// history and save/playlist/subscribe actions.
//
// Playback is native only. This modal previously fell back to a YouTube embed
// WebView when a stream failed, which surfaced the iframe player's error 153
// ("player configuration error") and hid the real Media3 failure. It now reports
// the actual error and offers a retry.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Modal, Image, ScrollView, FlatList,
  StyleSheet, ActivityIndicator, Dimensions,
} from 'react-native';
import Video from 'react-native-video';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import Toast from '../components/Toast';
import { fs } from '../utils/size';
import { thumbUrl } from '../services/downloadsStore';
import { getProxyPlayback, dashProxyUrl } from '../services/ytPlayback';
import { useWatchTogether } from '../services/WatchTogetherContext';
import { pipSupported, enterPip } from '../services/pip';
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
  const wt = useWatchTogether();
  const [cur, setCur] = useState(initial);
  const videoRef = useRef(null);

  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stream, setStream] = useState(null);
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [playError, setPlayError] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [maxHeight, setMaxHeight] = useState(720);
  const [streaming, setStreaming] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showDl, setShowDl] = useState(false);
  const [pip, setPip] = useState(false);
  const [pipOk, setPipOk] = useState(false);
  const [nextVideo, setNextVideo] = useState(null);
  const [useDash, setUseDash] = useState(false);
  const nextTimerRef = useRef(null);
  const [wtText, setWtText] = useState('');
  const [wtRate, setWtRate] = useState(null);
  const suppressRef = useRef(0);
  const playingRef = useRef(playing);
  const posRef = useRef(0);
  const inRoomRef = useRef(false);
  const isHostRef = useRef(false);
  const roomVideoRef = useRef(null);
  const wtChatRef = useRef(null);

  const roomVideoId = wt.room && wt.room.videoId;
  const inRoom = !!(roomVideoId && roomVideoId === cur.videoId);
  const isHost = !!wt.isHost;
  const isGuest = inRoom && !isHost;
  const partnerName = (wt.partner && wt.partner.displayName) || 'Friend';

  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => {
    inRoomRef.current = inRoom;
    isHostRef.current = isHost;
    roomVideoRef.current = roomVideoId;
  }, [inRoom, isHost, roomVideoId]);
  useEffect(() => { if (!inRoom) setWtRate(null); }, [inRoom]);
  useEffect(() => { if (inRoom) setAudioOnly(false); }, [inRoom]);
  useEffect(() => {
    if (!inRoom || !wtChatRef.current) return;
    const t = setTimeout(() => {
      if (wtChatRef.current) wtChatRef.current.scrollToEnd({ animated: true });
    }, 60);
    return () => clearTimeout(t);
  }, [inRoom, wt.messages.length]);

  useEffect(() => {
    pipSupported().then(setPipOk).catch(() => {});
  }, []);

  const togglePip = async () => {
    if (!pipOk) return;
    const ok = await enterPip(16, 9);
    if (ok) setPip(true);
  };
  const [saved, setSaved] = useState(isBookmarked(initial.videoId));
  const [subbed, setSubbed] = useState(isSubscribed(initial.channelId));
  const [playlistsDirty, setPlaylistsDirty] = useState(0);

  useEffect(() => {
    playlistNames();
  }, [playlistsDirty]);

  const api = makeYoutubeApi(token);

  const loadVideo = (v) => {
    // Choosing a different video while sharing a room leaves that room first.
    if (inRoomRef.current && roomVideoRef.current && roomVideoRef.current !== v.videoId) {
      wt.leaveRoom();
    }
    setCur(v);
    setLoading(true);
    setInfo(null);
    setStream(null);
    setPos(0);
    setDur(0);
    setMaxHeight(720);
    setSpeed(1);
    setPlayError(null);
    setAudioOnly(false);
    setUseDash(false);
    setSaved(isBookmarked(v.videoId));
    setSubbed(isSubscribed(v.channelId));
    addHistory(v).catch(() => {});
    // Playback must not wait for metadata: /api/yt/streams can take several
    // seconds on a cold backend, while metadata is still fetched in parallel.
    // getProxyPlayback falls back to itag=best, so the player can start even if
    // the metadata request fails entirely.
    getProxyPlayback(v.videoId, token, { maxHeight: 720 })
      .then((s) => { setStream(s); setLoading(false); })
      .catch(() => setLoading(false));
    api.video(v.videoId)
      .then((i) => {
        setInfo(i);
        if (i && i.lengthSeconds) setDur(i.lengthSeconds);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadVideo(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.videoId]);

  const selectQuality = async (height) => {
    if (height === maxHeight || loading) return;
    setStreaming(true);
    // The quality picker deals in progressive (muxed) tracks. Selecting a
    // height switches off DASH so the requested cap is actually enforced.
    setUseDash(false);
    try {
      const s = await getProxyPlayback(cur.videoId, token, { maxHeight: height });
      if (s) {
        setMaxHeight(height);
        setStream(s);
      }
    } catch (e) {}
    setStreaming(false);
  };

  const onProgress = (p) => {
    const t = p.currentTime || 0;
    posRef.current = t;
    setPos(t);
    // Guests never seek locally: the host owns playback in a shared room.
    if (inRoomRef.current && !isHostRef.current) return;
    const segs = info?.sponsorSegments || [];
    for (const seg of segs) {
      if (t >= seg.start && t < seg.end) {
        if (videoRef.current) videoRef.current.seek(seg.end);
        return;
      }
    }
  };

  // Keep our paused state in sync with the native player and report genuine
  // host gestures to the authoritative room.
  const onPlaybackStateChanged = (e) => {
    if (!e || e.isSeeking) return;
    if (Date.now() < suppressRef.current) return;
    // Guests are entirely room-driven: ignore any local/native state change so
    // a headset or hardware key cannot desync the shared session.
    if (inRoomRef.current && !isHostRef.current) return;
    const nowPlaying = !!e.isPlaying;
    setPlaying(nowPlaying);
    if (inRoomRef.current && isHostRef.current) {
      wt.reportLocal(nowPlaying ? 'play' : 'pause', posRef.current);
    }
  };

  const onSeek = (e) => {
    if (Date.now() < suppressRef.current) return;
    if (inRoomRef.current && !isHostRef.current) return;
    const t = Number(e && (e.currentTime != null ? e.currentTime : e.seekTime)) || 0;
    posRef.current = t;
    setPos(t);
    if (inRoomRef.current && isHostRef.current) wt.reportLocal('seek', t);
  };

  const cancelNext = () => {
    if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
    nextTimerRef.current = null;
    setNextVideo(null);
  };

  const handleEnd = () => {
    setPlaying(false);
    // Shared rooms do not auto-advance; the host decides what happens next.
    if (inRoomRef.current) return;
    const rel = (info?.related || []).find((r) => r && r.videoId && r.type !== 'channel' && r.type !== 'playlist');
    if (!rel || !cur.videoId) return;
    setNextVideo(rel);
    if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
    nextTimerRef.current = setTimeout(() => {
      nextTimerRef.current = null;
      setNextVideo(null);
      loadVideo(rel);
    }, 4000);
  };

  useEffect(() => () => { if (nextTimerRef.current) clearTimeout(nextTimerRef.current); }, []);

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
  const dlState = dl[`${cur.videoId}:video`];
  const dlAud = dl[`${cur.videoId}:audio`];

  const dlIcon = (st) => (!st ? 'download-outline' : st.status === 'done' ? 'checkmark-circle' : st.status === 'error' ? 'close-circle' : 'time-outline');
  const dlColor = (st) => (!st ? theme.text : st.status === 'done' ? theme.primary : st.status === 'error' ? theme.danger : theme.textSecondary);

  const streamSrc = (audioOnly ? stream?.audioUrl : stream?.videoUrl) || stream?.videoUrl;
  // Prefer the adaptive manifest (HD video + separate audio, same as web).
  // If Media3 rejects it, onError below falls back to the muxed progressive
  // proxy without surfacing an error or interrupting Watch Together sync.
  const dashSrc = dashProxyUrl(cur.videoId, token);
  const usingDash = useDash && !audioOnly;
  const sourceUri = usingDash ? dashSrc : streamSrc;
  const sourceType = usingDash ? 'mpd' : 'mp4';

  // Expose a controller to the Watch Together provider. Only local playback
  // state is driven imperatively; seeking/rate changes are buffered with a
  // suppression window so room-applied changes cannot echo back as gestures.
  const registerController = wt.registerController;
  useEffect(() => {
    if (!streamSrc) {
      registerController(null);
      return undefined;
    }
    registerController({
      isReady: () => true,
      getTime: () => posRef.current,
      isPaused: () => !playingRef.current,
      play: () => { suppressRef.current = Date.now() + 900; setPlaying(true); },
      pause: () => { suppressRef.current = Date.now() + 900; setPlaying(false); },
      seek: (t) => {
        suppressRef.current = Date.now() + 1500;
        const target = Math.max(0, Number(t) || 0);
        try { if (videoRef.current) videoRef.current.seek(target); } catch (e) {}
        posRef.current = target;
        setPos(target);
      },
      setRate: (r) => {
        suppressRef.current = Date.now() + 900;
        setWtRate(Number(r) || 1);
      },
    });
    return () => registerController(null);
  }, [streamSrc, cur.videoId, registerController]);

  const handleClose = () => {
    if (inRoomRef.current) wt.leaveRoom();
    if (onClose) onClose();
  };

  const toggleWatchTogether = () => {
    if (inRoom) {
      wt.leaveRoom();
      return;
    }
    wt.sendInvite({ videoId: cur.videoId, title: info?.title || cur.title });
  };

  const sendWtMessage = () => {
    const text = wtText;
    setWtText('');
    if (text && text.trim()) wt.sendMessage(text);
  };

  return (
    <Modal visible transparent={false} animationType="slide" onRequestClose={handleClose}>
      <View style={[styles.root, { backgroundColor: theme.background }]}>
        <View style={[styles.header, { backgroundColor: theme.background }]}>
          <TouchableOpacity onPress={handleClose} style={styles.headerBtn}>
            <Icon name="chevron-down" size={24} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.textSecondary }]} numberOfLines={1}>
            {inRoom ? `Watching with ${partnerName}` : 'Now playing'}
          </Text>
          <View style={{ width: 30, alignItems: 'flex-end' }}>
            {pipOk && (
              <TouchableOpacity onPress={togglePip} style={styles.pipBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Icon name="scan-outline" size={20} color={pip ? theme.primary : theme.text} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={styles.videoWrap}>
          {loading ? (
            <View style={styles.videoLoading}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : playError ? (
            <View style={styles.videoLoading}>
              <Text style={{ color: theme.text, fontSize: fs(15), fontWeight: '700', textAlign: 'center' }}>
                Cannot play this video
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: fs(12), textAlign: 'center', marginTop: 6, paddingHorizontal: 24 }}>
                {playError}
              </Text>
              <TouchableOpacity
                onPress={() => { setPlayError(null); loadVideo(cur); }}
                style={{ marginTop: 14, paddingHorizontal: 20, paddingVertical: 9, borderRadius: 18, backgroundColor: theme.primary }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: fs(14) }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : stream && sourceUri ? (
            <Video
              ref={videoRef}
              key={sourceUri}
              source={{ uri: sourceUri, type: sourceType }}
              style={styles.video}
              paused={!playing}
              resizeMode="contain"
              controls={!isGuest}
              onLoad={(m) => { if (m.duration) setDur(m.duration); }}
              onProgress={onProgress}
              onSeek={onSeek}
              onPlaybackStateChanged={onPlaybackStateChanged}
              onEnd={handleEnd}
              onError={(p) => {
                if (usingDash && streamSrc) {
                  setUseDash(false);
                  setPlayError(null);
                  return;
                }
                setPlayError(
                  p && p.error
                    ? `Playback error ${p.error.code}${p.error.message ? `: ${p.error.message}` : ''}`
                    : 'Playback failed'
                );
              }}
              rate={inRoom && wtRate != null ? wtRate : speed}
              playInBackground={audioOnly || pip}
              ignoreSilentSwitch="ignore"
              mixWithOthers="inherit"
            />
          ) : (
            <View style={styles.videoLoading}>
              <Text style={{ color: theme.textSecondary, fontSize: fs(13), textAlign: 'center', paddingHorizontal: 24 }}>
                No playable stream for this video.
              </Text>
            </View>
          )}
          {streaming && (
            <View style={styles.streamingBadge}>
              <ActivityIndicator color="#fff" size="small" />
            </View>
          )}
          {inRoom && !!wt.bubble && (
            <View style={styles.wtBubble} pointerEvents="none">
              {wt.bubble.kind === 'reaction' ? (
                <Text style={{ fontSize: fs(18), lineHeight: fs(22) }}>{wt.bubble.emoji}</Text>
              ) : null}
              <Text style={styles.wtBubbleText} numberOfLines={1}>
                <Text style={{ fontWeight: '800' }}>
                  {(wt.bubble.by && wt.bubble.by.displayName) || 'Friend'}
                </Text>
                {wt.bubble.kind === 'message' ? `: ${wt.bubble.text}` : ' reacted'}
              </Text>
            </View>
          )}
          {isGuest && (
            <View style={styles.wtGuestChip} pointerEvents="none">
              <Icon name="lock-closed" size={11} color="#fff" />
              <Text style={styles.wtGuestText}>Host controls playback</Text>
            </View>
          )}
          {!inRoom && wt.outgoing && wt.outgoing.videoId === cur.videoId && (
            <View style={styles.wtWaiting} pointerEvents="none">
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.wtWaitingText} numberOfLines={1}>
                Waiting for {wt.outgoing.toName} to join…
              </Text>
            </View>
          )}
          {!!wt.partnerLeft && wt.partnerLeft.videoId === cur.videoId && (
            <View style={styles.wtLeftOverlay}>
              <Text style={styles.wtLeftTitle}>
                {(wt.partnerLeft.by && wt.partnerLeft.by.displayName) || 'Your friend'} left the room.
              </Text>
              <Text style={styles.wtLeftSub}>Your video is paused.</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <TouchableOpacity
                  onPress={() => { wt.resetPartnerLeft(); wt.leaveRoom(); }}
                  style={[styles.wtLeftBtn, { backgroundColor: theme.primary }]}
                >
                  <Text style={styles.wtLeftBtnText}>Watch alone</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    wt.resetPartnerLeft();
                    wt.sendInvite({ videoId: cur.videoId, title: info?.title || cur.title });
                  }}
                  style={[styles.wtLeftBtn, styles.wtLeftGhost]}
                >
                  <Text style={styles.wtLeftBtnText}>Start new session</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {nextVideo && (
          <TouchableOpacity style={styles.nextBanner} activeOpacity={0.9} onPress={cancelNext}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: fs(12), fontWeight: '700' }} numberOfLines={1}>
                Up next: {nextVideo.title}
              </Text>
              <Text style={{ color: '#cbb6f5', fontSize: fs(11) }} numberOfLines={1}>
                by {nextVideo.channelTitle} · playing in a moment
              </Text>
            </View>
            <Text style={{ color: theme.primary, fontSize: fs(12), fontWeight: '800', marginLeft: 10 }}>Cancel</Text>
          </TouchableOpacity>
        )}

        <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
          <View style={styles.titleBlock}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.title, { color: theme.text, flex: 1 }]} numberOfLines={2}>
                {info?.dearrow?.title || info?.title || cur.title}
              </Text>
              {!!info?.dearrow?.title && info.title !== info.dearrow.title && (
                <Text style={[styles.dearrowTag, { backgroundColor: theme.primaryLight, color: theme.primary }]}>DeArrow</Text>
              )}
            </View>
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

            {inRoom && (
              <View style={[styles.wtChip, { backgroundColor: theme.primaryLight }]}>
                <Icon name="people" size={13} color={theme.primary} />
                <Text style={[styles.wtChipText, { color: theme.primary }]} numberOfLines={1}>
                  {partnerName}
                  {wt.room && wt.room.partnerOnline === false ? ' (reconnecting…)' : ''}
                </Text>
              </View>
            )}

            <View style={styles.toolRow}>
              <TouchableOpacity style={styles.toolBtn} onPress={toggleWatchTogether} disabled={!cur.videoId}>
                <Icon name={inRoom ? 'people' : 'people-outline'} size={20} color={inRoom ? theme.primary : theme.text} />
                <Text style={[styles.toolText, { color: inRoom ? theme.primary : theme.text }]}>{inRoom ? 'Leave' : 'Watch'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolBtn} onPress={() => setShowDl(!showDl)}>
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
              <TouchableOpacity style={styles.toolBtn} onPress={() => setAudioOnly(!audioOnly)} disabled={!stream?.audioUrl || inRoom}>
                <Icon name="headset-outline" size={20} color={audioOnly ? theme.primary : (inRoom ? theme.textSecondary : theme.text)} />
                <Text style={[styles.toolText, { color: inRoom ? theme.textSecondary : theme.text }]}>Audio</Text>
              </TouchableOpacity>
            </View>

            {inRoom && (
              <View style={[styles.wtPanel, { backgroundColor: theme.inputBg }]}>
                <View style={styles.wtPanelHead}>
                  <Text style={[styles.wtPanelTitle, { color: theme.text }]}>Watch together</Text>
                  <TouchableOpacity onPress={wt.leaveRoom}>
                    <Text style={[styles.wtLeaveText, { color: theme.danger }]}>Leave</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.wtReactions}>
                  {['😂', '🔥', '❤️', '👍', '😮', '👏'].map((emoji) => (
                    <TouchableOpacity
                      key={emoji}
                      onPress={() => wt.sendReaction(emoji)}
                      style={styles.wtReactionBtn}
                    >
                      <Text style={{ fontSize: fs(20) }}>{emoji}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <ScrollView
                  ref={wtChatRef}
                  style={styles.wtChatList}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  {wt.messages.length ? wt.messages.map((m) => (
                    <Text key={m.id} style={[styles.wtChatMsg, { color: theme.text }]}>
                      <Text style={{ color: theme.primary, fontWeight: '800' }}>
                        {(m.by && m.by.displayName) || 'Friend'}
                      </Text>
                      {': '}{m.text}
                    </Text>
                  )) : (
                    <Text style={[styles.wtChatEmpty, { color: theme.textSecondary }]}>
                      No messages yet. Say hi!
                    </Text>
                  )}
                </ScrollView>
                <View style={styles.wtChatRow}>
                  <TextInput
                    value={wtText}
                    onChangeText={setWtText}
                    maxLength={500}
                    placeholder="Message…"
                    placeholderTextColor={theme.textSecondary}
                    returnKeyType="send"
                    onSubmitEditing={sendWtMessage}
                    style={[styles.wtInput, { color: theme.text, backgroundColor: theme.card, borderColor: theme.border }]}
                  />
                  <TouchableOpacity onPress={sendWtMessage} style={[styles.wtSend, { backgroundColor: theme.primary }]}>
                    <Icon name="send" size={15} color="#fff" />
                  </TouchableOpacity>
                </View>
                {isGuest && (
                  <Text style={[styles.wtHostNote, { color: theme.textSecondary }]}>
                    Only the host controls playback.
                  </Text>
                )}
              </View>
            )}

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

            {showDl && (
              <View style={[styles.playlistPanel, { backgroundColor: theme.inputBg }]}>
                <Text style={[styles.playlistTitle, { color: theme.text }]}>Save to downloads</Text>
                <TouchableOpacity style={styles.playlistRow} onPress={() => { onDownload && onDownload(cur, { mode: 'video' }); }}>
                  <Icon name={dlIcon(dlState)} size={18} color={dlColor(dlState)} />
                  <Text style={{ color: theme.text, fontSize: fs(13), fontWeight: '600', marginLeft: 8 }}>Video (480p)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.playlistRow} onPress={() => { onDownload && onDownload(cur, { mode: 'audio' }); }}>
                  <Icon name={dlIcon(dlAud)} size={18} color={dlColor(dlAud)} />
                  <Text style={{ color: theme.text, fontSize: fs(13), fontWeight: '600', marginLeft: 8 }}>Audio (m4a)</Text>
                </TouchableOpacity>
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
                <TouchableOpacity key={i} style={styles.chapterRow} onPress={() => { if (videoRef.current && !playError) videoRef.current.seek(ch.start); }}>
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

        {!!wt.invite && (
          <View style={styles.wtInviteOverlay}>
            <View style={[styles.wtInviteCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="people" size={18} color={theme.primary} />
                <Text style={[styles.wtInviteTitle, { color: theme.text }]} numberOfLines={2}>
                  <Text style={{ color: theme.primary, fontWeight: '800' }}>
                    {(wt.invite.from && wt.invite.from.displayName) || 'Friend'}
                  </Text>
                  {' '}invited you to watch together
                </Text>
              </View>
              {!!wt.invite.title && (
                <Text style={[styles.wtInviteSub, { color: theme.textSecondary }]} numberOfLines={2}>
                  {wt.invite.title}
                </Text>
              )}
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
                <TouchableOpacity
                  onPress={() => wt.respondInvite(true)}
                  style={[styles.wtInviteBtn, { backgroundColor: theme.primary }]}
                >
                  <Text style={styles.wtInviteAccept}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => wt.respondInvite(false)}
                  style={[styles.wtInviteBtn, styles.wtInviteGhost, { borderColor: theme.border }]}
                >
                  <Text style={[styles.wtInviteDecline, { color: theme.text }]}>Decline</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        <Toast message={wt.notice} bottom={96} />
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
  nextBanner: {
    position: 'absolute',
    top: Dimensions.get('window').width * 9 / 16,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(16,11,26,0.95)',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  dearrowTag: { fontSize: fs(9), fontWeight: '900', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, marginLeft: 8 },
  titleBlock: { paddingHorizontal: 16, paddingTop: 12 },
  title: { fontSize: fs(16), fontWeight: '800', lineHeight: 22 },
  channel: { fontSize: fs(14), fontWeight: '700', marginTop: 8 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  meta: { fontSize: fs(12) },
  toolRow: { flexDirection: 'row', marginTop: 14, gap: 14 },
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
  wtChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderRadius: 14,
    paddingHorizontal: 9,
    paddingVertical: 4,
    marginTop: 8,
  },
  wtChipText: { fontSize: fs(11), fontWeight: '800' },
  wtBubble: {
    position: 'absolute',
    top: 10,
    left: 24,
    right: 24,
    zIndex: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.85)',
  },
  wtBubbleText: { color: '#fff', fontSize: fs(12), flexShrink: 1 },
  wtGuestChip: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    zIndex: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.62)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  wtGuestText: { color: '#fff', fontSize: fs(10), fontWeight: '700' },
  wtWaiting: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 12,
    zIndex: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  wtWaitingText: { color: '#fff', fontSize: fs(12), fontWeight: '700' },
  wtLeftOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    backgroundColor: 'rgba(8,5,14,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  wtLeftTitle: { color: '#fff', fontSize: fs(15), fontWeight: '800', textAlign: 'center' },
  wtLeftSub: { color: 'rgba(255,255,255,0.7)', fontSize: fs(12), marginTop: 4 },
  wtLeftBtn: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 9 },
  wtLeftBtnText: { color: '#fff', fontSize: fs(13), fontWeight: '700' },
  wtLeftGhost: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.45)' },
  wtPanel: { borderRadius: 12, padding: 12, marginTop: 12 },
  wtPanelHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  wtPanelTitle: { fontSize: fs(13), fontWeight: '800' },
  wtLeaveText: { fontSize: fs(12), fontWeight: '800' },
  wtReactions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  wtReactionBtn: { paddingHorizontal: 5, paddingVertical: 3, borderRadius: 10 },
  wtChatList: { maxHeight: 150, marginBottom: 8 },
  wtChatMsg: { fontSize: fs(12), lineHeight: 17, marginBottom: 4 },
  wtChatEmpty: { fontSize: fs(12) },
  wtChatRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wtInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: fs(12),
  },
  wtSend: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  wtHostNote: { fontSize: fs(11), marginTop: 8 },
  wtInviteOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    elevation: 30,
    backgroundColor: 'rgba(8,5,14,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  wtInviteCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  wtInviteTitle: { fontSize: fs(14), lineHeight: 20, flexShrink: 1 },
  wtInviteSub: { fontSize: fs(12), marginTop: 8 },
  wtInviteBtn: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8 },
  wtInviteAccept: { color: '#fff', fontSize: fs(13), fontWeight: '800' },
  wtInviteDecline: { fontSize: fs(13), fontWeight: '700' },
  wtInviteGhost: { borderWidth: 1 },
});