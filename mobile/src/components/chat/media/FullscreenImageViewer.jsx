import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, Image, PanResponder, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { clamp } from '../../../components/video/videoConfig';
import { absUrl } from '../../../config';
import { DRAW_COLORS, DRAW_SIZES, DrawableImage, DrawingToolbar } from '../../DrawingCanvas';
import { quickReactions } from '../../../theme';
import ColorEmoji from '../../ColorEmoji';
import { fs } from '../../../utils/size';
import { Icon } from '../../AppIcon';

const CHROME_MS = 180;
const FADE_MS = 180;
const TAP_GAP = 320;
const TAP_MOVE = 20;
const SUPPRESS_MS = 260;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;

function distance(a, b) {
  const dx = Number(a.pageX) - Number(b.pageX);
  const dy = Number(a.pageY) - Number(b.pageY);
  return Math.sqrt(dx * dx + dy * dy);
}

function midpoint(a, b) {
  return {
    x: (Number(a.pageX) + Number(b.pageX)) / 2,
    y: (Number(a.pageY) + Number(b.pageY)) / 2,
  };
}

function MenuButton({ icon, label, onPress, danger }) {
  return (
    <TouchableOpacity style={styles.menuButton} onPress={onPress} accessibilityLabel={label}>
      <Icon name={icon} size={fs(17)} color={danger ? '#FF8A80' : '#fff'} />
      <Text style={[styles.menuButtonText, danger && styles.menuButtonTextDanger]}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function FullscreenImageViewer({
  item,
  onClose,
  onExternal,
  onReact,
  onReply,
  onSave,
  onCopy,
  onDelete,
  onSendDrawing,
  currentUserId,
  theme,
}) {
  const screen = Dimensions.get('window');
  const [layout, setLayout] = useState({ width: screen.width || 1, height: screen.height || 1 });
  const [natural, setNatural] = useState(() => ({
    width: Number(item?.media_width) || 0,
    height: Number(item?.media_height) || 0,
  }));
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [strokes, setStrokes] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [eraser, setEraser] = useState(false);
  const [color, setColor] = useState(DRAW_COLORS[1]);
  const [brush, setBrush] = useState(DRAW_SIZES[1]);

  const fullUri = absUrl(item?.media_url);
  const thumbUri = absUrl(item?.thumb_url);

  const fullOpacity = useRef(new Animated.Value(0)).current;
  const chromeOpacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const gesture = useRef({ scale: 1, x: 0, y: 0, chrome: true, suppressUntil: 0 }).current;
  const layoutRef = useRef(layout);
  const pinch = useRef(null);
  const active = useRef(null);
  const singleTimer = useRef(null);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });
  const api = useRef({});
  const drawRef = useRef(null);
  const strokesRef = useRef(strokes);
  const redoStackRef = useRef(redoStack);
  const eraserRef = useRef(eraser);
  const colorRef = useRef(color);
  const brushRef = useRef(brush);
  const drawModeRef = useRef(false);
  const actionApi = useRef({});

  strokesRef.current = strokes;
  redoStackRef.current = redoStack;
  eraserRef.current = eraser;
  colorRef.current = color;
  brushRef.current = brush;
  drawModeRef.current = drawMode;

  const display = useMemo(() => {
    const w = Number(natural.width) > 0 ? Number(natural.width) : 4;
    const h = Number(natural.height) > 0 ? Number(natural.height) : 3;
    const fit = Math.min(layout.width / w, layout.height / h);
    return { width: w * fit, height: h * fit };
  }, [natural, layout]);

  layoutRef.current = layout;
  const displayRef = useRef(display);
  displayRef.current = display;

  const limitsFor = useCallback((nextScale) => ({
    x: Math.max(0, (displayRef.current.width * nextScale - layoutRef.current.width) / 2),
    y: Math.max(0, (displayRef.current.height * nextScale - layoutRef.current.height) / 2),
  }), []);

  const applyTransform = useCallback((nextScale, x, y) => {
    scale.stopAnimation();
    translateX.stopAnimation();
    translateY.stopAnimation();
    gesture.scale = nextScale;
    gesture.x = x;
    gesture.y = y;
    scale.setValue(nextScale);
    translateX.setValue(x);
    translateY.setValue(y);
  }, [gesture, scale, translateX, translateY]);

  const animateTo = useCallback((nextScale, x, y) => {
    scale.stopAnimation();
    translateX.stopAnimation();
    translateY.stopAnimation();
    gesture.scale = nextScale;
    gesture.x = x;
    gesture.y = y;
    Animated.parallel([
      Animated.timing(scale, { toValue: nextScale, duration: 220, useNativeDriver: true }),
      Animated.timing(translateX, { toValue: x, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: y, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [gesture, scale, translateX, translateY]);

  const setChrome = useCallback((next, immediate = false) => {
    if (gesture.chrome === next) return;
    gesture.chrome = next;
    if (immediate) chromeOpacity.setValue(next ? 1 : 0);
    setChromeVisible(next);
  }, [chromeOpacity, gesture]);

  const toggleZoomAt = useCallback((x, y) => {
    const target = gesture.scale > 1.05 ? 1 : DOUBLE_TAP_SCALE;
    if (target === 1) {
      animateTo(1, 0, 0);
      return;
    }
    const fx = x - layoutRef.current.width / 2;
    const fy = y - layoutRef.current.height / 2;
    const limits = limitsFor(target);
    animateTo(
      target,
      clamp(-fx * (target - 1), -limits.x, limits.x),
      clamp(-fy * (target - 1), -limits.y, limits.y),
    );
  }, [animateTo, gesture, limitsFor]);

  const startPinch = useCallback((touches) => {
    if (!touches || touches.length < 2) return;
    const distanceBetween = distance(touches[0], touches[1]) || 1;
    const mid = midpoint(touches[0], touches[1]);
    pinch.current = {
      startDistance: distanceBetween,
      startScale: gesture.scale,
      startX: gesture.x,
      startY: gesture.y,
      focusX: mid.x - layoutRef.current.width / 2,
      focusY: mid.y - layoutRef.current.height / 2,
      moved: false,
    };
    active.current = null;
    gesture.suppressUntil = 0;
    if (singleTimer.current) {
      clearTimeout(singleTimer.current);
      singleTimer.current = null;
    }
    setChrome(false, true);
  }, [gesture, setChrome]);

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

  const exitDrawing = useCallback(() => {
    setDrawMode(false);
    setDrawingBusy(false);
    setStrokes([]);
    strokesRef.current = [];
    setRedoStack([]);
    redoStackRef.current = [];
  }, []);

  const sendDrawing = useCallback(async () => {
    if (!drawRef.current || drawingBusy) return;
    setDrawingBusy(true);
    try {
      const shot = await captureRef(drawRef, { format: 'png', quality: 0.92, result: 'tmpfile' });
      if (typeof onSendDrawing === 'function') {
        onSendDrawing(shot, exitDrawing);
      } else {
        exitDrawing();
      }
    } catch (e) {
      console.error('fullscreen draw capture failed', e);
      setDrawingBusy(false);
    }
  }, [drawingBusy, exitDrawing, onSendDrawing]);

  actionApi.current = { onExternal, onReact, onReply, onSave, onCopy, onDelete, onClose, exitDrawing };

  api.current = {
    startPinch,
    limitsFor,
    applyTransform,
    setChrome,
    toggleZoomAt,
    animateTo,
  };

  const panHandlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: (event) => (event.nativeEvent.touches || []).length >= 2,
    onMoveShouldSetPanResponderCapture: (event) => (event.nativeEvent.touches || []).length >= 2,
    onPanResponderGrant: (event, state) => {
      if (singleTimer.current) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      const touches = event.nativeEvent.touches || [];
      if (touches.length >= 2) {
        api.current.startPinch(touches);
        return;
      }
      active.current = {
        x0: state.x0,
        y0: state.y0,
        moved: false,
        mode: null,
        baseX: gesture.x,
        baseY: gesture.y,
        panStartX: null,
        panStartY: null,
      };
    },
    onPanResponderMove: (event, state) => {
      const touches = event.nativeEvent.touches || [];
      if (touches.length >= 2) {
        if (!pinch.current) api.current.startPinch(touches);
        const current = pinch.current;
        if (!current) return;
        const nextScale = clamp(
          current.startScale * ((distance(touches[0], touches[1]) || 1) / current.startDistance),
          1,
          MAX_SCALE,
        );
        if (Math.abs(nextScale - current.startScale) > 0.03) current.moved = true;
        const ratio = nextScale / current.startScale;
        const rawX = current.startX + current.focusX * (1 - ratio);
        const rawY = current.startY + current.focusY * (1 - ratio);
        const limits = api.current.limitsFor(nextScale);
        api.current.applyTransform(
          nextScale,
          clamp(rawX, -limits.x, limits.x),
          clamp(rawY, -limits.y, limits.y),
        );
        return;
      }
      if (pinch.current) {
        pinch.current = null;
        active.current = {
          x0: touches[0] ? Number(touches[0].pageX) || 0 : Number(state.x0) || 0,
          y0: touches[0] ? Number(touches[0].pageY) || 0 : Number(state.y0) || 0,
          moved: true,
          mode: 'pan',
          baseX: gesture.x,
          baseY: gesture.y,
          panStartX: touches[0] ? Number(touches[0].pageX) || 0 : null,
          panStartY: touches[0] ? Number(touches[0].pageY) || 0 : null,
        };
      }
      const current = active.current;
      if (!current) return;
      const dx = current.panStartX != null && touches[0]
        ? (Number(touches[0].pageX) || 0) - current.panStartX
        : Number(state.dx) || 0;
      const dy = current.panStartY != null && touches[0]
        ? (Number(touches[0].pageY) || 0) - current.panStartY
        : Number(state.dy) || 0;
      if (Math.abs(dx) > TAP_MOVE || Math.abs(dy) > TAP_MOVE) current.moved = true;
      if (!current.moved || gesture.scale <= 1.01) return;
      current.mode = 'pan';
      const limits = api.current.limitsFor(gesture.scale);
      api.current.applyTransform(
        gesture.scale,
        clamp(current.baseX + dx, -limits.x, limits.x),
        clamp(current.baseY + dy, -limits.y, limits.y),
      );
    },
    onPanResponderRelease: () => {
      if (pinch.current) {
        const current = pinch.current;
        pinch.current = null;
        const limits = api.current.limitsFor(gesture.scale);
        api.current.applyTransform(
          gesture.scale,
          clamp(gesture.x, -limits.x, limits.x),
          clamp(gesture.y, -limits.y, limits.y),
        );
        if (!current.moved && gesture.scale < 1.05) api.current.animateTo(1, 0, 0);
        return;
      }
      const current = active.current;
      active.current = null;
      if (!current || current.moved || current.mode === 'pan') return;
      const now = Date.now();
      if (now < gesture.suppressUntil) return;
      const x = Number(current.x0) || 0;
      const y = Number(current.y0) || 0;
      const previous = lastTap.current;
      if (now - previous.time < TAP_GAP && Math.abs(x - previous.x) < 48 && Math.abs(y - previous.y) < 48) {
        lastTap.current = { time: 0, x: 0, y: 0 };
        gesture.suppressUntil = now + SUPPRESS_MS;
        api.current.toggleZoomAt(x, y);
        return;
      }
      lastTap.current = { time: now, x, y };
      if (singleTimer.current) clearTimeout(singleTimer.current);
      singleTimer.current = setTimeout(() => {
        singleTimer.current = null;
        if (Date.now() < gesture.suppressUntil) return;
        lastTap.current = { time: 0, x: 0, y: 0 };
        api.current.setChrome(!gesture.chrome);
      }, TAP_GAP);
    },
    onPanResponderTerminate: () => {
      if (singleTimer.current) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      active.current = null;
      pinch.current = null;
    },
    onPanResponderTerminationRequest: () => false,
  }), [gesture]);

  useEffect(() => {
    gesture.scale = 1;
    gesture.x = 0;
    gesture.y = 0;
    gesture.chrome = true;
    gesture.suppressUntil = 0;
    scale.setValue(1);
    translateX.setValue(0);
    translateY.setValue(0);
    fullOpacity.setValue(0);
    chromeOpacity.setValue(1);
    setLoading(true);
    setFailed(false);
    setChromeVisible(true);
    setMenuOpen(false);
    setDrawMode(false);
    setDrawingBusy(false);
    setStrokes([]);
    strokesRef.current = [];
    setRedoStack([]);
    redoStackRef.current = [];
    if (singleTimer.current) {
      clearTimeout(singleTimer.current);
      singleTimer.current = null;
    }
    active.current = null;
    pinch.current = null;
    lastTap.current = { time: 0, x: 0, y: 0 };
    return () => {
      if (singleTimer.current) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      active.current = null;
      pinch.current = null;
      gesture.scale = 1;
      gesture.x = 0;
      gesture.y = 0;
      scale.setValue(1);
      translateX.setValue(0);
      translateY.setValue(0);
    };
  }, [item?.id, chromeOpacity, fullOpacity, gesture, scale, translateX, translateY]);

  useEffect(() => {
    if (!fullUri) {
      setFailed(true);
      setLoading(false);
      return undefined;
    }
    const width = Number(item?.media_width);
    const height = Number(item?.media_height);
    if (width > 0 && height > 0) {
      setNatural({ width, height });
      return undefined;
    }
    let alive = true;
    Image.getSize(
      fullUri,
      (imageWidth, imageHeight) => {
        if (alive && imageWidth > 0 && imageHeight > 0) setNatural({ width: imageWidth, height: imageHeight });
      },
      () => {
        if (alive) setNatural({ width: 4, height: 3 });
      },
    );
    return () => { alive = false; };
  }, [fullUri, item?.media_width, item?.media_height]);

  useEffect(() => {
    Animated.timing(chromeOpacity, {
      toValue: chromeVisible ? 1 : 0,
      duration: CHROME_MS,
      useNativeDriver: true,
    }).start();
  }, [chromeOpacity, chromeVisible]);

  const retry = useCallback(() => {
    setFailed(false);
    setLoading(true);
    fullOpacity.setValue(0);
    setRetryKey((key) => key + 1);
  }, [fullOpacity]);

  const senderLabel = item?.sender_name || item?.senderName || item?.name;
  const dateLabel = item?.created_at || item?.date || item?.timestamp;
  const caption = item?.content ? String(item.content) : '';
  const isOwn = !!item && Number(item.sender_id) === Number(currentUserId) && Number(currentUserId) > 0;
  const menuTheme = theme || {};

  return (
    <View
      style={styles.root}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setLayout({ width, height });
      }}
      {...(drawMode ? {} : panHandlers)}
    >
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <Animated.View
          style={[
            styles.imageWrap,
            { transform: [{ translateX }, { translateY }, { scale }] },
          ]}
        >
          {thumbUri ? (
            <Image
              source={{ uri: thumbUri }}
              style={[styles.image, {
                width: display.width,
                height: display.height,
                left: (layout.width - display.width) / 2,
                top: (layout.height - display.height) / 2,
              }]}
              resizeMode="contain"
            />
          ) : null}
          {!failed && fullUri ? (
            <Animated.Image
              key={retryKey}
              source={{ uri: fullUri }}
              style={[styles.image, {
                width: display.width,
                height: display.height,
                left: (layout.width - display.width) / 2,
                top: (layout.height - display.height) / 2,
                opacity: fullOpacity,
              }]}
              resizeMode="contain"
              onLoadStart={() => setLoading(true)}
              onLoad={() => {
                setLoading(false);
                setFailed(false);
                fullOpacity.setValue(0);
                Animated.timing(fullOpacity, {
                  toValue: 1,
                  duration: FADE_MS,
                  useNativeDriver: true,
                }).start();
              }}
              onError={() => {
                setLoading(false);
                setFailed(true);
              }}
            />
          ) : null}
        </Animated.View>
      </View>

      {loading && !failed ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator size="small" color="rgba(255,255,255,0.72)" />
        </View>
      ) : null}

      {failed ? (
        <View style={styles.error} pointerEvents="box-none">
          <TouchableOpacity style={styles.retry} onPress={retry} accessibilityLabel="Retry">
            <Icon name="refresh-outline" size={fs(17)} color="rgba(255,255,255,0.85)" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <Animated.View
        style={[styles.topBar, { opacity: chromeOpacity }]}
        pointerEvents={chromeVisible || drawMode ? 'box-none' : 'none'}
      >
        <View style={styles.gradientStrong} pointerEvents="none" />
        <View style={styles.gradientSoft} pointerEvents="none" />
        <TouchableOpacity
          onPress={() => (drawMode ? actionApi.current.exitDrawing() : onClose())}
          style={styles.backButton}
          accessibilityLabel={drawMode ? 'Exit drawing' : 'Back'}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Icon name="arrow-back" size={fs(26)} color="#fff" />
        </TouchableOpacity>
        {senderLabel || dateLabel || drawMode ? (
          <View style={styles.meta} pointerEvents="none">
            {drawMode ? (
              <Text style={styles.metaPrimary} numberOfLines={1}>Draw on photo</Text>
            ) : senderLabel ? (
              <Text style={styles.metaPrimary} numberOfLines={1}>{senderLabel}</Text>
            ) : null}
            {!drawMode && dateLabel ? (
              <Text style={styles.metaSecondary} numberOfLines={1}>{dateLabel}</Text>
            ) : null}
          </View>
        ) : null}
        {drawMode ? (
          <TouchableOpacity
            onPress={sendDrawing}
            disabled={drawingBusy}
            style={styles.actionButton}
            accessibilityLabel="Send drawing"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            {drawingBusy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Icon name="send" size={fs(22)} color="#fff" />}
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              onPress={() => { setDrawMode(true); setChrome(true, true); }}
              style={styles.actionButton}
              accessibilityLabel="Draw on image"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Icon name="color-wand" size={fs(21)} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { if (typeof actionApi.current.onSave === 'function') actionApi.current.onSave(item); }}
              style={styles.actionButton}
              accessibilityLabel="Save image"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Icon name="download-outline" size={fs(22)} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setMenuOpen(true)}
              style={styles.actionButton}
              accessibilityLabel="More actions"
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <Icon name="ellipsis-horizontal" size={fs(24)} color="#fff" />
            </TouchableOpacity>
          </>
        )}
      </Animated.View>

      {drawMode ? (
        <View style={styles.drawLayer}>
          <DrawableImage
            key={`${fullUri || retryKey}-draw`}
            uri={fullUri}
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
          <View style={styles.drawToolbarWrap}>
            <DrawingToolbar
              theme={menuTheme}
              color={color}
              brush={brush}
              setColor={setColor}
              setBrush={setBrush}
              onUndo={undoDrawing}
              onRedo={redoDrawing}
              onClear={() => { setStrokes([]); strokesRef.current = []; setRedoStack([]); redoStackRef.current = []; }}
              onDone={sendDrawing}
              onCancel={exitDrawing}
              busy={drawingBusy}
              eraser={eraser}
              setEraser={setEraser}
              canUndo={strokes.length > 0}
              canRedo={redoStack.length > 0}
            />
          </View>
        </View>
      ) : null}

      {menuOpen && !drawMode ? (
        <View style={styles.menuOverlay} pointerEvents="box-none">
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)} accessibilityLabel="Close actions" />
          <View style={[styles.menu, { backgroundColor: menuTheme.card || '#1e2529' }]}>
            <Text style={[styles.menuTitle, { color: menuTheme.textSecondary || 'rgba(255,255,255,0.7)' }]}>Media actions</Text>
            <View style={styles.reactionRow}>
              {quickReactions.map((reaction) => (
                <TouchableOpacity
                  key={reaction}
                  style={[styles.reactionBtn, { backgroundColor: menuTheme.primaryLight || 'rgba(255,255,255,0.12)' }]}
                  onPress={() => {
                    setMenuOpen(false);
                    if (typeof actionApi.current.onReact === 'function') actionApi.current.onReact(item.id, reaction);
                  }}
                >
                  <ColorEmoji style={{ fontSize: fs(22), lineHeight: fs(30) }}>{reaction}</ColorEmoji>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.actionGrid}>
              <MenuButton icon="return-down-back-outline" label="Reply" onPress={() => { setMenuOpen(false); actionApi.current.onReply?.(item); }} />
              <MenuButton icon="open-outline" label="Open" onPress={() => { setMenuOpen(false); actionApi.current.onExternal?.(item); }} />
              {caption ? (
                <MenuButton icon="copy-outline" label="Copy" onPress={() => { setMenuOpen(false); actionApi.current.onCopy?.(caption); }} />
              ) : null}
              <MenuButton icon="trash-outline" label="Delete" danger onPress={() => { setMenuOpen(false); actionApi.current.onDelete?.(item, 'me'); }} />
              {isOwn ? (
                <MenuButton icon="arrow-undo-outline" label="Unsend" danger onPress={() => { setMenuOpen(false); actionApi.current.onDelete?.(item, 'everyone'); }} />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  imageWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    position: 'absolute',
  },
  loading: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginLeft: -fs(12),
    marginTop: -fs(12),
    width: fs(24),
    height: fs(24),
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: fs(30),
  },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: fs(12),
    paddingVertical: fs(7),
    borderRadius: fs(18),
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  retryText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: fs(13),
    marginLeft: fs(6),
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: fs(112),
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: fs(8),
    paddingTop: fs(10),
  },
  gradientStrong: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: fs(64),
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  gradientSoft: {
    position: 'absolute',
    top: fs(64),
    left: 0,
    right: 0,
    height: fs(48),
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  backButton: {
    width: fs(42),
    height: fs(42),
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    justifyContent: 'center',
    paddingTop: fs(6),
    maxWidth: '70%',
  },
  metaPrimary: {
    color: 'rgba(255,255,255,0.94)',
    fontSize: fs(14),
    fontWeight: '600',
  },
  metaSecondary: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: fs(11),
    marginTop: fs(2),
  },
  actionButton: {
    width: fs(42),
    height: fs(42),
    marginLeft: 'auto',
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 18,
    backgroundColor: '#050505',
  },
  drawToolbarWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
  },
  menuOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: fs(58),
    paddingHorizontal: fs(12),
  },
  menu: {
    padding: fs(14),
    maxWidth: '100%',
    borderRadius: fs(16),
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: fs(12),
    elevation: 12,
  },
  menuTitle: {
    fontSize: fs(12),
    fontWeight: '700',
    marginBottom: fs(10),
  },
  reactionRow: {
    flexDirection: 'row',
    gap: fs(8),
    marginBottom: fs(12),
  },
  reactionBtn: {
    width: fs(44),
    minHeight: fs(48),
    paddingVertical: fs(4),
    borderRadius: fs(22),
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: fs(8),
  },
  menuButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: fs(12),
    paddingVertical: fs(9),
    borderRadius: fs(10),
    backgroundColor: 'rgba(255,255,255,0.09)',
  },
  menuButtonText: {
    color: '#fff',
    fontSize: fs(12),
    fontWeight: '600',
    marginLeft: fs(6),
  },
  menuButtonTextDanger: {
    color: '#FF8A80',
  },
});
