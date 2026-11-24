import { PanResponder } from 'react-native';
import { useEffect, useMemo, useRef } from 'react';
import { clamp, seekWindowFor } from '../components/video/videoConfig';

const TAP_MOVE = 11;
const TAP_TIME = 360;
const DOUBLE_TAP_GAP = 320;
const LONG_PRESS_MS = 420;
const SWIPE_THRESHOLD = 14;
const AXIS_RATIO = 1.25;
const UI_THROTTLE_MS = 60;
const SUPPRESS_TAP_MS = 300;

function distance(a, b) {
  const dx = Number(a.pageX) - Number(b.pageX);
  const dy = Number(a.pageY) - Number(b.pageY);
  return Math.sqrt(dx * dx + dy * dy);
}

function touchesOf(event) {
  const touches = event && event.nativeEvent && event.nativeEvent.touches;
  return Array.isArray(touches) ? touches : [];
}

export default function useVideoGestures({
  enabled = true,
  width = 1,
  height = 1,
  getDuration,
  getCurrentTime,
  getVolume,
  getBrightness,
  getZoom,
  onTapStart,
  onSingleTap,
  onDoubleTap,
  onSeekPreview,
  onSeekCommit,
  onVolumeChange,
  onBrightnessChange,
  onRateHold,
  onZoomChange,
  onResetZoom,
  onMinimize,
  onGestureActive,
}) {
  const callbacks = useRef({});
  callbacks.current = {
    width,
    height,
    getDuration,
    getCurrentTime,
    getVolume,
    getBrightness,
    getZoom,
    onTapStart,
    onSingleTap,
    onDoubleTap,
    onSeekPreview,
    onSeekCommit,
    onVolumeChange,
    onBrightnessChange,
    onRateHold,
    onZoomChange,
    onResetZoom,
    onMinimize,
    onGestureActive,
  };

  const activeRef = useRef(null);
  const pinchRef = useRef(null);
  const singleTimerRef = useRef(null);
  const longTimerRef = useRef(null);
  const suppressTimerRef = useRef(null);
  const lastTapRef = useRef({ time: 0, x: 0, y: 0 });
  const lastUiRef = useRef(0);
  const suppressTapRef = useRef(false);
  const longPressActiveRef = useRef(false);
  const gestureActiveRef = useRef(false);

  const clearTimers = () => {
    if (singleTimerRef.current) clearTimeout(singleTimerRef.current);
    if (longTimerRef.current) clearTimeout(longTimerRef.current);
    singleTimerRef.current = null;
    longTimerRef.current = null;
  };

  const clearSuppress = () => {
    if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = null;
    suppressTapRef.current = false;
  };

  const setGestureActive = (value) => {
    const next = !!value;
    if (gestureActiveRef.current === next) return;
    gestureActiveRef.current = next;
    const active = activeRef.current;
    if (active) active.notified = next;
    if (callbacks.current.onGestureActive) callbacks.current.onGestureActive(next);
  };

  const startPinch = (touches) => {
    if (activeRef.current) {
      clearTimers();
      activeRef.current = null;
    }
    if (pinchRef.current) return;
    pinchRef.current = {
      startDistance: distance(touches[0], touches[1]) || 1,
      startZoom: Number((callbacks.current.getZoom && callbacks.current.getZoom()) || 1),
      startedAt: Date.now(),
      moved: false,
    };
    setGestureActive(true);
  };

  const endRateHold = () => {
    if (!longPressActiveRef.current) return;
    longPressActiveRef.current = false;
    if (callbacks.current.onRateHold) callbacks.current.onRateHold(null);
  };

  useEffect(() => () => {
    clearTimers();
    clearSuppress();
    endRateHold();
    if (callbacks.current.onSeekPreview) callbacks.current.onSeekPreview(null);
    setGestureActive(false);
  }, []);

  const panHandlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !!enabled,
    onMoveShouldSetPanResponder: () => !!enabled,
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponderCapture: () => false,

    onPanResponderGrant: (event, gesture) => {
      if (!enabled) return;
      clearTimers();
      clearSuppress();
      const touches = touchesOf(event);
      if (touches.length >= 2) {
        startPinch(touches);
        return;
      }
      activeRef.current = {
        x: gesture.x0,
        y: gesture.y0,
        startedAt: Date.now(),
        mode: null,
        moved: false,
        longPress: false,
        minimizeDone: false,
        notified: false,
        startValue: 0,
        startTime: 0,
      };
      if (callbacks.current.onTapStart) {
        callbacks.current.onTapStart(Number(gesture.x0) || 0, Number(gesture.y0) || 0);
      }
      longTimerRef.current = setTimeout(() => {
        const active = activeRef.current;
        if (!active || active.moved || active.mode || pinchRef.current) return;
        if (!callbacks.current.onRateHold) return;
        active.longPress = true;
        longPressActiveRef.current = true;
        if (!gestureActiveRef.current) setGestureActive(true);
        callbacks.current.onRateHold(2);
      }, LONG_PRESS_MS);
    },

    onPanResponderMove: (event, gesture) => {
      const touches = touchesOf(event);
      if (touches.length >= 2) {
        if (!pinchRef.current) startPinch(touches);
        if (!pinchRef.current) return;
        const now = Date.now();
        if (now - lastUiRef.current < UI_THROTTLE_MS) return;
        lastUiRef.current = now;
        const pinch = pinchRef.current;
        const scale = (distance(touches[0], touches[1]) || 1) / pinch.startDistance;
        if (Math.abs(scale - 1) > 0.04) pinch.moved = true;
        if (callbacks.current.onZoomChange) {
          callbacks.current.onZoomChange(clamp(pinch.startZoom * scale, 1, 3));
        }
        return;
      }

      const active = activeRef.current;
      if (!active || active.longPress) return;
      const dx = Number(gesture.dx) || 0;
      const dy = Number(gesture.dy) || 0;
      if (Math.abs(dx) > TAP_MOVE || Math.abs(dy) > TAP_MOVE) {
        active.moved = true;
        if (longTimerRef.current) clearTimeout(longTimerRef.current);
        longTimerRef.current = null;
      }

      if (!active.mode && active.moved) {
        if (active.y < 64 && dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.4 && callbacks.current.onMinimize) {
          active.mode = 'minimize';
        } else if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO && callbacks.current.onSeekCommit) {
          active.mode = 'seek';
          active.startTime = Number((callbacks.current.getCurrentTime && callbacks.current.getCurrentTime()) || 0);
        } else if (Math.abs(dy) > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx) * AXIS_RATIO) {
          active.mode = active.x < callbacks.current.width / 2 ? 'brightness' : 'volume';
          active.startValue = Number((active.mode === 'brightness'
            ? callbacks.current.getBrightness && callbacks.current.getBrightness()
            : callbacks.current.getVolume && callbacks.current.getVolume()) || 0);
        }
        if (active.mode && !gestureActiveRef.current) setGestureActive(true);
      }

      if (active.mode === 'minimize' && !active.minimizeDone) {
        active.minimizeDone = true;
        if (callbacks.current.onMinimize) callbacks.current.onMinimize();
        return;
      }

      if (!active.mode) return;
      const now = Date.now();
      if (now - lastUiRef.current < UI_THROTTLE_MS) return;
      lastUiRef.current = now;

      if (active.mode === 'seek') {
        const duration = Number((callbacks.current.getDuration && callbacks.current.getDuration()) || 0);
        if (duration <= 0) return;
        const target = clamp(
          active.startTime + (dx / (callbacks.current.width || 1)) * seekWindowFor(duration),
          0,
          duration,
        );
        if (callbacks.current.onSeekPreview) callbacks.current.onSeekPreview({ target, delta: target - active.startTime });
        return;
      }

      if (active.mode === 'volume') {
        const next = clamp(active.startValue + (-dy / (callbacks.current.height || 1)) * 1.4, 0, 1);
        if (callbacks.current.onVolumeChange) callbacks.current.onVolumeChange(next);
      } else if (active.mode === 'brightness') {
        const next = clamp(active.startValue + (-dy / (callbacks.current.height || 1)) * 1.4, 0.01, 1);
        if (callbacks.current.onBrightnessChange) callbacks.current.onBrightnessChange(next);
      }
    },

    onPanResponderRelease: (event, gesture) => {
      clearTimers();
      if (pinchRef.current) {
        const pinch = pinchRef.current;
        pinchRef.current = null;
        suppressTapRef.current = true;
        if (suppressTimerRef.current) clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = setTimeout(() => {
          suppressTapRef.current = false;
          suppressTimerRef.current = null;
        }, SUPPRESS_TAP_MS);
        if (!pinch.moved && Date.now() - pinch.startedAt < 320 && callbacks.current.onResetZoom) {
          callbacks.current.onResetZoom();
        }
        setGestureActive(false);
        return;
      }

      const active = activeRef.current;
      activeRef.current = null;
      if (gestureActiveRef.current) setGestureActive(false);
      if (!active) return;
      endRateHold();
      if (active.longPress) return;

      if (active.mode === 'seek') {
        const duration = Number((callbacks.current.getDuration && callbacks.current.getDuration()) || 0);
        if (duration > 0 && Math.abs(gesture.dx) > SWIPE_THRESHOLD && callbacks.current.onSeekCommit) {
          const target = clamp(
            active.startTime + (gesture.dx / (callbacks.current.width || 1)) * seekWindowFor(duration),
            0,
            duration,
          );
          callbacks.current.onSeekCommit(target);
        }
        if (callbacks.current.onSeekPreview) callbacks.current.onSeekPreview(null);
        return;
      }

      if (active.mode || active.moved) return;

      const x = Number(gesture.x0) || 0;
      const y = Number(gesture.y0) || 0;
      const now = Date.now();
      const last = lastTapRef.current;
      if (callbacks.current.onDoubleTap && now - last.time < DOUBLE_TAP_GAP &&
          Math.abs(x - last.x) < 48 && Math.abs(y - last.y) < 48) {
        lastTapRef.current = { time: 0, x: 0, y: 0 };
        const side = x < callbacks.current.width * 0.38
          ? 'left'
          : x > callbacks.current.width * 0.62 ? 'right' : 'center';
        if (callbacks.current.onDoubleTap) callbacks.current.onDoubleTap(side);
        return;
      }
      lastTapRef.current = { time: now, x, y };
      singleTimerRef.current = setTimeout(() => {
        if (!suppressTapRef.current && callbacks.current.onSingleTap) callbacks.current.onSingleTap();
        lastTapRef.current = { time: 0, x: 0, y: 0 };
        singleTimerRef.current = null;
      }, TAP_TIME);
    },

    onPanResponderTerminate: () => {
      clearTimers();
      endRateHold();
      const active = activeRef.current;
      if (active && active.mode === 'seek' && callbacks.current.onSeekPreview) callbacks.current.onSeekPreview(null);
      pinchRef.current = null;
      activeRef.current = null;
      setGestureActive(false);
    },

    onPanResponderTerminationRequest: () => true,
  }), [enabled]);

  return panHandlers;
}
