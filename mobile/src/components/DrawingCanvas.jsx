import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Image, PanResponder, ActivityIndicator, Dimensions, TouchableOpacity } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { Icon } from './AppIcon';

const { width: SCREEN_W } = Dimensions.get('window');

export const DRAW_COLORS = ['#FFFFFF', '#FF5252', '#2196F3', '#4CAF50', '#FFC107', '#000000'];
export const DRAW_SIZES = [3, 6, 12];

const FLUSH_INTERVAL = 33;
const MIN_SEG_LEN = 2;
const ERASE_SCALE = 1.5;

function smoothPath(points) {
  if (!points || points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${mx} ${my}`;
  }
  d += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
  return d;
}

function strokeElement(stroke, key) {
  if (!stroke || !stroke.points || !stroke.points.length) return null;
  const { color, size, points } = stroke;
  if (points.length === 1) {
    return <Circle key={key} cx={points[0].x} cy={points[0].y} r={size / 2} fill={color} />;
  }
  return (
    <Path
      key={key}
      d={smoothPath(points)}
      stroke={color}
      strokeWidth={size}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  );
}

/** Erase drawing strokes (not the photo) by removing points under the eraser path. */
function eraseStrokes(strokes, points, radius) {
  if (!strokes.length || !points.length) return strokes;
  let changed = false;
  const out = [];
  for (let si = 0; si < strokes.length; si++) {
    const s = strokes[si];
    const keep = [];
    for (const pt of s.points) {
      let near = false;
      for (let ei = 0; ei < points.length; ei++) {
        const e = points[ei];
        const dx = pt.x - e.x;
        const dy = pt.y - e.y;
        if (dx * dx + dy * dy <= radius * radius) {
          near = true;
          break;
        }
      }
      keep.push(!near);
    }
    if (keep.every(Boolean)) {
      out.push(s);
      continue;
    }
    changed = true;
    let run = [];
    const flushRun = () => {
      if (run.length >= 1) {
        out.push({ color: s.color, size: s.size, points: run });
      }
      run = [];
    };
    for (let i = 0; i < s.points.length; i++) {
      if (keep[i]) run.push(s.points[i]);
      else flushRun();
    }
    flushRun();
  }
  return changed ? out : strokes;
}

/**
 * Contains `src` inside `box` (resizeMode=contain semantics) and returns the
 * displayed rectangle + scale so drawing coords map exactly on the visible image.
 */
function containBox(srcW, srcH, boxW, boxH) {
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { dw, dh, scale, ox: (boxW - dw) / 2, oy: (boxH - dh) / 2 };
}

export function DrawableImage({
  uri,
  drawRef,
  strokes,
  strokesRef,
  setStrokes,
  setRedoStack,
  drawModeRef,
  eraserRef,
  colorRef,
  brushRef,
  maxHeight,
  style,
}) {
  const [loading, setLoading] = useState(true);
  const [srcSize, setSrcSize] = useState(null);
  const [layout, setLayout] = useState({ w: SCREEN_W, h: maxHeight || 400 });
  const [active, setActive] = useState(null); // { points, color, size, cursor, erasing }

  const pointsRef = useRef([]);
  const eraserPtsRef = useRef([]);
  const lastFlushRef = useRef(0);
  const originRef = useRef({ x: 0, y: 0 });
  const readyRef = useRef(false);
  const drawingRef = useRef(false);

  useEffect(() => {
    pointsRef.current = [];
    eraserPtsRef.current = [];
    lastFlushRef.current = 0;
    setActive(null);
    setLoading(true);
  }, [uri]);

  useEffect(() => {
    let activeOk = true;
    const loadSize = (url) => {
      Image.getSize(url, (w, h) => {
        if (!activeOk || !w || !h) return;
        setSrcSize({ w, h });
      }, () => {
        if (activeOk) setSrcSize({ w: layout.w, h: layout.h });
      });
    };
    loadSize(uri);
    return () => { activeOk = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, layout.w, layout.h]);

  const dims = useCallback(() => {
    if (srcSize) return containBox(srcSize.w, srcSize.h, layout.w, layout.h);
    return { dw: layout.w, dh: layout.h, scale: 1, ox: 0, oy: 0 };
  }, [srcSize, layout.w, layout.h]);

  const localPoint = (e) => ({
    x: e.nativeEvent.pageX - originRef.current.x,
    y: e.nativeEvent.pageY - originRef.current.y,
  });

  const paintActive = () => {
    const now = Date.now();
    if (now - lastFlushRef.current < FLUSH_INTERVAL) return;
    lastFlushRef.current = now;
    const pts = pointsRef.current;
    const erasing = !!eraserRef.current;
    const activePts = erasing ? eraserPtsRef.current : pts;
    if (!activePts.length) return;
    const last = activePts[activePts.length - 1];
    setActive({ points: activePts, color: colorRef.current, size: brushRef.current, cursor: last, erasing });
  };

  const finishGesture = () => {
    readyRef.current = false;
    drawingRef.current = false;
    setActive(null);
    const erasing = !!eraserRef.current;
    if (erasing) {
      if (eraserPtsRef.current.length) {
        const radius = brushRef.current * ERASE_SCALE + 4;
        const current = strokesRef.current || [];
        setStrokes(eraseStrokes(current, eraserPtsRef.current, radius));
      }
      eraserPtsRef.current = [];
    } else {
      const pts = pointsRef.current;
      if (pts.length) {
        setStrokes((prev) => [...prev, { color: colorRef.current, size: brushRef.current, points: pts }]);
        if (setRedoStack) setRedoStack([]);
      }
    }
    pointsRef.current = [];
    lastFlushRef.current = 0;
  };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !!drawModeRef.current,
    onMoveShouldSetPanResponder: () => !!drawModeRef.current,
    onPanResponderGrant: (e) => {
      const node = drawRef.current;
      readyRef.current = false;
      pointsRef.current = [];
      eraserPtsRef.current = [];
      lastFlushRef.current = 0;
      const grantX = e.nativeEvent.pageX;
      const grantY = e.nativeEvent.pageY;
      const init = (x, y) => {
        originRef.current = { x, y };
        const p = { x: grantX - x, y: grantY - y };
        const bucket = eraserRef.current ? eraserPtsRef : pointsRef;
        bucket.current = [p];
        lastFlushRef.current = 0;
        readyRef.current = true;
        drawingRef.current = true;
        paintActive();
      };
      if (node && typeof node.measureInWindow === 'function') {
        node.measureInWindow((x, y) => init(x, y));
      } else {
        init(originRef.current.x, originRef.current.y);
      }
    },
    onPanResponderMove: (e) => {
      if (!readyRef.current) return;
      const p = localPoint(e);
      const bucket = eraserRef.current ? eraserPtsRef : pointsRef;
      const list = bucket.current;
      const last = list[list.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_SEG_LEN) return;
      list.push(p);
      if (eraserRef.current) setActive(null); // live-erase happens on release
      paintActive();
    },
    onPanResponderRelease: finishGesture,
    onPanResponderTerminate: finishGesture,
  })).current;

  const box = dims();
  const committed = (strokes || []).map((s, i) => strokeElement(s, `s${i}`));
  const activePath = active && active.points.length > 1 ? smoothPath(active.points) : '';

  return (
    <View
      style={[styles.canvasWrap, style]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setLayout({ w: width, h: maxHeight ? Math.min(height, maxHeight) : height });
        const node = drawRef.current;
        if (node && typeof node.measureInWindow === 'function') {
          node.measureInWindow((x, y) => {
            originRef.current = { x, y };
          });
        }
      }}
    >
      <View collapsable={false} ref={drawRef} style={{ width: box.dw, height: box.dh }}>
        {loading && (
          <View style={styles.imgLoading}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
        <Image source={{ uri }} style={{ width: box.dw, height: box.dh }} resizeMode="stretch" onLoad={() => setLoading(false)} />
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Svg width={box.dw} height={box.dh} viewBox={`0 0 ${box.dw} ${box.dh}`} style={StyleSheet.absoluteFill}>
            {committed}
            {activePath ? (
              <Path
                d={activePath}
                stroke={active.erasing ? 'rgba(255,255,255,0.9)' : active.color}
                strokeWidth={active.erasing ? 2 : active.size}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                strokeDasharray={active.erasing ? '4 6' : undefined}
              />
            ) : active && active.points.length === 1 && !active.erasing ? (
              <Circle cx={active.points[0].x} cy={active.points[0].y} r={active.size / 2} fill={active.color} />
            ) : null}
            {active && active.cursor ? (
              <Circle
                cx={active.cursor.x}
                cy={active.cursor.y}
                r={active.erasing ? 4 : active.size / 2}
                fill={active.erasing ? 'rgba(255,255,255,0.9)' : active.color}
                stroke={active.erasing ? 'rgba(108,60,233,0.8)' : 'rgba(255,255,255,0.6)'}
                strokeWidth={active.erasing ? 1.5 : 0.5}
                opacity={0.85}
                pointerEvents="none"
              />
            ) : null}
          </Svg>
        </View>
        <View style={StyleSheet.absoluteFill} {...pan.panHandlers} collapsable={false} />
      </View>
    </View>
  );
}

export function DrawingToolbar({
  theme, color, brush, setColor, setBrush,
  onUndo, onRedo, onClear, onDone, onCancel, busy, accent,
  eraser, setEraser, canUndo, canRedo,
}) {
  return (
    <View style={[styles.toolbar, { backgroundColor: theme.card }]}>
      <View style={styles.toolRow}>
        {onCancel && (
          <TouchableOpacity onPress={onCancel} accessibilityLabel="Exit drawing" style={[styles.toolBtn, { backgroundColor: 'rgba(0,0,0,0.05)' }]}>
            <Icon name="close" size={20} color={theme.danger} />
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={onUndo} disabled={!canUndo} accessibilityLabel="Undo" style={[styles.toolBtn, { backgroundColor: 'rgba(0,0,0,0.05)', opacity: canUndo ? 1 : 0.35 }]}>
          <Icon name="arrow-undo" size={20} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onRedo} disabled={!canRedo} accessibilityLabel="Redo" style={[styles.toolBtn, { backgroundColor: 'rgba(0,0,0,0.05)', opacity: canRedo ? 1 : 0.35 }]}>
          <Icon name="arrow-redo" size={20} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setEraser && setEraser(!eraser)}
          accessibilityLabel="Eraser"
          style={[styles.toolBtn, { backgroundColor: eraser ? 'rgba(108,60,233,0.25)' : 'rgba(0,0,0,0.05)' }]}
        >
          <Icon name="eraser" size={20} color={eraser ? '#6C3CE9' : theme.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClear} accessibilityLabel="Clear drawing" style={[styles.toolBtn, { backgroundColor: 'rgba(0,0,0,0.05)' }]}>
          <Icon name="trash-outline" size={20} color={theme.danger} />
        </TouchableOpacity>
        <View style={styles.colorRow}>
          {DRAW_COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              onPress={() => setColor(c)}
              accessibilityLabel={`Color ${c}`}
              style={[styles.colorSwatch, { backgroundColor: c }, color === c && styles.colorSwatchActive]}
            />
          ))}
        </View>
        <View style={styles.sizeRow}>
          {DRAW_SIZES.map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => setBrush(s)}
              accessibilityLabel={`Brush size ${s}`}
              style={[styles.sizeDot, { borderColor: brush === s ? '#6C3CE9' : 'transparent', borderWidth: 2 }]}
            >
              <View style={{ width: s + 4, height: s + 4, borderRadius: (s + 4) / 2, backgroundColor: brush === s ? theme.primary : theme.textSecondary }} />
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={onDone} disabled={busy} accessibilityLabel="Apply drawing" style={[styles.doneBtn, { backgroundColor: accent || theme.primary }]}>
          {busy ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="checkmark" size={20} color="#fff" />}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvasWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  imgLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  toolbar: { paddingVertical: 8, paddingHorizontal: 10, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.1)' },
  toolRow: { flexDirection: 'row', alignItems: 'center' },
  toolBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  colorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 8 },
  colorSwatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(0,0,0,0.15)' },
  colorSwatchActive: { borderWidth: 3, borderColor: '#6C3CE9' },
  sizeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sizeDot: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.05)' },
  doneBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});