import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Image, PanResponder, ActivityIndicator, Dimensions, TouchableOpacity } from 'react-native';
import { Icon } from './AppIcon';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export const DRAW_COLORS = ['#FFFFFF', '#FF5252', '#2196F3', '#4CAF50', '#FFC107', '#000000'];
export const DRAW_SIZES = [3, 6, 12];

const DRAW_MAX_W = SCREEN_W;
const DRAW_MAX_H = SCREEN_H - 180;

export function DrawableImage({ uri, drawRef, strokes, curPoints, color, brush, drawModeRef, colorRef, brushRef, lastPtRef, setCurPoints, setStrokes, maxHeight = DRAW_MAX_H, style }) {
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState(null);

  const pointsRef = useRef([]);
  const lastFlushRef = useRef(0);
  const originRef = useRef({ x: 0, y: 0 });

  const pointFromEvent = (e) => ({
    x: e.nativeEvent.pageX - originRef.current.x,
    y: e.nativeEvent.pageY - originRef.current.y,
  });

  const [itemW, setItemW] = useState(SCREEN_W);
  const [itemH, setItemH] = useState(maxHeight);
  useEffect(() => {
    setItemW(SCREEN_W);
    setItemH(maxHeight);
  }, [maxHeight]);

  useEffect(() => {
    let active = true;
    Image.getSize(uri, (w, h) => {
      if (!active || !w || !h) return;
      const scale = Math.min(itemW / w, itemH / h);
      setSize({ w: Math.round(w * scale), h: Math.round(h * scale) });
    }, () => {
      if (active) setSize({ w: itemW, h: itemH });
    });
    return () => { active = false; };
  }, [uri, itemW, itemH]);

  const flush = () => setCurPoints([...pointsRef.current]);

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !!drawModeRef.current,
    onMoveShouldSetPanResponder: () => !!drawModeRef.current,
    onPanResponderGrant: (e) => {
      pointsRef.current = [pointFromEvent(e)];
      lastFlushRef.current = 0;
      flush();
    },
    onPanResponderMove: (e) => {
      const p = pointFromEvent(e);
      const pts = pointsRef.current;
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 3) return;
      pointsRef.current = [...pts, p];
      const now = Date.now();
      if (now - lastFlushRef.current >= 33) {
        lastFlushRef.current = now;
        flush();
      }
    },
    onPanResponderRelease: () => {
      const pts = pointsRef.current;
      if (pts.length) {
        setStrokes((prev) => [...prev, { color: colorRef.current, size: brushRef.current, points: pts }]);
      }
      pointsRef.current = [];
      setCurPoints(null);
      lastPtRef.current = null;
    },
    onPanResponderTerminate: () => {
      const pts = pointsRef.current;
      if (pts.length) {
        setStrokes((prev) => [...prev, { color: colorRef.current, size: brushRef.current, points: pts }]);
      }
      pointsRef.current = [];
      setCurPoints(null);
      lastPtRef.current = null;
    },
  })).current;

  const lines = [];
  const pushLines = (stroke) => {
    if (!stroke || !stroke.points || stroke.points.length < 2) return;
    for (let i = 1; i < stroke.points.length; i++) {
      const p1 = stroke.points[i - 1];
      const p2 = stroke.points[i];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI - 90;
      lines.push(
        <View
          key={`${i}-${p1.x}-${p1.y}`}
          style={{
            position: 'absolute',
            width: stroke.size,
            height: len,
            left: (p1.x + p2.x) / 2 - stroke.size / 2,
            top: (p1.y + p2.y) / 2 - len / 2,
            backgroundColor: stroke.color,
            borderRadius: stroke.size / 2,
            transform: [{ rotate: `${angle}deg` }],
          }}
        />
      );
    }
  };
  strokes.forEach((s) => pushLines(s));
  pushLines({ color, size: brush, points: curPoints || [] });

  const dims = size || { w: itemW, h: itemH };

  return (
    <View style={[styles.canvasWrap, style]}>
      <View
        collapsable={false}
        ref={drawRef}
        onLayout={() => {
          const node = drawRef.current;
          if (node && typeof node.measureInWindow === 'function') {
            node.measureInWindow((x, y) => {
              originRef.current = { x, y };
            });
          }
        }}
        style={{ width: dims.w, height: dims.h }}
      >
        {loading && (
          <View style={styles.imgLoading}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
        <Image source={{ uri }} style={{ width: dims.w, height: dims.h }} resizeMode="stretch" onLoad={() => setLoading(false)} />
        <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
          {lines}
        </View>
      </View>
    </View>
  );
}

export function DrawingToolbar({ theme, color, brush, setColor, setBrush, onUndo, onClear, onDone, busy, accent }) {
  return (
    <View style={[styles.toolbar, { backgroundColor: theme.card }]}>
      <View style={styles.toolRow}>
        <TouchableOpacity onPress={onUndo} accessibilityLabel="Undo" style={[styles.toolBtn, { backgroundColor: 'rgba(0,0,0,0.05)' }]}>
          <Icon name="arrow-undo" size={20} color={theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClear} accessibilityLabel="Clear drawing" style={[styles.toolBtn, { backgroundColor: 'rgba(0,0,0,0.05)' }]}>
          <Icon name="trash-outline" size={20} color={theme.danger} />
        </TouchableOpacity>
        <View style={styles.colorRow}>
          {DRAW_COLORS.map((c) => (
            <TouchableOpacity
              key={c}
              onPress={() => setColor(c)}
              style={[styles.colorSwatch, { backgroundColor: c }, color === c && styles.colorSwatchActive]}
            />
          ))}
        </View>
        <View style={styles.sizeRow}>
          {DRAW_SIZES.map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => setBrush(s)}
              style={[styles.sizeDot, brush === s && styles.sizeDotActive]}
            >
              <View style={{ width: s + 4, height: s + 4, borderRadius: (s + 4) / 2, backgroundColor: brush === s ? theme.primary : theme.textSecondary }} />
            </TouchableOpacity>
          ))}
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={onDone} disabled={busy} style={[styles.doneBtn, { backgroundColor: accent || theme.primary }]}>
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
  sizeDotActive: { backgroundColor: 'rgba(108,60,233,0.15)' },
});