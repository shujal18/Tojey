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
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Video from 'react-native-video';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { aspectForResize, clamp, resizeModeFor, tickHaptic, VIDEO_ACCENT, VIDEO_SURFACE } from './videoConfig';
import useVideoControls from '../../hooks/useVideoControls';
import useVideoGestures from '../../hooks/useVideoGestures';
import useVideoRecovery from '../../hooks/useVideoRecovery';
import { enterPip, onPipAction, pipSupported } from '../../services/pip';
import { lockOrientation, setImmersive, unlockOrientation } from '../../services/orientation';
import { resetWindowBrightness, setWindowBrightness } from '../../services/brightness';
import TojeyVideoControls from './TojeyVideoControls';
import VideoGestureOverlay from './VideoGestureOverlay';
import VideoSettingsSheet from './VideoSettingsSheet';
import VideoVolumeOverlay from './VideoVolumeOverlay';
import VideoBrightnessOverlay from './VideoBrightnessOverlay';
import VideoSeekOverlay from './VideoSeekOverlay';
import VideoLockOverlay from './VideoLockOverlay';
import VideoMiniPlayer from './VideoMiniPlayer';

const VideoSurface = memo(function VideoSurface({
  videoRef,
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
  audioTrackCount = 0,
  subtitleTrack,
  textTrackCount = 0,
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
          ref={videoRef}
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
          selectedAudioTrack={audioTrackCount > 0 ? { type: 'index', value: audioTrack } : undefined}
          selectedTextTrack={textTrackCount > 0 && subtitleTrack >= 0 ? { type: 'index', value: subtitleTrack } : { type: 'disabled' }}
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
  fullscreen,
  contentKey,
  mode = 'full',
  initialTime = 0,
  initialRate = 1,
  initialMuted = false,
  initialVolume = 1,
  initialResizeMode = 'Fit',
  initialRepeat = false,
  showControls = true,
  enableGestures = true,
  gestureLocked = false,
  onSurfaceTap,
  watchTogetherRole = null,
  watchTogetherSessionId = null,
  sharedRate = null,
  reconnecting = false,
  loading = false,
  onLoad,
  onEnd,
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
  const trackKey = contentKey || sourceKey;
  const guest = watchTogetherRole === 'guest';
  const watchTogether = !!watchTogetherRole;
  const compact = mode === 'reels';
  const mini = mode === 'mini';
  const restoreTimeRef = useRef(Number(initialTime) || 0);
  const sourceKeyRef = useRef(sourceKey);
  const brightnessRef = useRef(0.8);
  const tempRateRef = useRef(null);
  const audioTracksRef = useRef([]);
  const textTracksRef = useRef([]);
  const lastActionRef = useRef({});
  const infoAnimRef = useRef(null);
  const [pipActive, setPipActive] = useState(false);
  const [pipOk, setPipOk] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState('root');
  const [gestureActive, setGestureActive] = useState(false);
  const [seekPreview, setSeekPreview] = useState(null);
  const [volumeOverlay, setVolumeOverlay] = useState(null);
  const [brightnessOverlay, setBrightnessOverlay] = useState(null);
  const [rateHold, setRateHold] = useState(false);
  const [controlsUnlocked, setControlsUnlocked] = useState(false);
  const [bufferingVisible, setBufferingVisible] = useState(false);
  const [infoChip, setInfoChip] = useState(null);
  const [layout, setLayout] = useState({ width: windowWidth, height: Math.round(windowWidth * 9 / 16) });
  const infoOpacity = useRef(new Animated.Value(0)).current;

  const controlsAllowed = showControls || controlsUnlocked;

  const controls = useVideoControls({
    sourceKey: sourceUri ? sourceKey : null,
    contentKey: sourceUri ? trackKey : null,
    fullscreen,
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
    setControlsVisible,
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
    setFullscreen,
    setLocked,
    setRepeat,
    setBackgroundPlayback,
    setAutoPip,
    setRotationLock,
    getState,
  } = controls;

  const gesturesAllowed = enableGestures && !gestureLocked && !state.locked;
  const canSeek = gesturesAllowed && !guest;
  const effectiveFullscreen = typeof fullscreen === 'boolean' ? !!fullscreen : state.fullscreen;
  const safeTop = effectiveFullscreen && !mini && !compact ? 18 : 0;
  const safeBottom = effectiveFullscreen && !mini && !compact ? 16 : 8;

  useVideoRecovery({
    enabled: !error && !state.error && state.playing && !guest && !mini && !compact,
    lastProgressRef,
    onRecover: () => { if (typeof onRetry === 'function') onRetry(); },
    stallMs: 10000,
  });

  const shouldRun = useCallback((key, minGap = 300) => {
    const now = Date.now();
    if (now - (lastActionRef.current[key] || 0) < minGap) return false;
    lastActionRef.current[key] = now;
    return true;
  }, []);

  const showInfo = useCallback((label, icon = 'flash') => {
    setInfoChip({ label, icon });
    infoOpacity.setValue(0);
    if (infoAnimRef.current) infoAnimRef.current.stop();
    infoAnimRef.current = Animated.timing(infoOpacity, {
      toValue: 1,
      duration: 120,
      useNativeDriver: true,
    });
    infoAnimRef.current.start();
  }, [infoOpacity]);

  useEffect(() => {
    if (!infoChip) return undefined;
    const timer = setTimeout(() => {
      if (infoAnimRef.current) infoAnimRef.current.stop();
      infoAnimRef.current = Animated.timing(infoOpacity, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      });
      infoAnimRef.current.start(({ finished }) => {
        if (finished) setInfoChip(null);
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [infoChip, infoOpacity]);

  useEffect(() => () => {
    if (infoAnimRef.current) infoAnimRef.current.stop();
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => pipSupported())
      .then((ok) => { if (!cancelled) setPipOk(!!ok && pipAllowed); })
      .catch(() => { if (!cancelled) setPipOk(false); });
    return () => { cancelled = true; };
  }, [pipAllowed]);

  useEffect(() => {
    if (sourceKeyRef.current === sourceKey) return;
    sourceKeyRef.current = sourceKey;
    if (!sourceUri) return;
    restoreTimeRef.current = getState().currentTime || Number(initialTime) || 0;
  }, [sourceKey, sourceUri, initialTime, getState]);

  useEffect(() => {
    if (state.audioTracks.length > 0 && state.audioTrack >= state.audioTracks.length) setAudioTrack(0);
  }, [setAudioTrack, state.audioTrack, state.audioTracks.length]);

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
    const pausedByState = rateHold || pipActive || loading || reconnecting || !!error || !!state.error;
    if (pausedByState) {
      holdControls();
      return releaseControls;
    }
    return undefined;
  }, [error, holdControls, loading, pipActive, rateHold, reconnecting, releaseControls, state.error]);

  useEffect(() => {
    StatusBar.setHidden(effectiveFullscreen && !mini && !compact, 'fade');
    if (effectiveFullscreen && !mini && !compact) setImmersive(true);
    else setImmersive(false);
    return () => {
      StatusBar.setHidden(false, 'none');
      setImmersive(false);
    };
  }, [compact, effectiveFullscreen, mini]);

  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      if (compact || mini) return;
      if (effectiveFullscreen) {
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
  }, [effectiveFullscreen, state.rotationLock, sourceAspect, windowWidth, windowHeight, compact, mini]);

  useEffect(() => () => { resetWindowBrightness(); }, []);

  useEffect(() => {
    if (!effectiveFullscreen) resetWindowBrightness();
  }, [effectiveFullscreen]);

  const togglePip = useCallback(async () => {
    if (!pipOk || !shouldRun('pip', 500)) return;
    const ok = await enterPip(16, 9, state.playing);
    if (ok) setPipActive(true);
  }, [pipOk, shouldRun, state.playing]);

  useEffect(() => onPipAction((action) => {
    if (!action || guest) return;
    if (action === 'play') play();
    else if (action === 'pause') pause();
  }), [guest, pause, play]);

  useEffect(() => {
    const listener = (nextState) => {
      if (nextState === 'background' && state.autoPip && state.playing && pipOk && !mini && !compact) togglePip();
      if (nextState === 'active' && pipActive) {
        setPipActive(false);
        setSeekPreview(null);
        setVolumeOverlay(null);
        setBrightnessOverlay(null);
        wakeControls();
      }
    };
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
  }, [compact, mini, pipActive, pipOk, state.autoPip, state.playing, togglePip, wakeControls]);

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

  const openSettings = useCallback((page = 'root') => {
    if (!shouldRun('settings', 300)) return;
    setSettingsPage(page);
    setSettingsOpen(true);
    wakeControls();
  }, [shouldRun, wakeControls]);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsPage('root');
    wakeControls();
  }, [wakeControls]);

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
    tickHaptic();
    if (side === 'left' || side === 'right') {
      const delta = side === 'left' ? -10 : 10;
      const current = getState().currentTime;
      const duration = getState().duration;
      const target = clamp(current + delta, 0, duration || Number.MAX_SAFE_INTEGER);
      nudge(delta);
      setSeekPreview({
        target,
        delta,
        label: side === 'left' ? '↶ 10 sec' : '10 sec ↷',
      });
    } else {
      togglePlay();
    }
    wakeControls();
  }, [getState, guest, nudge, togglePlay, wakeControls]);

  const handleRateHold = useCallback((value) => {
    if (guest) return;
    if (value === 2 && tempRateRef.current == null) {
      tickHaptic();
      tempRateRef.current = getState().playbackRate;
      setRate(2);
      setRateHold(true);
      showInfo('2x Speed', 'flash');
    } else if (value == null && tempRateRef.current != null) {
      setRate(tempRateRef.current);
      tempRateRef.current = null;
      setRateHold(false);
      setInfoChip(null);
    }
  }, [getState, guest, setRate, showInfo]);

  const handleVolumeGesture = useCallback((value) => {
    setVolume(value);
    setVolumeOverlay({ visible: true, level: value });
  }, [setVolume]);

  const handleBrightnessGesture = useCallback((value) => {
    brightnessRef.current = value;
    setWindowBrightness(value);
    setBrightnessOverlay({ visible: true, level: value });
  }, []);

  const handleSurfaceTap = useCallback(() => {
    if (!showControls && !controlsUnlocked) {
      setControlsUnlocked(true);
      wakeControls();
      if (typeof onSurfaceTap === 'function') onSurfaceTap();
      return;
    }
    if (typeof onSurfaceTap === 'function') onSurfaceTap();
    if (getState().controlsVisible) setControlsVisible(false);
    else wakeControls();
  }, [controlsUnlocked, getState, onSurfaceTap, setControlsVisible, showControls, wakeControls]);

  const panHandlers = useVideoGestures({
    enabled: gesturesAllowed && !!sourceUri,
    width: layout.width,
    height: layout.height,
    getDuration: () => state.duration,
    getCurrentTime: () => getState().currentTime,
    getVolume: () => getState().volume,
    getBrightness: () => brightnessRef.current,
    getZoom: () => getState().zoom,
    onSingleTap: handleSurfaceTap,
    onDoubleTap: canSeek ? handleDoubleTap : undefined,
    onSeekPreview: canSeek ? beginSeek : undefined,
    onSeekCommit: canSeek ? commitSeek : undefined,
    onVolumeChange: gesturesAllowed ? handleVolumeGesture : undefined,
    onBrightnessChange: gesturesAllowed ? handleBrightnessGesture : undefined,
    onRateHold: gesturesAllowed ? handleRateHold : undefined,
    onZoomChange: gesturesAllowed ? setZoom : undefined,
    onResetZoom: gesturesAllowed ? resetZoom : undefined,
    onMinimize: gesturesAllowed ? onMinimize : undefined,
    onGestureActive: setGestureActive,
  });

  useEffect(() => {
    if (!volumeOverlay) return undefined;
    const timer = setTimeout(() => setVolumeOverlay(null), 900);
    return () => clearTimeout(timer);
  }, [volumeOverlay]);

  useEffect(() => {
    if (!brightnessOverlay) return undefined;
    const timer = setTimeout(() => setBrightnessOverlay(null), 900);
    return () => clearTimeout(timer);
  }, [brightnessOverlay]);

  useEffect(() => {
    if (!seekPreview || !seekPreview.label) return undefined;
    const timer = setTimeout(() => setSeekPreview(null), 800);
    return () => clearTimeout(timer);
  }, [seekPreview]);

  useEffect(() => {
    if (!seekPreview && !rateHold && !gestureActive) wakeControls();
  }, [seekPreview, rateHold, gestureActive, wakeControls]);

  const handleQuality = useCallback((quality) => {
    if (!shouldRun('quality', 300)) return;
    setQuality(quality);
    closeSettings();
    showInfo(String(quality), 'videocam-outline');
    if (quality === 'Auto' || guest) return;
    if (typeof onQualityChange === 'function') onQualityChange(Number(String(quality).replace('p', '')));
  }, [closeSettings, guest, onQualityChange, setQuality, shouldRun, showInfo]);

  const handleSubtitle = useCallback((track) => {
    setSubtitleTrack(track);
    closeSettings();
  }, [closeSettings, setSubtitleTrack]);

  const handleAudio = useCallback((track) => {
    setAudioTrack(track);
    closeSettings();
  }, [closeSettings, setAudioTrack]);

  const handleResize = useCallback((value) => {
    if (!shouldRun('resize', 250)) return;
    setResizeMode(value);
    closeSettings();
    showInfo(value, 'crop-outline');
  }, [closeSettings, setResizeMode, shouldRun, showInfo]);

  const handleRepeat = useCallback((value) => {
    if (!shouldRun('repeat', 300)) return;
    setRepeat(value);
    closeSettings();
    showInfo(value ? 'Repeat on' : 'Repeat off', 'repeat-outline');
  }, [closeSettings, setRepeat, shouldRun, showInfo]);

  const handleBackground = useCallback((value) => {
    setBackgroundPlayback(value);
    closeSettings();
  }, [closeSettings, setBackgroundPlayback]);

  const handleAutoPip = useCallback((value) => {
    setAutoPip(value);
    closeSettings();
  }, [closeSettings, setAutoPip]);

  const handleRotationLock = useCallback((value) => {
    setRotationLock(value);
    closeSettings();
  }, [closeSettings, setRotationLock]);

  const handleToggleFullscreen = useCallback(() => {
    if (!shouldRun('fullscreen', 350)) return;
    setFullscreen(!effectiveFullscreen);
    wakeControls();
  }, [effectiveFullscreen, setFullscreen, shouldRun, wakeControls]);

  const handleSpeed = useCallback((rate) => {
    if (!shouldRun('speed', 250)) return;
    if (!guest) setRate(rate);
    closeSettings();
    showInfo(`${rate}x`, 'speedometer-outline');
  }, [closeSettings, guest, setRate, shouldRun, showInfo]);

  const bufferingNow = !!(state.buffering || loading || reconnecting);

  useEffect(() => {
    if (!bufferingNow) {
      setBufferingVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setBufferingVisible(true), 400);
    return () => clearTimeout(timer);
  }, [bufferingNow]);

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

  const visibleError = error || state.error;

  const handleBack = useCallback(() => {
    if (effectiveFullscreen && !mini && !compact) {
      setFullscreen(false);
      wakeControls();
      return;
    }
    if (typeof onBack === 'function') onBack();
  }, [compact, effectiveFullscreen, mini, onBack, setFullscreen, wakeControls]);

  const surface = sourceUri ? (
    <VideoSurface
      videoRef={videoRef}
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
      audioTrackCount={audioTracksRef.current.length}
      subtitleTrack={state.subtitleTrack}
      textTrackCount={textTracksRef.current.length}
      onLoad={handleLoad}
      onProgress={handleProgress}
      onBuffer={handleBuffer}
      onError={handleNativeError}
      onAudioTracks={(payload) => {
        audioTracksRef.current = Array.isArray(payload && payload.audioTracks) ? payload.audioTracks : [];
        setTracks(audioTracksRef.current, textTracksRef.current);
      }}
      onTextTracks={(payload) => {
        textTracksRef.current = Array.isArray(payload && payload.textTracks) ? payload.textTracks : [];
        setTracks(audioTracksRef.current, textTracksRef.current);
      }}
      onEnd={handleEnd}
    />
  ) : null;

  const displayState = effectiveFullscreen === state.fullscreen
    ? state
    : { ...state, fullscreen: effectiveFullscreen };

  const rootStyle = [
    styles.root,
    effectiveFullscreen && !mini && !compact ? styles.fullscreen : null,
    !effectiveFullscreen && !mini ? style : null,
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
      {mini || !controlsAllowed || pipActive ? null : (
        <>
          {state.locked ? null : <VideoGestureOverlay panHandlers={panHandlers} />}
          <TojeyVideoControls
            visible={state.controlsVisible && !state.locked}
            compact={compact}
            safeTop={safeTop}
            safeBottom={safeBottom}
            title={title}
            state={displayState}
            guest={guest}
            watchTogether={watchTogether}
            pipOk={pipOk}
            previewTime={seekPreview && seekPreview.target != null ? seekPreview.target : null}
            onToggleMute={() => { toggleMuted(); wakeControls(); }}
            onSettings={openSettings}
            onToggleFullscreen={handleToggleFullscreen}
            onPip={togglePip}
            onSeekPreview={beginSeek}
            onSeekCommit={commitSeek}
            onBack={handleBack}
          />
          <VideoCenterOverlay
            playing={state.playing}
            controlsVisible={state.controlsVisible && !state.locked}
            buffering={bufferingVisible && bufferingNow}
            error={visibleError}
            disabled={guest}
            locked={state.locked}
            onToggle={() => { tickHaptic(); togglePlay(); }}
            onRetry={handleRetry}
          />
          {state.locked ? <VideoLockOverlay onUnlock={() => setLocked(false)} /> : null}
          <VideoVolumeOverlay value={volumeOverlay} />
          <VideoBrightnessOverlay value={brightnessOverlay} />
          <VideoSeekOverlay value={seekPreview} duration={state.duration} />
          {infoChip ? (
            <Animated.View style={[styles.infoChip, { opacity: infoOpacity }]} pointerEvents="none">
              <Icon name={infoChip.icon} size={14} color="#fff" />
              <Text style={styles.infoText}>{infoChip.label}</Text>
            </Animated.View>
          ) : null}
          <VideoSettingsSheet
            visible={settingsOpen}
            initialPage={settingsPage}
            onClose={closeSettings}
            state={displayState}
            guest={guest}
            watchTogether={watchTogether}
            pipSupported={pipOk}
            orientationSupported
            qualities={availableQualities}
            onSpeed={handleSpeed}
            onQuality={handleQuality}
            onSubtitle={handleSubtitle}
            onAudio={handleAudio}
            onResize={handleResize}
            onRepeat={handleRepeat}
            onBackground={handleBackground}
            onAutoPip={handleAutoPip}
            onRotationLock={handleRotationLock}
            onLock={() => setLocked(true)}
            onMinimize={onMinimize}
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
  root: { flex: 1, backgroundColor: VIDEO_SURFACE, overflow: 'hidden' },
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
  surfaceFrame: { width: '100%', height: '100%', backgroundColor: VIDEO_SURFACE },
  surfaceFill: { flex: 1, backgroundColor: VIDEO_SURFACE },
  infoChip: {
    position: 'absolute',
    top: 24,
    left: 0,
    right: 0,
    zIndex: 28,
    alignSelf: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(5,12,24,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(61,155,255,0.24)',
  },
  infoText: { color: VIDEO_ACCENT, fontSize: fs(12), fontWeight: '800' },
});

export default TojeyVideoPlayer;
