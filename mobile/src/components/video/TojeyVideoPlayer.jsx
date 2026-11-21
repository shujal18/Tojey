import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  AppState,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Video from 'react-native-video';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { aspectForResize, clamp, resizeModeFor } from './videoConfig';
import useVideoControls from '../../hooks/useVideoControls';
import useVideoGestures from '../../hooks/useVideoGestures';
import useVideoRecovery from '../../hooks/useVideoRecovery';
import { enterPip, onPipAction, pipSupported } from '../../services/pip';
import { lockOrientation, unlockOrientation } from '../../services/orientation';
import { resetWindowBrightness, setWindowBrightness } from '../../services/brightness';
import TojeyVideoControls from './TojeyVideoControls';
import VideoGestureLayer from './VideoGestureLayer';
import VideoSettingsSheet from './VideoSettingsSheet';
import VideoStatusOverlay from './VideoStatusOverlay';
import VideoVolumeOverlay from './VideoVolumeOverlay';
import VideoBrightnessOverlay from './VideoBrightnessOverlay';
import VideoSeekOverlay from './VideoSeekOverlay';
import VideoLockOverlay from './VideoLockOverlay';
import VideoMiniPlayer from './VideoMiniPlayer';

const VideoSurface = memo(function VideoSurface({
  sourceUri,
  sourceType,
  paused,
  muted,
  volume,
  rate,
  resizeMode,
  zoom,
  repeat,
  backgroundPlayback,
  audioTrack,
  subtitleTrack,
  onLoad,
  onProgress,
  onBuffer,
  onError,
  onAudioTracks,
  onTextTracks,
  onEnd,
}) {
  const aspect = aspectForResize(resizeMode);
  return (
    <View style={[styles.surfaceFrame, aspect ? { aspectRatio: aspect } : null]}>
      <Animated.View style={[styles.surfaceFill, { transform: [{ scale: zoom }] }]}>
        <Video
          source={{ uri: sourceUri, type: sourceType }}
          style={styles.surfaceFill}
          paused={paused}
          muted={muted}
          volume={volume}
          rate={rate}
          resizeMode={resizeModeFor(resizeMode)}
          controls={false}
          repeat={repeat}
          playInBackground={backgroundPlayback}
          ignoreSilentSwitch="ignore"
          mixWithOthers="inherit"
          selectedAudioTrack={{ type: 'index', value: audioTrack }}
          selectedTextTrack={subtitleTrack >= 0 ? { type: 'index', value: subtitleTrack } : { type: 'disabled' }}
          onLoad={onLoad}
          onProgress={onProgress}
          onBuffer={onBuffer}
          onError={onError}
          onAudioTracks={onAudioTracks}
          onTextTracks={onTextTracks}
          onEnd={onEnd}
        />
      </Animated.View>
    </View>
  );
});

