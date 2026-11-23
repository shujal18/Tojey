import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, Image, PanResponder, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { clamp } from '../../../components/video/videoConfig';
import { absUrl } from '../../../config';
import { fs } from '../../../utils/size';
import { Icon } from '../../AppIcon';

const CHROME_MS = 180;
const FADE_MS = 180;
const TAP_GAP = 320;
const TAP_MOVE = 12;
const SUPPRESS_MS = 340;
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

export default function FullscreenImageViewer({ item, onClose }) {
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
    if (singleTimer.current) {
      clearTimeout(singleTimer.current);
      singleTimer.current = null;
    }
    setChrome(false, true);
  }, [gesture, setChrome]);

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
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponderCapture: () => false,
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
        const rawX = current.focusX - (current.focusX - current.startX) * ratio;
        const rawY = current.focusY - (current.focusY - current.startY) * ratio;
        const limits = api.current.limitsFor(nextScale);
        api.current.applyTransform(
          nextScale,
          clamp(rawX, -limits.x, limits.x),
          clamp(rawY, -limits.y, limits.y),
        );
        return;
      }
      if (pinch.current) return;
      const current = active.current;
      if (!current) return;
      const dx = Number(state.dx) || 0;
      const dy = Number(state.dy) || 0;
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
        gesture.suppressUntil = Date.now() + SUPPRESS_MS;
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
      gesture.suppressUntil = Date.now() + SUPPRESS_MS;
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

  return (
    <View
      style={styles.root}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setLayout({ width, height });
      }}
      {...panHandlers}
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
        pointerEvents={chromeVisible ? 'box-none' : 'none'}
      >
        <View style={styles.gradientStrong} pointerEvents="none" />
        <View style={styles.gradientSoft} pointerEvents="none" />
        <TouchableOpacity
          onPress={onClose}
          style={styles.backButton}
          accessibilityLabel="Back"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Icon name="arrow-back" size={fs(26)} color="#fff" />
        </TouchableOpacity>
        {senderLabel || dateLabel ? (
          <View style={styles.meta} pointerEvents="none">
            {senderLabel ? (
              <Text style={styles.metaPrimary} numberOfLines={1}>{senderLabel}</Text>
            ) : null}
            {dateLabel ? (
              <Text style={styles.metaSecondary} numberOfLines={1}>{dateLabel}</Text>
            ) : null}
          </View>
        ) : null}
      </Animated.View>
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
});
