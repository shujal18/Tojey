import { PanResponder } from 'react-native';
import { useMemo, useRef } from 'react';
import { clamp } from '../components/video/videoConfig';

const TAP_MOVE = 12;
const TAP_TIME = 300;
const DOUBLE_TAP_GAP = 320;
const LONG_PRESS_MS = 450;
const SWIPE_THRESHOLD = 14;

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
  const lastTapRef = useRef({ time: 0, x: 0, y: 0 });
  const lastUiRef = useRef(0);
  const suppressTapRef = useRef(false);

  const clearTimers = () => {
    if (singleTimerRef.current) clearTimeout(singleTimerRef.current);
    if (longTimerRef.current) clearTimeout(longTimerRef.current);
    singleTimerRef.current = null;
    longTimerRef.current = null;
  };

  const endRateHold = () => {
    const active = activeRef.current;
    if (active && active.longPress) callbacks.current.onRateHold && callbacks.current.onRateHold(null);
  };

  const panHandlers = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: (event) => {
      if (!enabled) return false;
      if (suppressTapRef.current) return false;
      return true;
    },
    onMoveShouldSetPanResponder: (event, gesture) => {
      if (!enabled) return false;
      if (touchesOf(event).length >= 2) return true;
      return Math.abs(gesture.dx) > SWIPE_THRESHOLD || Math.abs(gesture.dy) > SWIPE_THRESHOLD;
    },
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponderCapture: () => false,

    onPanResponderGrant: (event, gesture) => {
      if (!enabled) return;
      clearTimers();
      const touches = touchesOf(event);
      if (touches.length >= 2) {
        pinchRef.current = {
          startDistance: distance(touches[0], touches[1]) || 1,
          startZoom: Number((callbacks.current.getZoom && callbacks.current.getZoom()) || 1),
          startedAt: Date.now(),
          moved: false,
        };
        if (callbacks.current.onGestureActive) callbacks.current.onGestureActive(true);
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
        startValue: 0,
        startTime: 0,
        committed: false,
      };
      if (callbacks.current.onGestureActive) callbacks.current.onGestureActive(true);
      longTimerRef.current = setTimeout(() => {
        const active = activeRef.current;
        if (!active || active.moved || active.mode || pinchRef.current) return;
        active.longPress = true;
        if (callbacks.current.onRateHold) callbacks.current.onRateHold(2);
      }, LONG_PRESS_MS);
    },

    onPanResponderMove: (event, gesture) => {
      const touches = touchesOf(event);
      if (pinchRef.current && touches.length >= 2) {
        const pinch = pinchRef.current;
        const scale = (distance(touches[0], touches[1]) || 1) / pinch.startDistance;
        if (Math.abs(scale - 1) > 0.04) pinch.moved = true;
        if (callbacks.current.onZoomChange) callbacks.current.onZoomChange(clamp(pinch.startZoom * scale, 1, 3));
        return;
      }

      const active = activeRef.current;
      if (!active) return;
      const dx = Number(gesture.dx) || 0;
      const dy = Number(gesture.dy) || 0;
      if (Math.abs(dx) > TAP_MOVE || Math.abs(dy) > TAP_MOVE) {
        active.moved = true;
        if (longTimerRef.current) clearTimeout(longTimerRef.current);
      }

      if (!active.mode && active.moved) {
        if (active.y < 64 && dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.4 && callbacks.current.onMinimize) {
          active.mode = 'minimize';
        } else if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.25) {
          active.mode = 'seek';
          active.startTime = Number((callbacks.current.getCurrentTime && callbacks.current.getCurrentTime()) || 0);
        } else if (Math.abs(dy) > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx) * 1.25) {
          active.mode = active.x < callbacks.current.width / 2 ? 'brightness' : 'volume';
          active.startValue = Number((active.mode === 'brightness'
            ? callbacks.current.getBrightness && callbacks.current.getBrightness()
            : callbacks.current.getVolume && callbacks.current.getVolume()) || 0);
        }
      }

      if (active.mode === 'minimize' && !active.minimizeDone) {
        active.minimizeDone = true;
        callbacks.current.onMinimize && callbacks.current.onMinimize();
        return;
      }

      if (!active.mode || active.longPress) return;
      const now = Date.now();
      const throttled = now - lastUiRef.current < 60;

      if (active.mode === 'seek') {
        if (throttled) return;
        lastUiRef.current = now;
        const duration = Number((callbacks.current.getDuration && callbacks.current.getDuration()) || 0);
        const windowSeconds = clamp(duration * 0.12, 30, 180);
        const target = clamp(active.startTime + (dx / (callbacks.current.width || 1)) * windowSeconds, 0, duration || Number.MAX_SAFE_INTEGER);
        callbacks.current.onSeekPreview && callbacks.current.onSeekPreview({ target, delta: target - active.startTime });
        return;
      }

      if (throttled) return;
      lastUiRef.current = now;

      if (active.mode === 'volume') {
        const next = clamp(active.startValue + (-dy / (callbacks.current.height || 1)) * 1.4, 0, 1);
        callbacks.current.onVolumeChange && callbacks.current.onVolumeChange(next);
      } else if (active.mode === 'brightness') {
        const next = clamp(active.startValue + (-dy / (callbacks.current.height || 1)) * 1.4, 0.01, 1);
        callbacks.current.onBrightnessChange && callbacks.current.onBrightnessChange(next);
      }
    },

    onPanResponderRelease: (event, gesture) => {
      clearTimers();
      if (pinchRef.current) {
        const pinch = pinchRef.current;
        pinchRef.current = null;
        suppressTapRef.current = true;
        setTimeout(() => { suppressTapRef.current = false; }, 260);
        if (!pinch.moved && Date.now() - pinch.startedAt < 320 && callbacks.current.onResetZoom) callbacks.current.onResetZoom();
        if (callbacks.current.onGestureActive) callbacks.current.onGestureActive(false);
        return;
      }

      const active = activeRef.current;
      activeRef.current = null;
      if (!active) return;
      endRateHold();
      if (callbacks.current.onGestureActive) callbacks.current.onGestureActive(false);

      if (active.mode === 'seek') {
        const duration = Number((callbacks.current.getDuration && callbacks.current.getDuration()) || 0);
        const windowSeconds = clamp(duration * 0.12, 30, 180);
        const target = clamp(active.startTime + (gesture.dx / (callbacks.current.width || 1)) * windowSeconds, 0, duration || Number.MAX_SAFE_INTEGER);
        if (Math.abs(gesture.dx) > SWIPE_THRESHOLD && callbacks.current.onSeekCommit) callbacks.current.onSeekCommit(target);
        if (callbacks.current.onSeekPreview) callbacks.current.onSeekPreview(null);
        return;
      }

      if (active.moved || active.longPress || active.mode === 'minimize') return;
      const x = Number(gesture.x0) || 0;
      const y = Number(gesture.y0) || 0;
      const now = Date.now();
      const last = lastTapRef.current;
      if (now - last.time < DOUBLE_TAP_GAP && Math.abs(x - last.x) < 48 && Math.abs(y - last.y) < 48) {
        lastTapRef.current = { time: 0, x: 0, y: 0 };
        const side = x < callbacks.current.width * 0.34 ? 'left' : x > callbacks.current.width * 0.66 ? 'right' : 'center';
        if (callbacks.current.onDoubleTap) callbacks.current.onDoubleTap(side);
        return;
      }
      lastTapRef.current = { time: now, x, y };
      singleTimerRef.current = setTimeout(() => {
        if (!suppressTapRef.current && callbacks.current.onSingleTap) callbacks.current.onSingleTap();
        lastTapRef.current = { time: 0, x: 0, y: 0 };
      }, TAP_TIME);
    },

    onPanResponderTerminate: () => {
      clearTimers();
      endRateHold();
      const active = activeRef.current;
      if (active && active.mode === 'seek' && callbacks.current.onSeekPreview) callbacks.current.onSeekPreview(null);
      pinchRef.current = null;
      activeRef.current = null;
      if (callbacks.current.onGestureActive) callbacks.current.onGestureActive(false);
    },

    onPanResponderTerminationRequest: () => true,
  }), [enabled]);

  return panHandlers;
}