const TojeyVideoPlayer = forwardRef(function TojeyVideoPlayer({
  source,
  title,
  style,
  mode = 'full',
  initialTime = 0,
  initialRate = 1,
  initialMuted = false,
  initialVolume = 1,
  initialResizeMode = 'Fit',
  initialRepeat = false,
  showControls = true,
  enableGestures = true,
  watchTogetherRole = null,
  watchTogetherSessionId = null,
  sharedRate = null,
  reconnecting = false,
  loading = false,
  onLoad,
  onEnd,
  statusLabel,
  error,
  pipSupported: pipAllowed = true,
  availableQualities = ['Auto'],
  sourceAspect = 16 / 9,
  onPlayChange,
  onTimeUpdate,
  onSeek,
  onRateChange,
  onError,
  onRetry,
  onBack,
  onMinimize,
  onQualityChange,
  onFullscreenChange,
}, ref) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const videoRef = useRef(null);
  const sourceUri = source && source.uri ? String(source.uri) : '';
  const sourceType = source && source.type ? String(source.type) : undefined;
  const sourceKey = `${sourceUri}|${sourceType || ''}`;
  const guest = watchTogetherRole === 'guest';
  const watchTogether = !!watchTogetherRole;
  const compact = mode === 'reels';
  const mini = mode === 'mini';
  const restoreTimeRef = useRef(Number(initialTime) || 0);
  const brightnessRef = useRef(0.8);
  const tempRateRef = useRef(null);
  const [pipActive, setPipActive] = useState(false);
  const [pipOk, setPipOk] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gestureActive, setGestureActive] = useState(false);
  const [seekPreview, setSeekPreview] = useState(null);
  const [volumeOverlay, setVolumeOverlay] = useState(null);
  const [brightnessOverlay, setBrightnessOverlay] = useState(null);
  const [rateHold, setRateHold] = useState(false);
  const [layout, setLayout] = useState({ width: windowWidth, height: Math.round(windowWidth * 9 / 16) });

  const controls = useVideoControls({
    sourceKey: sourceUri ? sourceKey : null,
    initialTime,
    initialRate,
    initialMuted,
    initialVolume,
    initialResizeMode,
    initialRepeat,
    watchTogetherRole,
    watchTogetherSessionId,
    externalRate: sharedRate,
    videoRef,
    onPlayChange,
    onTimeUpdate,
    onSeek,
    onRateChange,
    onError,
    onFullscreenChange,
  });

  const {
    state,
    lastProgressRef,
    wakeControls,
    holdControls,
    releaseControls,
    updateProgress,
    setDuration,
    play,
    pause,
    togglePlay,
    seek,
    nudge,
    setRate,
    toggleMuted,
    setVolume,
    setBuffering,
    clearError,
    handleError,
    setTracks,
    setSubtitleTrack,
    setAudioTrack,
    setQuality,
    setResizeMode,
    setZoom,
    resetZoom,
    toggleFullscreen,
    setLocked,
    setRepeat,
    setBackgroundPlayback,
    setAutoPip,
    setRotationLock,
    getState,
  } = controls;

  useVideoRecovery({
    enabled: !!sourceUri && !loading && !error && state.playing && !guest && !mini && !compact,
    lastProgressRef,
    onRecover: () => { if (typeof onRetry === 'function') onRetry(); },
  });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => pipSupported())
      .then((ok) => { if (!cancelled) setPipOk(!!ok && pipAllowed); })
      .catch(() => { if (!cancelled) setPipOk(false); });
    return () => { cancelled = true; };
  }, [pipAllowed]);

  useEffect(() => {
    if (!sourceUri) return undefined;
    restoreTimeRef.current = Number(initialTime) || 0;
    return undefined;
  }, [sourceKey, initialTime]);

  useEffect(() => {
    if (settingsOpen) {
      holdControls();
      return releaseControls;
    }
    return undefined;
  }, [settingsOpen, holdControls, releaseControls]);

  useEffect(() => {
    if (gestureActive) {
      holdControls();
      return releaseControls;
    }
    return undefined;
  }, [gestureActive, holdControls, releaseControls]);

  useEffect(() => {
    if (state.fullscreen) StatusBar.setHidden(true, 'fade');
    else StatusBar.setHidden(false, 'fade');
    return () => StatusBar.setHidden(false, 'none');
  }, [state.fullscreen]);

  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      if (compact || mini) return;
      if (state.fullscreen) {
        if (state.rotationLock) {
          await lockOrientation(windowWidth >= windowHeight ? 'landscape' : 'portrait');
        } else if (sourceAspect >= 1.2) {
          await lockOrientation('landscape');
        } else {
          await unlockOrientation();
        }
      } else if (state.rotationLock) {
        await lockOrientation('portrait');
      } else {
        await unlockOrientation();
      }
    };
    if (!cancelled) apply();
    return () => { cancelled = true; };
  }, [state.fullscreen, state.rotationLock, sourceAspect, windowWidth, windowHeight, compact, mini]);

  useEffect(() => () => { resetWindowBrightness(); }, []);

  useEffect(() => {
    if (!state.fullscreen) resetWindowBrightness();
  }, [state.fullscreen]);

  const togglePip = useCallback(async () => {
    if (!pipOk) return;
    const ok = await enterPip(16, 9, state.playing);
    if (ok) setPipActive(true);
  }, [pipOk, state.playing]);

  useEffect(() => onPipAction((action) => {
    if (!action || guest) return;
    if (action === 'play') play();
    else if (action === 'pause') pause();
  }), [guest, pause, play]);

  useEffect(() => {
    const listener = (nextState) => {
      if (nextState === 'background' && state.autoPip && state.playing && pipOk && !mini && !compact) togglePip();
    };
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
  }, [state.autoPip, state.playing, pipOk, togglePip, mini, compact]);

  const handleLoad = useCallback((meta) => {
    if (meta && meta.duration) setDuration(meta.duration);
    setBuffering(false);
    if (restoreTimeRef.current > 0) {
      const target = restoreTimeRef.current;
      restoreTimeRef.current = 0;
      seek(target, { silent: true });
    }
    if (typeof onLoad === 'function') onLoad(meta);
  }, [onLoad, seek, setBuffering, setDuration]);

  const handleProgress = useCallback((payload) => {
    const current = payload && payload.currentTime;
    const buffered = payload && (payload.playableDuration != null ? payload.playableDuration : payload.buffered);
    updateProgress(current, buffered);
  }, [updateProgress]);

  const handleBuffer = useCallback((payload) => {
    setBuffering(!!(payload && payload.isBuffering));
  }, [setBuffering]);

  const handleNativeError = useCallback((payload) => {
    const detail = payload && payload.error
      ? `${payload.error.code || ''}${payload.error.message ? `: ${payload.error.message}` : ''}`
      : 'Unknown playback error';
    handleError(detail);
  }, [handleError]);

  const handleRetry = useCallback(() => {
    clearError();
    if (typeof onRetry === 'function') onRetry();
  }, [clearError, onRetry]);

  const handleEnd = useCallback(() => {
    controls.pause({ silent: true });
    if (typeof onEnd === 'function') onEnd();
  }, [controls.pause, onEnd]);

  const beginSeek = useCallback((value) => {
    setSeekPreview(value);
    wakeControls();
  }, [wakeControls]);

  const commitSeek = useCallback((target) => {
    if (!guest) seek(target);
    setSeekPreview(null);
  }, [guest, seek]);

  const handleDoubleTap = useCallback((side) => {
    if (guest) return;
    if (side === 'left') nudge(-10);
    else if (side === 'right') nudge(10);
    else togglePlay();
    wakeControls();
  }, [guest, nudge, togglePlay, wakeControls]);

  const handleRateHold = useCallback((value) => {
    if (guest) return;
    if (value === 2 && tempRateRef.current == null) {
      tempRateRef.current = getState().playbackRate;
      setRate(2);
      setRateHold(true);
    } else if (value == null && tempRateRef.current != null) {
      setRate(tempRateRef.current);
      tempRateRef.current = null;
      setRateHold(false);
    }
  }, [guest, getState, setRate]);

  const handleVolumeGesture = useCallback((value) => {
    setVolume(value);
    setVolumeOverlay({ visible: true, level: value });
  }, [setVolume]);

  const handleBrightnessGesture = useCallback((value) => {
    brightnessRef.current = value;
    setWindowBrightness(value);
    setBrightnessOverlay({ visible: true, level: value });
  }, []);

  const panHandlers = useVideoGestures({
    enabled: !mini && !compact && !state.locked && !!sourceUri,
    width: layout.width,
    height: layout.height,
    getDuration: () => state.duration,
    getCurrentTime: () => getState().currentTime,
    getVolume: () => getState().volume,
    getBrightness: () => brightnessRef.current,
    getZoom: () => getState().zoom,
    onSingleTap: wakeControls,
    onDoubleTap: handleDoubleTap,
    onSeekPreview: beginSeek,
    onSeekCommit: commitSeek,
    onVolumeChange: handleVolumeGesture,
    onBrightnessChange: handleBrightnessGesture,
    onRateHold: handleRateHold,
    onZoomChange: setZoom,
    onResetZoom: resetZoom,
    onMinimize: onMinimize,
    onGestureActive: setGestureActive,
  });

  useEffect(() => {
    if (!volumeOverlay) return undefined;
    const timer = setTimeout(() => setVolumeOverlay(null), 750);
    return () => clearTimeout(timer);
  }, [volumeOverlay]);

  useEffect(() => {
    if (!brightnessOverlay) return undefined;
    const timer = setTimeout(() => setBrightnessOverlay(null), 750);
    return () => clearTimeout(timer);
  }, [brightnessOverlay]);

  useEffect(() => {
    if (!seekPreview && !rateHold && !gestureActive) wakeControls();
  }, [seekPreview, rateHold, gestureActive, wakeControls]);

  const handleQuality = useCallback((quality) => {
    setQuality(quality);
    setSettingsOpen(false);
    if (quality === 'Auto' || guest) return;
    if (typeof onQualityChange === 'function') onQualityChange(Number(String(quality).replace('p', '')));
  }, [guest, onQualityChange, setQuality]);

  const handleSubtitle = useCallback((track) => {
    setSubtitleTrack(track);
    setSettingsOpen(false);
  }, [setSubtitleTrack]);

  const handleAudio = useCallback((track) => {
    setAudioTrack(track);
    setSettingsOpen(false);
  }, [setAudioTrack]);

  const handleResize = useCallback((value) => {
    setResizeMode(value);
    setSettingsOpen(false);
  }, [setResizeMode]);

  const handleRepeat = useCallback((value) => {
    setRepeat(value);
    setSettingsOpen(false);
  }, [setRepeat]);

  const handleBackground = useCallback((value) => {
    setBackgroundPlayback(value);
    setSettingsOpen(false);
  }, [setBackgroundPlayback]);

  const handleAutoPip = useCallback((value) => {
    setAutoPip(value);
    setSettingsOpen(false);
  }, [setAutoPip]);

  const handleRotationLock = useCallback((value) => {
    setRotationLock(value);
    setSettingsOpen(false);
  }, [setRotationLock]);

  const handleToggleSubtitles = useCallback(() => {
    const tracks = state.textTracks;
    if (!tracks.length) return;
    setSubtitleTrack(state.subtitleTrack >= 0 ? -1 : 0);
  }, [setSubtitleTrack, state.subtitleTrack, state.textTracks]);

  useImperativeHandle(ref, () => ({
    play: (options) => play(options),
    pause: (options) => pause(options),
    seek: (target, options) => seek(target, options),
    setRate: (rate, options) => setRate(rate, options),
    getState,
    setMuted: (value) => controls.setMuted(value),
    setVolume,
    enterPip: togglePip,
  }), [controls, getState, pause, play, seek, setRate, setVolume, togglePip]);

  const badge = watchTogetherRole === 'host' ? 'Host' : guest ? 'Synced' : null;
  const visibleError = error || state.error;
  const status = visibleError
    ? null
    : reconnecting
      ? 'Reconnecting…'
      : loading
        ? 'Loading video…'
        : statusLabel
          ? statusLabel
          : state.buffering
            ? 'Buffering…'
            : null;

  const surface = sourceUri ? (
    <VideoSurface
      sourceUri={sourceUri}
      sourceType={sourceType}
      paused={!state.playing}
      muted={state.muted}
      volume={state.volume}
      rate={state.playbackRate}
      resizeMode={state.resizeMode}
      zoom={state.zoom}
      repeat={state.repeat}
      backgroundPlayback={state.backgroundPlayback || pipActive}
      audioTrack={state.audioTrack}
      subtitleTrack={state.subtitleTrack}
      onLoad={handleLoad}
      onProgress={handleProgress}
      onBuffer={handleBuffer}
      onError={handleNativeError}
      onAudioTracks={(payload) => setTracks(payload && payload.audioTracks, state.textTracks)}
      onTextTracks={(payload) => setTracks(state.audioTracks, payload && payload.textTracks)}
      onEnd={handleEnd}
    />
  ) : null;

  const rootStyle = [
    styles.root,
    state.fullscreen && !mini && !compact ? styles.fullscreen : null,
    !state.fullscreen && !mini ? style : null,
    mini ? styles.miniRoot : null,
  ];

  const content = (
    <View
      style={rootStyle}
      onLayout={(event) => {
        const next = event.nativeEvent.layout;
        if (next.width && next.height) setLayout({ width: next.width, height: next.height });
      }}
      collapsable={false}
    >
      <View style={styles.surfaceWrap}>{surface}</View>
      {mini || !showControls ? null : (
        <>
          {enableGestures && !state.locked ? (
            <VideoGestureLayer panHandlers={panHandlers} />
          ) : null}
          <TojeyVideoControls
            visible={state.controlsVisible && !state.locked}
            compact={compact}
            title={title}
            badge={badge}
            state={state}
            guest={guest}
            watchTogether={watchTogether}
            sharedDisabled={guest}
            pipOk={pipOk}
            onRewind={() => nudge(-10)}
            onTogglePlay={() => togglePlay()}
            onForward={() => nudge(10)}
            onToggleMute={() => { toggleMuted(); wakeControls(); }}
            onSettings={() => { setSettingsOpen(true); wakeControls(); }}
            onToggleFullscreen={() => { toggleFullscreen(); wakeControls(); }}
            onPip={togglePip}
            onLock={() => setLocked(true)}
            onRepeat={() => setRepeat(!state.repeat)}
            onToggleSubtitles={handleToggleSubtitles}
            onSeekPreview={beginSeek}
            onSeekCommit={commitSeek}
            onBack={onBack}
            onMinimize={onMinimize}
          />
          {state.locked ? <VideoLockOverlay onUnlock={() => setLocked(false)} /> : null}
          <VideoStatusOverlay label={status} error={visibleError} buffering={!!status && (!!loading || !!reconnecting || state.buffering)} onRetry={handleRetry} />
          <VideoVolumeOverlay value={volumeOverlay} />
          <VideoBrightnessOverlay value={brightnessOverlay} />
          <VideoSeekOverlay value={seekPreview} duration={state.duration} />
          {rateHold ? (
            <View style={[styles.rateBadge, { transform: [{ translateY: fs(20) }] }]} pointerEvents="none">
              <Icon name="flash" size={14} color="#fff" />
              <Text style={styles.rateText}>2x Speed</Text>
            </View>
          ) : null}
          <VideoSettingsSheet
            visible={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            state={state}
            guest={guest}
            watchTogether={watchTogether}
            pipSupported={pipOk}
            orientationSupported
            qualities={availableQualities}
            onSpeed={(rate) => { if (!guest) setRate(rate); setSettingsOpen(false); }}
            onQuality={handleQuality}
            onSubtitle={handleSubtitle}
            onAudio={handleAudio}
            onResize={handleResize}
            onRepeat={handleRepeat}
            onBackground={handleBackground}
            onAutoPip={handleAutoPip}
            onRotationLock={handleRotationLock}
            onMute={toggleMuted}
            onVolume={setVolume}
          />
        </>
      )}
    </View>
  );

  if (mini) {
    return (
      <VideoMiniPlayer
        title={title}
        playing={state.playing}
        progress={state.duration ? state.currentTime / state.duration : 0}
        onToggle={() => togglePlay()}
        onClose={() => { pause({ silent: true }); if (typeof onMinimize === 'function') onMinimize('close'); }}
        onExpand={() => { if (typeof onMinimize === 'function') onMinimize('expand'); }}
      >
        {surface}
      </VideoMiniPlayer>
    );
  }

  return content;
});

const styles = StyleSheet.create({
  root: { backgroundColor: '#000', overflow: 'hidden' },
  fullscreen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    elevation: 30,
  },
  miniRoot: { flex: 1 },
  surfaceWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  surfaceFrame: { width: '100%', height: '100%', backgroundColor: '#000' },
  surfaceFill: { flex: 1, backgroundColor: '#000' },
  rateBadge: {
    position: 'absolute',
    top: 24,
    left: 0,
    right: 0,
    zIndex: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  rateText: { color: '#fff', fontSize: fs(12), fontWeight: '800' },
});

export default TojeyVideoPlayer;
