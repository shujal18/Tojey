import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, Modal,
  Dimensions, Image, ActivityIndicator, Alert, Animated, PanResponder, Platform,
} from 'react-native';
import Video from 'react-native-video';
import { captureRef } from 'react-native-view-shot';
import { Icon } from './AppIcon';
import Clipboard from '@react-native-clipboard/clipboard';
import { absUrl } from '../config';
import { quickReactions } from '../theme';
import { fs } from '../utils/size';
import RNFetchBlob from 'rn-fetch-blob';
import { canInlineVideoPreview } from '../utils/media';
import ColorEmoji from './ColorEmoji';
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
  const pinching = useRef(false);
  const baseTrans = useRef({ x: 0, y: 0 });

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const animateTo = (s, tx, ty) => {
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: tx, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: ty, useNativeDriver: true }),
    ]).start();
    lastScale.current = s;
  };

  const startPinch = (touches) => {
    if (!touches || touches.length < 2) return;
    const d = dist(touches[0], touches[1]);
    if (!d) return;
    pinching.current = true;
    pinchStart.current = { distance: d, scale: lastScale.current };
    baseTrans.current = { x: translateX.__getValue(), y: translateY.__getValue() };
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length >= 2,
    onMoveShouldSetPanResponder: (e, g) => {
      if (e.nativeEvent.touches.length >= 2) return true;
      return lastScale.current > 1.02 && (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8);
    },
    onPanResponderGrant: (e) => {
      baseTrans.current = { x: translateX.__getValue(), y: translateY.__getValue() };
      if (e.nativeEvent.touches.length >= 2) startPinch(e.nativeEvent.touches);
    },
    onPanResponderMove: (e, g) => {
      const touches = e.nativeEvent.touches || [];
      if (touches.length >= 2) {
        if (!pinching.current || !pinchStart.current || !pinchStart.current.distance) {
          startPinch(touches);
          return;
        }
        const d = dist(touches[0], touches[1]);
        const base = pinchStart.current;
        const s = clamp(base.scale * (d / base.distance), 1, 4);
        lastScale.current = s;
        scale.setValue(s);
      } else {
        if (pinching.current) {
          pinching.current = false;
          pinchStart.current = null;
          baseTrans.current = { x: translateX.__getValue(), y: translateY.__getValue() };
          return;
        }
        if (lastScale.current > 1.02) {
          translateX.setValue(clamp(baseTrans.current.x + g.dx, -160, 160));
          translateY.setValue(clamp(baseTrans.current.y + g.dy, -240, 240));
        }
      }
    },
    onPanResponderRelease: () => {
      const s = lastScale.current;
      if (s < 1.5) {
        animateTo(1, 0, 0);
      } else {
        animateTo(s, clamp(translateX.__getValue(), -160, 160), clamp(translateY.__getValue(), -240, 240));
      }
      pinching.current = false;
      pinchStart.current = null;
    },
    onPanResponderTerminate: () => {
      pinching.current = false;
      pinchStart.current = null;
    },
    onPanResponderTerminationRequest: () => false,
  })).current;

  return (
    <View style={[styles.zoomRoot, style]} {...pan.panHandlers}>
      <Animated.View style={[styles.zoomWrap, { transform: [{ translateX }, { translateY }, { scale }] }]}>
        {loading && !failed && (
          <View style={styles.imgLoading}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
        {failed ? (
          <View style={styles.imgError}>
            <Icon name="alert-circle-outline" size={40} color="#fff" />
            <Text style={{ color: '#fff', marginTop: 10, fontSize: fs(13) }}>Could not load this image</Text>
            {onExternal && (
              <TouchableOpacity onPress={onExternal} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                <Icon name="open-outline" size={18} color="#fff" />
                <Text style={{ color: '#fff', marginLeft: 6, fontSize: fs(13), fontWeight: '600' }}>Open externally</Text>
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

export default function MediaViewer({ items = [], startIndex = 0, headerText = '', onClose, currentUserId, theme, onReact, onReply, onDelete, onSendDrawing, onExternalImage }) {
  const [index, setIndex] = useState(startIndex);
  const [showMenu, setShowMenu] = useState(false);
  const [videoErrors, setVideoErrors] = useState({});
  const [videoLoading, setVideoLoading] = useState({});
  const [activeVideoId, setActiveVideoId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [videoPlay, setVideoPlay] = useState({ paused: false, currentTime: 0, duration: 0, rate: 1 });
  const videoRef = useRef(null);
  const seekWRef = useRef(0);
  const listRef = useRef(null);
  const item = items[index] || null;

  const [drawMode, setDrawMode] = useState(false);
  const [strokes, setStrokes] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [eraser, setEraser] = useState(false);
  const [color, setColor] = useState(DRAW_COLORS[4]);
  const [brush, setBrush] = useState(DRAW_SIZES[1]);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const drawRef = useRef(null);

  // Stable viewability config to avoid "Changing viewabilityConfigCallbackPairs on the fly" error
  const viewabilityConfigCallbackPairsRef = useRef([{
    viewabilityConfig: { itemVisiblePercentThreshold: 60 },
    onViewableItemsChanged: ({ viewableItems }) => {
      if (viewableItems && viewableItems.length) {
        setIndex(viewableItems[0].index);
      }
    },
  }]);

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
      const isMedia = item.type === 'IMAGE' || isVideo;
      const ext = isVideo ? '.mp4' : '.jpg';
      const base = sanitizeFileName(item.file_name) || ('tojey_media_' + item.id);
      const name = /\.[a-zA-Z0-9]{2,5}$/.test(base) ? base : base + ext;
      const { dirs } = RNFetchBlob.fs;
      const dlPath = isMedia ? `${dirs.DCIMDir}/Tojey/${name}` : `${dirs.DownloadDir}/${name}`;
      await RNFetchBlob.config({ fileCache: false, path: dlPath }).fetch('GET', url);
      Promise.resolve(RNFetchBlob.fs.scanFile([dlPath])).catch(() => {});
      Alert.alert('Saved', isMedia ? `Saved to Gallery (DCIM/Tojey/${name})` : `Downloaded to Download/${name}`);
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
              <Text style={{ color: '#fff', marginTop: 10, fontSize: fs(14) }}>Video unavailable</Text>
              <TouchableOpacity onPress={() => playExternal(m, 'video/mp4')} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                <Icon name="open-outline" size={18} color="#fff" />
                <Text style={{ color: '#fff', marginLeft: 6, fontSize: fs(13), fontWeight: '600' }}>Open in video app</Text>
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
                <Text style={{ color: '#fff', marginLeft: 6, fontSize: fs(13), fontWeight: '600' }}>Open in video app</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <VideoBoundary
              key={m.id}
              source={uri}
              fallback={
                <View style={styles.vidError}>
                  <Icon name="alert-circle-outline" size={44} color="#fff" />
                  <Text style={{ color: '#fff', marginTop: 10, fontSize: fs(14) }}>Video could not load here</Text>
                  <TouchableOpacity onPress={() => playExternal(m, 'video/mp4')} style={[styles.vidFallback, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
                    <Icon name="open-outline" size={18} color="#fff" />
                    <Text style={{ color: '#fff', marginLeft: 6, fontSize: fs(13), fontWeight: '600' }}>Open in video app</Text>
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
        <View style={styles.slide}>
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
        </View>
      );
    }
    return <ZoomableImage uri={uri} onExternal={onExternalImage ? () => onExternalImage(m) : null} />;
  }, [videoErrors, videoLoading, activeVideoId, videoPlay, drawMode, item, strokes, playExternal, onExternalImage]);

  const doReact = (r) => {
    if (onReact && item) onReact(item.id, r);
    setShowMenu(false);
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
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: 'rgba(0,0,0,0.97)' }]}>
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(m, idx) => String(m.id || idx)}
          horizontal
          pagingEnabled
          scrollEnabled={!drawMode}
          showsHorizontalScrollIndicator={false}
          viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairsRef.current}
          initialScrollIndex={startIndex}
          getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
          renderItem={renderItem}
          removeClippedSubviews={Platform.OS === 'android'}
          style={StyleSheet.absoluteFill}
        />

        <View style={styles.topBar} pointerEvents="box-none">
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
          {drawMode ? (
            <TouchableOpacity onPress={sendDrawing} disabled={drawingBusy} style={styles.topBtn} accessibilityLabel="Send drawing">
              {drawingBusy ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="send" size={22} color="#fff" />}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.topBtn} accessibilityLabel="More actions">
              <Icon name="ellipsis-horizontal" size={24} color="#fff" />
            </TouchableOpacity>
          )}
        </View>

        {drawMode && <View style={styles.bottomOverlay}>{drawToolbar}</View>}

        {showMenu && !drawMode && (
          <View style={styles.menuOverlay}>
            <TouchableOpacity style={styles.menuBackdrop} onPress={() => setShowMenu(false)} />
            <View style={[styles.menu, { backgroundColor: theme.card }]}>
              <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Media actions</Text>
              <View style={styles.reactionRow}>
                {quickReactions.map((r) => (
                  <TouchableOpacity key={r} onPress={() => doReact(r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                    <ColorEmoji style={{ fontSize: fs(22), lineHeight: fs(30) }}>{r}</ColorEmoji>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                {actionMenu.map((a) => (
                  <TouchableOpacity key={a.key} onPress={a.onPress} style={[styles.menuItem, { backgroundColor: theme.primaryLight }]}>
                    <Icon name={a.icon} size={16} color={a.danger ? theme.danger : theme.primary} />
                    <Text style={{ color: a.danger ? theme.danger : theme.primary, fontWeight: '600', fontSize: fs(13), marginLeft: 6 }}>{a.label}</Text>
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
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5,
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: fs(10), paddingTop: fs(44), paddingBottom: fs(10),
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  topBtn: { width: fs(40), height: fs(40), alignItems: 'center', justifyContent: 'center' },
  topTitle: { color: '#fff', fontSize: fs(15), fontWeight: '700', maxWidth: SCREEN_W - fs(140) },
  topSub: { color: 'rgba(255,255,255,0.7)', fontSize: fs(12), marginTop: 2 },
  slide: { width: SCREEN_W, height: SCREEN_H, alignItems: 'center', justifyContent: 'center' },
  video: { width: SCREEN_W, height: SCREEN_H },
  vidError: { alignItems: 'center', justifyContent: 'center' },
  vidFallback: { flexDirection: 'row', alignItems: 'center', marginTop: 16, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22 },
  vidPosterWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', width: SCREEN_W },
  vidPlayBig: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)' },
  imgError: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  vidLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 3 },
  zoomRoot: { flex: 1, width: SCREEN_W, height: SCREEN_H, overflow: 'hidden' },
  zoomWrap: { flex: 1, width: SCREEN_W, height: SCREEN_H, alignItems: 'center', justifyContent: 'center' },
  zoomImg: { height: '100%' },
  imgLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  bottomOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5 },
  vidCtrlWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', paddingBottom: 10, alignItems: 'center' },
  vidCenterCtrl: { position: 'absolute', top: '42%', width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  vidCtrlRow: { flexDirection: 'row', alignItems: 'center', width: '100%', paddingHorizontal: 12, paddingTop: 10 },
  vidTime: { color: '#fff', fontSize: fs(11), fontVariant: ['tabular-nums'], minWidth: 38, textAlign: 'center' },
  vidSeekTrack: { flex: 1, height: 28, justifyContent: 'center', marginHorizontal: 8 },
  vidSeekTrackBg: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' },
  vidSeekFill: { position: 'absolute', left: 2, height: 3, borderRadius: 2, backgroundColor: '#fff', width: 0 },
  vidRateBtn: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.14)' },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menu: { position: 'absolute', right: 12, top: 90, width: SCREEN_W - 60, borderRadius: 16, padding: 14, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 16, elevation: 8 },
  menuTitle: { fontSize: fs(13), fontWeight: '700', marginBottom: 8 },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 14 },
  reactionBtn: { borderRadius: 14, width: fs(44), minHeight: fs(44), paddingVertical: fs(3), alignItems: 'center', justifyContent: 'center' },
  menuItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 9, paddingVertical: 9, paddingHorizontal: 12 },
});