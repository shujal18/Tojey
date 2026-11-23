import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from '../components/video/videoConfig';
import useVideoAutoHide from './useVideoAutoHide';

const INITIAL_STATE = {
  playing: true,
  currentTime: 0,
  duration: 0,
  buffered: 0,
  muted: false,
  volume: 1,
  playbackRate: 1,
  quality: 'Auto',
  subtitleTrack: -1,
  audioTrack: 0,
  resizeMode: 'Fit',
  zoom: 1,
  fullscreen: false,
  locked: false,
  controlsVisible: true,
  buffering: false,
  error: null,
  repeat: false,
  backgroundPlayback: false,
  autoPip: false,
  rotationLock: false,
  audioTracks: [],
  textTracks: [],
};

export default function useVideoControls({
  sourceKey,
  contentKey = sourceKey,
  fullscreen,
  initialTime = 0,
  initialRate = 1,
  initialMuted = false,
  initialVolume = 1,
  initialResizeMode = 'Fit',
  initialRepeat = false,
  watchTogetherRole = null,
  watchTogetherSessionId = null,
  externalRate = null,
  videoRef,
  onPlayChange,
  onTimeUpdate,
  onSeek,
  onRateChange,
  onError,
  onFullscreenChange,
}) {
  const [state, setState] = useState(() => ({
    ...INITIAL_STATE,
    playing: true,
    currentTime: Number(initialTime) || 0,
    muted: !!initialMuted,
    volume: clamp(initialVolume, 0, 1),
    playbackRate: initialRate || 1,
    resizeMode: initialResizeMode || 'Fit',
    repeat: !!initialRepeat,
  }));
  const [holdCount, setHoldCount] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const timeRef = useRef(Number(initialTime) || 0);
  const durationRef = useRef(0);
  const bufferedRef = useRef(0);
  const playingRef = useRef(true);
  const mutedRef = useRef(!!initialMuted);
  const volumeRef = useRef(clamp(initialVolume, 0, 1));
  const rateRef = useRef(initialRate || 1);
  const zoomRef = useRef(1);
  const lastProgressRef = useRef(Date.now());
  const lastUiRef = useRef(0);
  const lastReportedTimeRef = useRef(Number(initialTime) || 0);
  const guestSessionRef = useRef(null);
  const contentKeyRef = useRef(contentKey);
  const onPlayChangeRef = useRef(onPlayChange);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const onSeekRef = useRef(onSeek);
  const onRateChangeRef = useRef(onRateChange);
  const onErrorRef = useRef(onError);
  const onFullscreenChangeRef = useRef(onFullscreenChange);

  onPlayChangeRef.current = onPlayChange;
  onTimeUpdateRef.current = onTimeUpdate;
  onSeekRef.current = onSeek;
  onRateChangeRef.current = onRateChange;
  onErrorRef.current = onError;
  onFullscreenChangeRef.current = onFullscreenChange;

  const patch = useCallback((next) => {
    setState((prev) => ({ ...prev, ...(typeof next === 'function' ? next(prev) : next) }));
  }, []);

  const setControlsVisible = useCallback((value) => {
    patch({ controlsVisible: !!value });
  }, [patch]);

  const wakeControls = useVideoAutoHide({
    playing: state.playing,
    controlsVisible: state.controlsVisible,
    setControlsVisible,
    disabled: holdCount > 0,
  });

  const holdControls = useCallback(() => setHoldCount((value) => value + 1), []);
  const releaseControls = useCallback(() => setHoldCount((value) => Math.max(0, value - 1)), []);

  const publishTime = useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastUiRef.current < 300) return;
    lastUiRef.current = now;
    patch({
      currentTime: timeRef.current,
      buffered: bufferedRef.current,
      duration: durationRef.current,
    });
    if (typeof onTimeUpdateRef.current === 'function') {
      onTimeUpdateRef.current({
        currentTime: timeRef.current,
        duration: durationRef.current,
        buffered: bufferedRef.current,
      });
    }
  }, [patch]);

  const markProgress = useCallback(() => {
    lastProgressRef.current = Date.now();
  }, []);

  const updateProgress = useCallback((currentTime, buffered) => {
    const t = Math.max(0, Number(currentTime) || 0);
    const b = Math.max(0, Number(buffered) || 0);
    timeRef.current = t;
    bufferedRef.current = b;
    if (t > lastReportedTimeRef.current + 0.05) {
      lastReportedTimeRef.current = t;
      lastProgressRef.current = Date.now();
    }
    publishTime(false);
  }, [publishTime]);

  const setDuration = useCallback((duration) => {
    const d = Math.max(0, Number(duration) || 0);
    durationRef.current = d;
    patch({ duration: d });
    publishTime(true);
  }, [patch, publishTime]);

  const setPlaying = useCallback((value, options = {}) => {
    const next = !!value;
    playingRef.current = next;
    lastProgressRef.current = Date.now();
    patch({ playing: next });
    if (!options.silent && typeof onPlayChangeRef.current === 'function') onPlayChangeRef.current(next);
  }, [patch]);

  const play = useCallback((options) => setPlaying(true, options), [setPlaying]);
  const pause = useCallback((options) => setPlaying(false, options), [setPlaying]);
  const togglePlay = useCallback((options) => setPlaying(!playingRef.current, options), [setPlaying]);

  const seek = useCallback((raw, options = {}) => {
    const max = durationRef.current || Number.MAX_SAFE_INTEGER;
    const target = clamp(raw, 0, max);
    try {
      if (videoRef && videoRef.current && typeof videoRef.current.seek === 'function') videoRef.current.seek(target);
    } catch (e) {}
    timeRef.current = target;
    lastReportedTimeRef.current = target;
    lastProgressRef.current = Date.now();
    patch({ currentTime: target });
    if (!options.silent && typeof onSeekRef.current === 'function') onSeekRef.current(target);
  }, [patch, videoRef]);

  const nudge = useCallback((seconds) => seek(timeRef.current + Number(seconds || 0)), [seek]);

  const setRate = useCallback((raw, options = {}) => {
    const next = clamp(raw, 0.25, 2);
    rateRef.current = next;
    patch({ playbackRate: next });
    if (!options.silent && typeof onRateChangeRef.current === 'function') onRateChangeRef.current(next);
  }, [patch]);

  const setMuted = useCallback((value) => {
    const next = !!value;
    mutedRef.current = next;
    patch({ muted: next });
  }, [patch]);

  const toggleMuted = useCallback(() => setMuted(!mutedRef.current), [setMuted]);

  const setVolume = useCallback((raw) => {
    const next = clamp(raw, 0, 1);
    volumeRef.current = next;
    mutedRef.current = next === 0;
    patch({ volume: next, muted: mutedRef.current });
  }, [patch]);

  const setBuffering = useCallback((value) => patch({ buffering: !!value }), [patch]);
  const setError = useCallback((value) => patch({ error: value || null }), [patch]);
  const clearError = useCallback(() => patch({ error: null, buffering: false }), [patch]);

  const handleError = useCallback((error) => {
    patch({ error: error || 'Unable to play this video.', buffering: false });
    if (typeof onErrorRef.current === 'function') onErrorRef.current(error);
  }, [patch]);

  const setTracks = useCallback((audioTracks, textTracks) => {
    patch({
      audioTracks: Array.isArray(audioTracks) ? audioTracks : [],
      textTracks: Array.isArray(textTracks) ? textTracks : [],
    });
  }, [patch]);

  const setSubtitleTrack = useCallback((value) => patch({ subtitleTrack: Number(value) || -1 }), [patch]);
  const setAudioTrack = useCallback((value) => patch({ audioTrack: Math.max(0, Number(value) || 0) }), [patch]);
  const setQuality = useCallback((value) => patch({ quality: value || 'Auto' }), [patch]);
  const setResizeMode = useCallback((value) => patch({ resizeMode: value || 'Fit' }), [patch]);

  const setZoom = useCallback((raw) => {
    const next = clamp(raw, 1, 3);
    zoomRef.current = next;
    patch({ zoom: next });
  }, [patch]);

  const resetZoom = useCallback(() => setZoom(1), [setZoom]);

  const setFullscreen = useCallback((value) => {
    const next = !!value;
    if (typeof fullscreen === 'boolean') {
      if (typeof onFullscreenChangeRef.current === 'function') onFullscreenChangeRef.current(next);
      return;
    }
    patch({ fullscreen: next });
    if (typeof onFullscreenChangeRef.current === 'function') onFullscreenChangeRef.current(next);
  }, [fullscreen, patch]);

  const toggleFullscreen = useCallback(() => setFullscreen(!stateRef.current.fullscreen), [setFullscreen]);

  const setLocked = useCallback((value) => patch({ locked: !!value }), [patch]);
  const setRepeat = useCallback((value) => patch({ repeat: !!value }), [patch]);
  const setBackgroundPlayback = useCallback((value) => patch({ backgroundPlayback: !!value }), [patch]);
  const setAutoPip = useCallback((value) => patch({ autoPip: !!value }), [patch]);
  const setRotationLock = useCallback((value) => patch({ rotationLock: !!value }), [patch]);

  const getState = useCallback(() => ({
    ...stateRef.current,
    currentTime: timeRef.current,
    duration: durationRef.current,
    buffered: bufferedRef.current,
    playing: playingRef.current,
    muted: mutedRef.current,
    volume: volumeRef.current,
    playbackRate: rateRef.current,
    zoom: zoomRef.current,
  }), []);

  useEffect(() => {
    if (typeof fullscreen !== 'boolean' || stateRef.current.fullscreen === !!fullscreen) return;
    patch({ fullscreen: !!fullscreen });
  }, [fullscreen, patch]);

  useEffect(() => {
    if (contentKeyRef.current === contentKey) return;
    contentKeyRef.current = contentKey;
    timeRef.current = Number(initialTime) || 0;
    durationRef.current = 0;
    bufferedRef.current = 0;
    lastReportedTimeRef.current = timeRef.current;
    lastProgressRef.current = Date.now();
    lastUiRef.current = 0;
    patch({
      currentTime: timeRef.current,
      duration: 0,
      buffered: 0,
      buffering: false,
      error: null,
      controlsVisible: true,
      zoom: 1,
      subtitleTrack: -1,
      audioTrack: 0,
    });
    zoomRef.current = 1;
    if (watchTogetherRole !== 'guest') {
      mutedRef.current = false;
      volumeRef.current = 1;
      patch({ muted: false, volume: 1 });
    }
    publishTime(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);

  useEffect(() => {
    if (watchTogetherRole === 'guest' && watchTogetherSessionId && guestSessionRef.current !== watchTogetherSessionId) {
      guestSessionRef.current = watchTogetherSessionId;
      mutedRef.current = false;
      volumeRef.current = 1;
      patch({ muted: false, volume: 1 });
    }
    if (!watchTogetherRole || !watchTogetherSessionId) guestSessionRef.current = null;
  }, [watchTogetherRole, watchTogetherSessionId, patch]);

  useEffect(() => {
    if (typeof externalRate !== 'number' || !Number.isFinite(externalRate)) return;
    const next = clamp(externalRate, 0.25, 2);
    if (rateRef.current === next) return;
    rateRef.current = next;
    patch({ playbackRate: next });
  }, [externalRate, patch]);

  return {
    state,
    lastProgressRef,
    setControlsVisible,
    wakeControls,
    holdControls,
    releaseControls,
    markProgress,
    updateProgress,
    setDuration,
    play,
    pause,
    togglePlay,
    seek,
    nudge,
    setRate,
    setMuted,
    toggleMuted,
    setVolume,
    setBuffering,
    setError,
    clearError,
    handleError,
    setTracks,
    setSubtitleTrack,
    setAudioTrack,
    setQuality,
    setResizeMode,
    setZoom,
    resetZoom,
    setFullscreen,
    toggleFullscreen,
    setLocked,
    setRepeat,
    setBackgroundPlayback,
    setAutoPip,
    setRotationLock,
    getState,
  };
}
