import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, Modal,
  Dimensions, Image, ActivityIndicator, Alert, Animated, PanResponder, Platform,
} from 'react-native';
import Video from 'react-native-video';
import { captureRef } from 'react-native-view-shot';
import { Icon } from './AppIcon';
import Clipboard from '@react-native-clipboard/clipboard';
import { absUrl } from '../config';
import { quickReactions } from '../theme';
import RNFetchBlob from 'rn-fetch-blob';
import { canInlineVideoPreview } from '../utils/media';
import { emojiSpan } from '../utils/emoji';
import { DrawableImage, DrawingToolbar, DRAW_COLORS, DRAW_SIZES } from './DrawingCanvas';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

function ZoomableImage({ uri, style, onExternal }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const lastScale = useRef(1);
  const pinchStart = useRef(null);
  const baseTrans = useRef({ x: 0, y: 0 });
  const lastTap = useRef(0);
  const tapStart = useRef(0);
  const didGesture = useRef(false);

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const animateTo = (s, tx, ty) => {
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: tx, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: ty, useNativeDriver: true }),
    ]).start();
    lastScale.current = s;
  };

  const doubleTapZoom = () => {
    if (lastScale.current > 1.05) {
      animateTo(1, 0, 0);
    } else {
      animateTo(2.6, 0, 0);
    }
  };

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      lastTap.current = 0;
      doubleTapZoom();
    } else {
      lastTap.current = now;
    }
  };

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (e, g) => {
      if (e.nativeEvent.touches.length === 2) return true;
      return lastScale.current > 1.02 && (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8);
    },
    onPanResponderGrant: (e) => {
      didGesture.current = true;
      baseTrans.current = { x: translateX.__getValue(), y: translateY.__getValue() };
      if (e.nativeEvent.touches.length === 2) {
        pinchStart.current = { distance: dist(e.nativeEvent.touches[0], e.nativeEvent.touches[1]), scale: lastScale.current };
      }
    },
    onPanResponderMove: (e, g) => {
      if (e.nativeEvent.touches.length === 2) {
        const t0 = e.nativeEvent.touches[0];
        const t1 = e.nativeEvent.touches[1];
        const d = dist(t0, t1);
        const base = pinchStart.current;
        if (!base || !base.distance) return;
        const s = clamp(base.scale * (d / base.distance), 1, 4);
        lastScale.current = s;
        scale.setValue(s);
      } else if (lastScale.current > 1.02) {
        translateX.setValue(clamp(baseTrans.current.x + g.dx, -160, 160));
        translateY.setValue(clamp(baseTrans.current.y + g.dy, -240, 240));
      }
    },
    onPanResponderRelease: () => {
      const s = lastScale.current;
      if (s < 1.15) {
        animateTo(1, 0, 0);
      } else if (s < 1.5) {
        animateTo(1, 0, 0);
      } else {
        animateTo(s, clamp(translateX.__getValue(), -160, 160), clamp(translateY.__getValue(), -240, 240));
      }
      pinchStart.current = null;
    },
    onPanResponderTerminate: () => {
      pinchStart.current = null;
    },
  })).current;

  return (
    <View
      style={[{ flex: 1, overflow: 'hidden' }, style]}
      {...pan.panHandlers}
      onTouchStart={() => { tapStart.current = Date.now(); didGesture.current = false; }}
      onTouchEnd={() => {
        if (!didGesture.current && Date.now() - tapStart.current < 320) handleTap();
      }}
    >
      <Animated.View style={[styles.zoomWrap, { transform: [{ translateX }, { translateY }, { scale }] }]}>
        {loading && !failed && (
          <View style={styles.imgLoading}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
        {failed ? (
          <View style={styles.imgError}>
            <Icon name="alert-circle-outline" size={40} color="#fff" />
            <Text style={{ color: '#fff', marginTop: 10, fontSize: 13 }}>Could not load this image</Text>
            {onExternal && (
              <TouchableOpacity onPress={onExternal} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                <Icon name="open-outline" size={18} color="#fff" />
                <Text style={{ color: '#fff', marginLeft: 6, fontSize: 13, fontWeight: '600' }}>Open externally</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <Image
            source={{ uri }}
            style={[styles.zoomImg, { width: SCREEN_W }]}
            resizeMode="contain"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setFailed(true); }}
          />
        )}
      </Animated.View>
    </View>
  );
}

function dist(a, b) {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

function fmtTime(s) {
  const total = Math.max(0, Math.floor(s || 0));
  const sec = total % 60;
  const m = Math.floor(total / 60);
  const h = Math.floor(m / 60);
  const ss = sec < 10 ? `0${sec}` : `${sec}`;
  if (h > 0) return `${h}:${m % 60 < 10 ? '0' : ''}${m % 60}:${ss}`;
  return `${m}:${ss}`;
}

function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return null;
  const base = name.split(/[?#]/)[0];
  return (base.replace(/[^\w.\- ]+/g, '_') || null).slice(0, 120);
}

// ExoPlayer decodes just a few codecs in-app (mainly MP4/H.264/AAC). Container or
// codec mismatches (MOV, MKV, WEBM, HEVC…) throw a native error that no JS boundary
// can catch, crashing the app. Only allow known-safe formats to run in-app; the rest
// are handed to the system video player.

class VideoBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error('Video render failed:', error);
  }
  componentDidUpdate(prevProps) {
    if (prevProps.source !== this.props.source && this.state.failed) {
      this.setState({ failed: false });
    }
  }
  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export default function MediaViewer({ items = [], startIndex = 0, headerText = '', onClose, currentUserId, theme, onReact, onReply, onSendReplyMessage, onDelete, onSendDrawing, onExternalImage }) {
  const [index, setIndex] = useState(startIndex);
  const [showMenu, setShowMenu] = useState(false);
  const [videoErrors, setVideoErrors] = useState({});
  const [videoLoading, setVideoLoading] = useState({});
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [videoPlay, setVideoPlay] = useState({ paused: false, currentTime: 0, duration: 0, rate: 1 });
  const videoRef = useRef(null);
  const seekWRef = useRef(0);
  const listRef = useRef(null);
  const item = items[index] || null;
  const canShare = !!item && !!item.media_url;

  const [drawMode, setDrawMode] = useState(false);
  const [strokes, setStrokes] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [eraser, setEraser] = useState(false);
  const [color, setColor] = useState(DRAW_COLORS[4]);
  const [brush, setBrush] = useState(DRAW_SIZES[1]);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const drawRef = useRef(null);

  const colorRef = useRef(color);
  const brushRef = useRef(brush);
  const drawModeRef = useRef(drawMode);
  const eraserRef = useRef(eraser);
  const strokesRef = useRef(strokes);
  const redoStackRef = useRef(redoStack);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { brushRef.current = brush; }, [brush]);
  useEffect(() => { drawModeRef.current = drawMode; }, [drawMode]);
  useEffect(() => { eraserRef.current = eraser; }, [eraser]);
  useEffect(() => { strokesRef.current = strokes; }, [strokes]);
  useEffect(() => { redoStackRef.current = redoStack; }, [redoStack]);

  const undoDrawing = useCallback(() => {
    const cur = strokesRef.current;
    if (!cur.length) return;
    setRedoStack((r) => [...r, cur[cur.length - 1]]);
    setStrokes(cur.slice(0, -1));
  }, []);
  const redoDrawing = useCallback(() => {
    const rs = redoStackRef.current;
    if (!rs.length) return;
    setStrokes((s) => [...s, rs[rs.length - 1]]);
    setRedoStack(rs.slice(0, -1));
  }, []);

  // Reset drawing state when switching media or leaving draw mode
  useEffect(() => {
    setStrokes([]);
    setRedoStack([]);
    setEraser(false);
    setDrawMode(false);
  }, [items, index]);

  useEffect(() => {
    setIndex(startIndex);
    setStrokes([]);
    setRedoStack([]);
    setEraser(false);
    setDrawMode(false);
  }, [startIndex]);

  // Pause & unmount any active video when the user swipes to a different item
  useEffect(() => {
    const visible = items[index];
    const visId = visible ? visible.id : null;
    setActiveVideoId((cur) => (cur && visId && cur === visId ? cur : null));
  }, [index, items]);

  useEffect(() => {
    setVideoPlay({ paused: false, currentTime: 0, duration: 0, rate: 1 });
  }, [activeVideoId]);

  const playExternal = useCallback(async (m, fallbackMime) => {
    if (!m || !m.media_url) return;
    try {
      const url = absUrl(m.media_url);
      const base = sanitizeFileName(m.file_name) || `tojey_video_${m.id}.mp4`;
      const name = /\.[a-zA-Z0-9]{2,5}$/.test(base) ? base : `${base}.mp4`;
      const { dirs } = RNFetchBlob.fs;
      const target = `${dirs.CacheDir}/${name}`;
      await RNFetchBlob.config({ fileCache: false, path: target }).fetch('GET', url);
      await RNFetchBlob.android.actionViewIntent(target, fallbackMime || 'video/mp4');
    } catch (e) {
      console.error('playExternal failed', e);
      Alert.alert('Could not play video', e.message || 'No video app found');
    }
  }, []);

  const openExternalImage = useCallback(async (m) => {
    if (!m || !m.media_url) return;
    try {
      const url = absUrl(m.media_url);
      const base = sanitizeFileName(m.file_name) || `tojey_photo_${m.id}.png`;
      const name = /\.[a-zA-Z0-9]{2,5}$/.test(base) ? base : `${base}.png`;
      const { dirs } = RNFetchBlob.fs;
      const target = `${dirs.CacheDir}/${name}`;
      await RNFetchBlob.config({ fileCache: false, path: target }).fetch('GET', url);
      await RNFetchBlob.android.actionViewIntent(target, 'image/*');
    } catch (e) {
      console.error('openExternalImage failed', e);
      Alert.alert('Could not open image', e.message || 'No image app found');
    }
  }, []);

  const download = useCallback(async () => {
    if (!item || saving) return;
    setSaving(true);
    try {
      const url = absUrl(item.media_url);
      const isVideo = item.type === 'VIDEO';
      const ext = isVideo ? '.mp4' : '.jpg';
      const base = sanitizeFileName(item.file_name) || ('tojey_media_' + item.id);
      const name = /\.[a-zA-Z0-9]{2,5}$/.test(base) ? base : base + ext;
      const { dirs } = RNFetchBlob.fs;
      const dlPath = `${dirs.DownloadDir}/${name}`;
      const res = await RNFetchBlob.config({
        fileCache: false,
        path: dlPath,
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          path: dlPath,
          description: 'Tojey media',
          mime: isVideo ? 'video/mp4' : 'image/jpeg',
        },
      }).fetch('GET', url);
      Alert.alert('Saved', `Downloaded to ${res.path()}`);
    } catch (e) {
      console.error('download failed', e);
      Alert.alert('Download failed', e.message || 'Could not save media');
    } finally {
      setSaving(false);
    }
  }, [item, saving]);

  const sendDrawing = useCallback(async () => {
    if (!onSendDrawing || drawingBusy) return;
    setDrawingBusy(true);
    try {
      const uri = await captureRef(drawRef, {
        format: 'png',
        quality: 1,
        result: 'tmpfile',
      });
      onSendDrawing(uri, () => onClose());
    } catch (e) {
      console.error('capture drawing failed', e);
      Alert.alert('Draw failed', e.message || 'Could not create the drawing');
    } finally {
      setDrawingBusy(false);
    }
  }, [onSendDrawing, drawingBusy, onClose]);

  const renderItem = useCallback(({ item: m }) => {
    const uri = absUrl(m.media_url);
    const isVideo = m.type === 'VIDEO';
    if (isVideo) {
      const failed = videoErrors[m.id];
      const active = activeVideoId === m.id;
      const loading = videoLoading[m.id] && !failed;
      const safeFormat = canInlineVideoPreview(m.file_name, m.mime_type);
      return (
        <View style={styles.slide}>
          {failed ? (
            <View style={styles.vidError}>
              <Icon name="alert-circle-outline" size={44} color="#fff" />
              <Text style={{ color: '#fff', marginTop: 10, fontSize: 14 }}>Video unavailable</Text>
              <TouchableOpacity onPress={() => playExternal(m, 'video/mp4')} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                <Icon name="open-outline" size={18} color="#fff" />
                <Text style={{ color: '#fff', marginLeft: 6, fontSize: 13, fontWeight: '600' }}>Open in video app</Text>
              </TouchableOpacity>
            </View>
          ) : (!active && safeFormat) ? (
            <View style={styles.vidPosterWrap}>
              {m.thumb_url ? (
                <Image source={{ uri: absUrl(m.thumb_url) }} style={StyleSheet.absoluteFill} resizeMode="contain" />
              ) : (
                <Icon name="videocam-outline" size={56} color="rgba(255,255,255,0.4)" />
              )}
              <TouchableOpacity
                style={styles.vidPlayBig}
                onPress={() => setActiveVideoId(m.id)}
                accessibilityLabel="Play video"
              >
                <Icon name="play" size={30} color="#fff" />
              </TouchableOpacity>
            </View>
          ) : (!active && !safeFormat) ? (
            <View style={styles.vidPosterWrap}>
              {m.thumb_url ? (
                <Image source={{ uri: absUrl(m.thumb_url) }} style={StyleSheet.absoluteFill} resizeMode="contain" />
              ) : (
                <Icon name="videocam-outline" size={56} color="rgba(255,255,255,0.4)" />
              )}
              <TouchableOpacity onPress={() => playExternal(m, m.mime_type || 'video/mp4')} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                <Icon name="open-outline" size={18} color="#fff" />
                <Text style={{ color: '#fff', marginLeft: 6, fontSize: 13, fontWeight: '600' }}>Open in video app</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <VideoBoundary
              key={m.id}
              source={uri}
              fallback={
                <View style={styles.vidError}>
                  <Icon name="alert-circle-outline" size={44} color="#fff" />
                  <Text style={{ color: '#fff', marginTop: 10, fontSize: 14 }}>Video could not load here</Text>
                  <TouchableOpacity onPress={() => playExternal(m, 'video/mp4')} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                    <Icon name="open-outline" size={18} color="#fff" />
                    <Text style={{ color: '#fff', marginLeft: 6, fontSize: 13, fontWeight: '600' }}>Open in video app</Text>
                  </TouchableOpacity>
                </View>
              }
            >
              <Video
                ref={active ? videoRef : undefined}
                source={{ uri }}
                style={styles.video}
                resizeMode="contain"
                controls={false}
                paused={videoPlay.paused}
                rate={videoPlay.rate}
                progressUpdateInterval={200}
                repeat={false}
                playInBackground={false}
                playWhenInactive={false}
                bufferConfig={{ minBufferMs: 15000, maxBufferMs: 60000, bufferForPlaybackMs: 1000, bufferForPlaybackAfterRebufferMs: 2000 }}
                onEnd={() => { setVideoPlay((s) => ({ ...s, paused: true, currentTime: s.duration || 0 })); setActiveVideoId(null); }}
                onError={() => { setVideoErrors((prev) => ({ ...prev, [m.id]: true })); setActiveVideoId(null); }}
                onLoad={(d) => {
                  setVideoErrors((prev) => ({ ...prev, [m.id]: false }));
                  setVideoLoading((prev) => ({ ...prev, [m.id]: false }));
                  const dur = (d && d.duration) || 0;
                  setVideoPlay((s) => ({ ...s, duration: dur, currentTime: 0, paused: false }));
                }}
                onLoadStart={() => setVideoLoading((prev) => ({ ...prev, [m.id]: true }))}
                onProgress={(d) => {
                  if (!videoPlay.paused) setVideoPlay((s) => ({ ...s, currentTime: (d && d.currentTime) || 0 }));
                }}
                onPlay={() => setVideoPlay((s) => ({ ...s, paused: false }))}
                onPause={() => setVideoPlay((s) => ({ ...s, paused: true }))}
              />
            </VideoBoundary>
          )}
          {active && (
            <View style={styles.vidCtrlWrap} pointerEvents="box-none">
              <TouchableOpacity
                style={styles.vidCenterCtrl}
                onPress={() => setVideoPlay((s) => ({ ...s, paused: !s.paused }))}
                accessibilityLabel={videoPlay.paused ? 'Play' : 'Pause'}
              >
                <Icon name={videoPlay.paused ? 'play' : 'pause'} size={34} color="#fff" />
              </TouchableOpacity>
              <View style={styles.vidCtrlRow}>
                <Text style={styles.vidTime}>{fmtTime(videoPlay.currentTime)}</Text>
                <TouchableOpacity
                  style={styles.vidSeekTrack}
                  onLayout={(e) => { seekWRef.current = e.nativeEvent.layout.width || 0; }}
                  onPress={(e) => {
                    const dur = videoPlay.duration || 0;
                    if (!dur) return;
                    const ratio = (e.nativeEvent.locationX || 0) / (seekWRef.current || 1);
                    const t = Math.max(0, Math.min(dur, (dur * ratio) || 0));
                    if (videoRef.current && videoRef.current.seek) videoRef.current.seek(t);
                    setVideoPlay((s) => ({ ...s, currentTime: t }));
                  }}
                >
                  <View style={styles.vidSeekTrackBg} />
                  <View
                    style={[styles.vidSeekFill, {
                      width: `${videoPlay.duration ? Math.min(100, ((videoPlay.currentTime || 0) / videoPlay.duration) * 100) : 0}%`,
                    }]}
                  />
                </TouchableOpacity>
                <Text style={styles.vidTime}>{fmtTime(videoPlay.duration)}</Text>
                <TouchableOpacity
                  style={styles.vidRateBtn}
                  onPress={() => setVideoPlay((s) => ({ ...s, rate: s.rate === 1 ? 1.5 : s.rate === 1.5 ? 2 : 1 }))}
                  accessibilityLabel="Playback speed"
                >
                  <Text style={styles.vidTime}>{videoPlay.rate.toFixed(1)}x</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          {loading && (
            <View style={styles.vidLoading}>
              <ActivityIndicator color="#fff" size="large" />
            </View>
          )}
        </View>
      );
    }
    if (drawMode && m.id === item?.id) {
      return (
        <DrawableImage
          key={m.id}
          uri={uri}
          drawRef={drawRef}
          strokes={strokes}
          strokesRef={strokesRef}
          setStrokes={setStrokes}
          setRedoStack={setRedoStack}
          drawModeRef={drawModeRef}
          eraserRef={eraserRef}
          colorRef={colorRef}
          brushRef={brushRef}
        />
      );
    }
    return <ZoomableImage uri={uri} onExternal={onExternalImage ? () => onExternalImage(m) : null} />;
  }, [videoErrors, videoLoading, activeVideoId, videoPlay, drawMode, item, strokes, playExternal, onExternalImage]);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems && viewableItems.length) {
      setIndex(viewableItems[0].index);
    }
  }).current;

  const doReact = (r) => {
    if (onReact && item) onReact(item.id, r);
    setShowMenu(false);
  };

  const sendReply = () => {
    const txt = replyText.trim();
    if (!txt || !item) return;
    setReplyText('');
    if (onSendReplyMessage) onSendReplyMessage(item, txt);
    else if (onReply) onReply(item);
    onClose();
  };

  const isOwn = !!item && item.sender_id === currentUserId;
  const isImage = !!item && item.type === 'IMAGE';

  const actionMenu = [
    { key: 'reply', label: 'Reply', icon: 'return-down-back-outline', onPress: () => { if (onReply && item) onReply(item); setShowMenu(false); } },
    { key: 'edit', label: 'Edit', icon: 'create-outline', onPress: () => { setShowMenu(false); if (isImage && !drawMode) setDrawMode(true); }, visible: isImage },
    { key: 'copy', label: 'Copy', icon: 'copy-outline', onPress: () => { if (item && item.content) Clipboard.setString(item.content); setShowMenu(false); }, visible: !!(item && item.content) },
    { key: 'download', label: 'Download', icon: 'download-outline', onPress: () => { setShowMenu(false); download(); } },
    ...(isOwn ? [{ key: 'delete', label: 'Delete for me', icon: 'trash-outline', danger: true, onPress: () => { if (onDelete && item) onDelete(item, 'me'); setShowMenu(false); } }] : []),
    ...(isOwn ? [{ key: 'deleteAll', label: 'Delete for everyone', icon: 'trash', danger: true, onPress: () => { if (onDelete && item) onDelete(item, 'everyone'); setShowMenu(false); } }] : []),
  ].filter((a) => a.visible !== false);

  const drawToolbar = (
    <DrawingToolbar
      theme={theme}
      color={color}
      brush={brush}
      setColor={setColor}
      setBrush={setBrush}
      onUndo={undoDrawing}
      onRedo={redoDrawing}
      onClear={() => { setStrokes([]); setRedoStack([]); }}
      onDone={sendDrawing}
      busy={drawingBusy}
      eraser={eraser}
      setEraser={setEraser}
      canUndo={strokes.length > 0}
      canRedo={redoStack.length > 0}
    />
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: 'rgba(0,0,0,0.97)' }]}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.topBtn} accessibilityLabel="Close media viewer">
            <Icon name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={styles.topTitle} numberOfLines={1}>{headerText}</Text>
            {item && (
              <Text style={styles.topSub}>
                {item.content}
                {items.length > 1 ? ` · ${index + 1}/${items.length}` : ''}
              </Text>
            )}
          </View>
          {isImage && !drawMode && (
            <TouchableOpacity onPress={() => setDrawMode(true)} style={styles.topBtn} accessibilityLabel="Draw on photo">
              <Icon name="color-wand" size={23} color="#fff" />
            </TouchableOpacity>
          )}
          {drawMode && (
            <TouchableOpacity onPress={() => { setDrawMode(false); setStrokes([]); setRedoStack([]); setEraser(false); }} style={styles.topBtn} accessibilityLabel="Close drawing">
              <Icon name="close" size={24} color="#fff" />
            </TouchableOpacity>
          )}
          {!drawMode && (
            <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.topBtn} accessibilityLabel="More actions">
              <Icon name="ellipsis-horizontal" size={24} color="#fff" />
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(m, idx) => String(m.id || idx)}
          horizontal
          pagingEnabled
          scrollEnabled={!drawMode}
          showsHorizontalScrollIndicator={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          initialScrollIndex={startIndex}
          getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
          renderItem={renderItem}
          removeClippedSubviews={Platform.OS === 'android'}
          style={{ flex: 1 }}
        />

        {drawMode ? drawToolbar : (
          canShare && (
            <View style={[styles.bottomBar, { backgroundColor: theme.card }]}>
              <View style={styles.replyRow}>
                <TextInput
                  style={[styles.replyInput, { backgroundColor: theme.inputBg, color: theme.text }]}
                  placeholder="Reply…"
                  placeholderTextColor={theme.textSecondary}
                  value={replyText}
                  onChangeText={setReplyText}
                  onSubmitEditing={sendReply}
                  returnKeyType="send"
                />
                <TouchableOpacity
                  onPress={sendReply}
                  disabled={!replyText.trim()}
                  style={[styles.replySendBtn, { backgroundColor: theme.primary, opacity: replyText.trim() ? 1 : 0.5 }]}
                  accessibilityLabel="Send reply"
                >
                  <Icon name="send" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
              <View style={[styles.reactRow, { borderTopColor: theme.border }]}>
                {['❤️', '😂', '🙂'].map((r) => (
                  <TouchableOpacity
                    key={r}
                    onPress={() => doReact(r)}
                    style={[styles.reactBtn, { backgroundColor: theme.primaryLight }]}
                    accessibilityLabel={`React ${r}`}
                  >
                    <Text style={{ fontSize: 17 }}>{r}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  onPress={() => setShowMenu(true)}
                  style={[styles.reactBtn, { backgroundColor: theme.primaryLight }]}
                  accessibilityLabel="More media actions"
                >
                  <Icon name="add" size={18} color={theme.primary} />
                </TouchableOpacity>
                <View style={{ flex: 1 }} />
                <TouchableOpacity onPress={download} disabled={saving} style={styles.dlBtnSm} accessibilityLabel="Download media">
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="download" size={16} color={theme.primary} />}
                </TouchableOpacity>
              </View>
            </View>
          )
        )}

        {showMenu && !drawMode && (
          <View style={styles.menuOverlay}>
            <TouchableOpacity style={styles.menuBackdrop} onPress={() => setShowMenu(false)} />
            <View style={[styles.menu, { backgroundColor: theme.card }]}>
              <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Media actions</Text>
              <View style={styles.reactionRow}>
                {quickReactions.map((r) => (
                  <TouchableOpacity key={r} onPress={() => doReact(r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                    <Text style={{ fontSize: 22 }}>{emojiSpan(r)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                {actionMenu.map((a) => (
                  <TouchableOpacity key={a.key} onPress={a.onPress} style={[styles.menuItem, { backgroundColor: theme.primaryLight }]}>
                    <Icon name={a.icon} size={16} color={a.danger ? theme.danger : theme.primary} />
                    <Text style={{ color: a.danger ? theme.danger : theme.primary, fontWeight: '600', fontSize: 13, marginLeft: 6 }}>{a.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 44, paddingBottom: 10,
  },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  topTitle: { color: '#fff', fontSize: 15, fontWeight: '700', maxWidth: SCREEN_W - 140 },
  topSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
  slide: { width: SCREEN_W, height: '100%', alignItems: 'center', justifyContent: 'center' },
  video: { width: SCREEN_W, height: SCREEN_H - 180 },
  vidError: { alignItems: 'center', justifyContent: 'center' },
  vidFallback: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22 },
  vidPosterWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', width: SCREEN_W },
  vidPlayBig: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' },
  imgError: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vidLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 3 },
  zoomWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  zoomImg: { height: '100%' },
  imgLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  bottomBar: { paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.1)' },
  replyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  replyInput: { flex: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, fontSize: 14 },
  replySendBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  reactRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  reactBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dlBtnSm: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  vidCtrlWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', paddingBottom: 10, alignItems: 'center' },
  vidCenterCtrl: { position: 'absolute', top: '42%', width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  vidCtrlRow: { flexDirection: 'row', alignItems: 'center', width: '100%', paddingHorizontal: 12, paddingTop: 10 },
  vidTime: { color: '#fff', fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 38, textAlign: 'center' },
  vidSeekTrack: { flex: 1, height: 28, justifyContent: 'center', marginHorizontal: 8 },
  vidSeekTrackBg: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' },
  vidSeekFill: { position: 'absolute', left: 2, height: 3, borderRadius: 2, backgroundColor: '#fff', width: 0 },
  vidRateBtn: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.14)' },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menu: { position: 'absolute', right: 12, top: 90, width: SCREEN_W - 60, borderRadius: 16, padding: 14, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 16, elevation: 8 },
  menuTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 14 },
  reactionBtn: { borderRadius: 14, width: 44, height: 40, alignItems: 'center', justifyContent: 'center' },
  menuItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 9, paddingVertical: 9, paddingHorizontal: 12 },
});