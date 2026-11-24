import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Dimensions, Image, PanResponder, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import Video from 'react-native-video';
import { clamp, VIDEO_ACCENT } from '../../../components/video/videoConfig';
import { absUrl } from '../../../config';
import { canInlineVideoPreview } from '../../../utils/media';
import { fs } from '../../../utils/size';
import { Icon } from '../../AppIcon';
import ChatVideoControls from './ChatVideoControls';

const AUTO_HIDE_MS = 3000;
const FADE_MS = 180;
const TAP_GAP = 320;
const TAP_MOVE = 24;
const SUPPRESS_MS = 260;
const MAX_SCALE = 3;
const SEEK_STEP = 10;

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

export default function FullscreenVideoViewer({ item, onClose, onExternal }) {
  const screen = Dimensions.get('window');
  const [layout, setLayout] = useState({ width: screen.width || 1, height: screen.height || 1 });
  const [playing, setPlaying] = useState(true);
  const [buffering, setBuffering] = useState(true);
  const [duration, setDuration] = useState(() => Number(item?.duration) || 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [seekFeedback, setSeekFeedback] = useState(null);
  const [videoKey, setVideoKey] = useState(0);

  const mediaUri = absUrl(item?.media_url);
  const thumbUri = absUrl(item?.thumb_url);
  const inline = canInlineVideoPreview(item?.file_name, item?.mime_type);
  const sourceWidth = Number(item?.media_width) || 16;
  const sourceHeight = Number(item?.media_height) || 9;
  const display = useMemo(() => {
    const fit = Math.min(layout.width / sourceWidth, layout.height / sourceHeight);
    return { width: sourceWidth * fit, height: sourceHeight * fit };
  }, [layout, sourceWidth, sourceHeight]);

  const posterOpacity = useRef(new Animated.Value(1)).current;
  const feedbackOpacity = useRef(new Animated.Value(0)).current;
  const feedbackAnim = useRef(null);
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  const videoRef = useRef(null);
  const hideTimer = useRef(null);
  const singleTimer = useRef(null);
  const pinch = useRef(null);
  const active = useRef(null);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });
  const gesture = useRef({ zoom: 1, x: 0, y: 0, suppressUntil: 0 }).current;
  const api = useRef({});

  const playingRef = useRef(playing);
  const controlsRef = useRef(controlsVisible);
  const menuOpenRef = useRef(false);
  const hideTimerToken = useRef(0);
  const durationRef = useRef(duration);
  const timeRef = useRef(Number(currentTime) || 0);
  const layoutRef = useRef(layout);
  const displayRef = useRef(display);
  const inlineRef = useRef(inline);

  inlineRef.current = inline;
  playingRef.current = playing;
  durationRef.current = duration;
  timeRef.current = Number(currentTime) || 0;
  layoutRef.current = layout;
  displayRef.current = display;

  const fadePoster = useCallback(() => {
    setBuffering(false);
    posterOpacity.stopAnimation();
    Animated.timing(posterOpacity, {
      toValue: 0,
      duration: FADE_MS,
      useNativeDriver: true,
    }).start();
  }, [posterOpacity]);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    hideTimerToken.current += 1;
    const token = hideTimerToken.current;
    if (!inlineRef.current || !playingRef.current || !controlsRef.current ||
        menuOpenRef.current || gesture.zoom > 1.01) return;
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      if (token !== hideTimerToken.current) return;
      if (!playingRef.current || menuOpenRef.current || gesture.zoom > 1.01) return;
      if (!controlsRef.current) return;
      controlsRef.current = false;
      gesture.suppressUntil = 0;
      setControlsVisible(false);
    }, AUTO_HIDE_MS);
  }, [gesture]);

  const setControls = useCallback((next) => {
    controlsRef.current = !!next;
    gesture.suppressUntil = 0;
    setControlsVisible(controlsRef.current);
    if (controlsRef.current) scheduleHide();
  }, [gesture, scheduleHide]);

  const limitsFor = useCallback((nextZoom) => ({
    x: Math.max(0, (displayRef.current.width * nextZoom - layoutRef.current.width) / 2),
    y: Math.max(0, (displayRef.current.height * nextZoom - layoutRef.current.height) / 2),
  }), []);

  const applyTransform = useCallback((nextZoom, x, y) => {
    scale.stopAnimation();
    translateX.stopAnimation();
    translateY.stopAnimation();
    gesture.zoom = nextZoom;
    gesture.x = x;
    gesture.y = y;
    scale.setValue(nextZoom);
    translateX.setValue(x);
    translateY.setValue(y);
  }, [gesture, scale, translateX, translateY]);

  const animateTo = useCallback((nextZoom, x, y) => {
    scale.stopAnimation();
    translateX.stopAnimation();
    translateY.stopAnimation();
    gesture.zoom = nextZoom;
    gesture.x = x;
    gesture.y = y;
    setZoom(nextZoom);
    Animated.parallel([
      Animated.timing(scale, { toValue: nextZoom, duration: 220, useNativeDriver: true }),
      Animated.timing(translateX, { toValue: x, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: y, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [gesture, scale, translateX, translateY]);

  const showFeedback = useCallback((label) => {
    if (feedbackAnim.current) feedbackAnim.current.stopAnimation();
    setSeekFeedback(label);
    feedbackOpacity.setValue(1);
    const animation = Animated.timing(feedbackOpacity, {
      toValue: 0,
      delay: 520,
      duration: 280,
      useNativeDriver: true,
    });
    feedbackAnim.current = animation;
    animation.start(({ finished }) => {
      if (finished && feedbackAnim.current === animation) setSeekFeedback(null);
    });
  }, [feedbackOpacity]);

  const seekTo = useCallback((target) => {
    const next = clamp(target, 0, durationRef.current || 0);
    if (videoRef.current && typeof videoRef.current.seek === 'function') {
      try {
        videoRef.current.seek(next);
        timeRef.current = next;
        setCurrentTime(next);
      } catch (e) {
        setError(true);
      }
    }
    scheduleHide();
  }, [scheduleHide]);

  const seekBy = useCallback((delta) => {
    seekTo(timeRef.current + delta);
    showFeedback(delta < 0 ? '↶ 10' : '10 ↷');
  }, [seekTo, showFeedback]);

  const togglePlay = useCallback(() => {
    setPlaying((value) => !value);
    scheduleHide();
  }, [scheduleHide]);

  const retry = useCallback(() => {
    setError(false);
    setBuffering(true);
    setPlaying(true);
    setCurrentTime(0);
    timeRef.current = 0;
    posterOpacity.stopAnimation();
    posterOpacity.setValue(1);
    setControls(true);
    setVideoKey((key) => key + 1);
  }, [posterOpacity, setControls]);

  const startPinch = useCallback((touches) => {
    if (!touches || touches.length < 2) return;
    const distanceBetween = distance(touches[0], touches[1]) || 1;
    const mid = midpoint(touches[0], touches[1]);
    pinch.current = {
      startDistance: distanceBetween,
      startZoom: gesture.zoom,
      startX: gesture.x,
      startY: gesture.y,
      focusX: mid.x - layoutRef.current.width / 2,
      focusY: mid.y - layoutRef.current.height / 2,
    };
    active.current = null;
    if (singleTimer.current) {
      clearTimeout(singleTimer.current);
      singleTimer.current = null;
    }
    setControls(false);
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
      hideTimerToken.current += 1;
    }
  }, [setControls]);

  api.current = {
    startPinch,
    applyTransform,
    limitsFor,
    seekBy,
    togglePlay,
    scheduleHide,
    setControls,
    animateTo,
    retry,
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
        baseX: gesture.x,
        baseY: gesture.y,
        panStartX: null,
        panStartY: null,
      };
      api.current.scheduleHide();
    },
    onPanResponderMove: (event, state) => {
      const touches = event.nativeEvent.touches || [];
      if (touches.length >= 2) {
        if (!pinch.current) api.current.startPinch(touches);
        const current = pinch.current;
        if (!current) return;
        const nextZoom = clamp(
          current.startZoom * ((distance(touches[0], touches[1]) || 1) / current.startDistance),
          1,
          MAX_SCALE,
        );
        const ratio = nextZoom / current.startZoom;
        const rawX = current.startX + current.focusX * (1 - ratio);
        const rawY = current.startY + current.focusY * (1 - ratio);
        const limits = api.current.limitsFor(nextZoom);
        api.current.applyTransform(
          nextZoom,
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
      if (gesture.zoom > 1.01 && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) current.moved = true;
      else if (Math.abs(dx) > TAP_MOVE || Math.abs(dy) > TAP_MOVE) current.moved = true;
      if (!current.moved || gesture.zoom <= 1.01) return;
      const limits = api.current.limitsFor(gesture.zoom);
      api.current.applyTransform(
        gesture.zoom,
        clamp(current.baseX + dx, -limits.x, limits.x),
        clamp(current.baseY + dy, -limits.y, limits.y),
      );
    },
    onPanResponderRelease: () => {
      if (pinch.current) {
        pinch.current = null;
        const limits = api.current.limitsFor(gesture.zoom);
        api.current.applyTransform(
          gesture.zoom,
          clamp(gesture.x, -limits.x, limits.x),
          clamp(gesture.y, -limits.y, limits.y),
        );
        setZoom(gesture.zoom);
        if (gesture.zoom < 1.05) api.current.animateTo(1, 0, 0);
        return;
      }
      const current = active.current;
      active.current = null;
      if (!current || current.moved || Date.now() < gesture.suppressUntil) return;
      const now = Date.now();
      const x = Number(current.x0) || 0;
      const y = Number(current.y0) || 0;
      const previous = lastTap.current;
      if (now - previous.time < TAP_GAP && Math.abs(x - previous.x) < 48 && Math.abs(y - previous.y) < 48) {
        lastTap.current = { time: 0, x: 0, y: 0 };
        gesture.suppressUntil = now + SUPPRESS_MS;
        const side = x < layoutRef.current.width * 0.38
          ? 'left'
          : x > layoutRef.current.width * 0.62 ? 'right' : 'center';
        if (side === 'left') api.current.seekBy(-SEEK_STEP);
        else if (side === 'right') api.current.seekBy(SEEK_STEP);
        else if (gesture.zoom > 1.01) api.current.animateTo(1, 0, 0);
        return;
      }
      lastTap.current = { time: now, x, y };
      if (singleTimer.current) clearTimeout(singleTimer.current);
      singleTimer.current = setTimeout(() => {
        singleTimer.current = null;
        if (Date.now() < gesture.suppressUntil) return;
        lastTap.current = { time: 0, x: 0, y: 0 };
        api.current.setControls(!controlsRef.current);
      }, TAP_GAP);
    },
    onPanResponderTerminate: () => {
      if (singleTimer.current) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      active.current = null;
      pinch.current = null;
      setZoom(gesture.zoom);
    },
    onPanResponderTerminationRequest: () => false,
  }), [gesture]);

  useEffect(() => {
    scheduleHide();
  }, [playing, controlsVisible, zoom, scheduleHide]);

  useEffect(() => {
    playingRef.current = true;
    setPlaying(true);
    setBuffering(true);
    setDuration(Number(item?.duration) || 0);
    durationRef.current = Number(item?.duration) || 0;
    setCurrentTime(0);
    timeRef.current = 0;
    setRate(1);
    setControlsVisible(true);
    controlsRef.current = true;
    setError(false);
    setZoom(1);
    setSeekFeedback(null);
    setVideoKey(0);
    gesture.zoom = 1;
    gesture.x = 0;
    gesture.y = 0;
    gesture.suppressUntil = 0;
    menuOpenRef.current = false;
    hideTimerToken.current += 1;
    scale.setValue(1);
    translateX.setValue(0);
    translateY.setValue(0);
    posterOpacity.setValue(1);
    feedbackOpacity.setValue(0);
    if (feedbackAnim.current) {
      feedbackAnim.current.stopAnimation();
      feedbackAnim.current = null;
    }
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (singleTimer.current) {
      clearTimeout(singleTimer.current);
      singleTimer.current = null;
    }
    lastTap.current = { time: 0, x: 0, y: 0 };
    pinch.current = null;
    active.current = null;
    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      if (singleTimer.current) {
        clearTimeout(singleTimer.current);
        singleTimer.current = null;
      }
      if (feedbackAnim.current) {
        feedbackAnim.current.stopAnimation();
        feedbackAnim.current = null;
      }
      videoRef.current = null;
      gesture.zoom = 1;
      gesture.x = 0;
      gesture.y = 0;
      scale.setValue(1);
      translateX.setValue(0);
      translateY.setValue(0);
    };
  }, [item?.id, feedbackOpacity, gesture, posterOpacity, scale, translateX, translateY]);

  if (!inline) {
    return (
      <View style={styles.root}>
        <View style={styles.mediaLayer} pointerEvents="none">
          {thumbUri ? (
            <Image source={{ uri: thumbUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
          ) : null}
        </View>
        <View style={styles.topBar} pointerEvents="box-none">
          <TouchableOpacity
            onPress={onClose}
            style={styles.backButton}
            accessibilityLabel="Back"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Icon name="arrow-back" size={fs(26)} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.externalWrap} pointerEvents="box-none">
          <TouchableOpacity
            style={styles.externalButton}
            onPress={() => { if (typeof onExternal === 'function') onExternal(item); }}
          >
            <Icon name="open-outline" size={fs(17)} color="#fff" />
            <Text style={styles.externalText}>Open in video app</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View
      style={styles.root}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setLayout({ width, height });
      }}
    >
      <Animated.View
        style={[
          styles.mediaLayer,
          { transform: [{ translateX }, { translateY }, { scale }] },
        ]}
        pointerEvents="none"
      >
        <Video
          key={videoKey}
          ref={videoRef}
          source={{ uri: mediaUri }}
          style={styles.video}
          resizeMode="contain"
          controls={false}
          paused={!playing}
          rate={rate}
          progressUpdateInterval={200}
          repeat={false}
          playInBackground={false}
          playWhenInactive={false}
          onLoadStart={() => setBuffering(true)}
          onLoad={(data) => {
            const loaded = Number(data && data.duration) || 0;
            if (loaded > 0) {
              durationRef.current = loaded;
              setDuration(loaded);
            }
            setError(false);
            fadePoster();
          }}
          onReadyForDisplay={fadePoster}
          onBuffer={(data) => setBuffering(!!(data && data.isBuffering))}
          onProgress={(data) => {
            const next = Number(data && data.currentTime) || 0;
            timeRef.current = next;
            setCurrentTime(next);
          }}
          onEnd={() => {
            setPlaying(false);
            timeRef.current = 0;
            setCurrentTime(0);
            setControls(true);
            if (videoRef.current && typeof videoRef.current.seek === 'function') videoRef.current.seek(0);
          }}
          onError={() => {
            setError(true);
            setPlaying(false);
            setBuffering(false);
          }}
        />
        {thumbUri ? (
          <Animated.Image
            source={{ uri: thumbUri }}
            style={[StyleSheet.absoluteFill, { opacity: posterOpacity }]}
            resizeMode="contain"
          />
        ) : null}
      </Animated.View>

      <View style={styles.gestureLayer} collapsable={false} {...panHandlers} />

      {buffering && !error && !controlsVisible ? (
        <View style={styles.spinner} pointerEvents="none">
          <ActivityIndicator size="small" color="rgba(255,255,255,0.78)" />
        </View>
      ) : null}

      {error && !controlsVisible ? (
        <View style={styles.errorLayer} pointerEvents="box-none">
          <TouchableOpacity style={styles.errorButton} onPress={retry} accessibilityLabel="Retry">
            <Icon name="refresh-outline" size={fs(18)} color="#fff" />
            <Text style={styles.errorText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <ChatVideoControls
        visible={controlsVisible}
        playing={playing}
        buffering={buffering}
        currentTime={currentTime}
        duration={duration}
        rate={rate}
        error={error}
        onBack={onClose}
        onTogglePlay={togglePlay}
        onSeek={seekTo}
        onRate={(value) => {
          setRate(value);
          scheduleHide();
        }}
        onRetry={retry}
        onMenuVisibilityChange={(open) => {
          menuOpenRef.current = !!open;
          if (hideTimer.current) {
            clearTimeout(hideTimer.current);
            hideTimer.current = null;
            hideTimerToken.current += 1;
          }
          if (!open) scheduleHide();
        }}
      />

      {seekFeedback ? (
        <Animated.View style={[styles.feedback, { opacity: feedbackOpacity }]} pointerEvents="none">
          <Text style={styles.feedbackText}>{seekFeedback}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  mediaLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    zIndex: 1,
  },
  video: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
  },
  gestureLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  },
  spinner: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: fs(24),
    height: fs(24),
    marginTop: -fs(12),
    marginLeft: -fs(12),
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 15,
  },
  errorLayer: {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    alignItems: 'center',
    marginTop: fs(30),
    zIndex: 15,
  },
  errorButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: fs(12),
    paddingVertical: fs(7),
    borderRadius: fs(18),
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  errorText: {
    color: '#fff',
    fontSize: fs(12),
    marginLeft: fs(6),
  },
  feedback: {
    position: 'absolute',
    top: '42%',
    left: '50%',
    marginLeft: -fs(50),
    width: fs(100),
    alignItems: 'center',
    zIndex: 30,
  },
  feedbackText: {
    color: VIDEO_ACCENT,
    fontSize: fs(24),
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: fs(4),
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: fs(112),
    paddingHorizontal: fs(8),
    paddingTop: fs(10),
    zIndex: 20,
  },
  backButton: {
    width: fs(42),
    height: fs(42),
    alignItems: 'center',
    justifyContent: 'center',
  },
  externalWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: fs(34),
    alignItems: 'center',
    zIndex: 20,
  },
  externalButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: fs(16),
    paddingVertical: fs(10),
    borderRadius: fs(22),
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  externalText: {
    color: '#fff',
    fontSize: fs(13),
    fontWeight: '600',
    marginLeft: fs(7),
  },
});
