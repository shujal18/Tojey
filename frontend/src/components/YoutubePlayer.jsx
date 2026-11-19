import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize, SkipBack, SkipForward,
  SlidersHorizontal, PictureInPicture, PictureInPicture2, RotateCcw, Lock,
  LockOpen, Moon, Check, X,
} from 'lucide-react';
import YouTubeEmbed from './YouTubeEmbed';

const API = import.meta.env.VITE_API_URL || '';

let dashModulePromise = null;
function loadDash() {
  if (!dashModulePromise) dashModulePromise = import('dashjs');
  return dashModulePromise;
}

let egressBlockedUntil = 0;
const EGRESS_BLOCK_MEMO_MS = 10 * 60 * 1000;
function isEgressBlocked() {
  return Date.now() < egressBlockedUntil;
}
function notePlaybackReason(raw) {
  if (/bot|sign in|login|verify/i.test(String(raw || ''))) {
    egressBlockedUntil = Date.now() + EGRESS_BLOCK_MEMO_MS;
  }
}
export function ytEgressBlocked() {
  return isEgressBlocked();
}
export function noteEgressBlocked() {
  egressBlockedUntil = Date.now() + EGRESS_BLOCK_MEMO_MS;
}

export function streamUrl(videoId, itag, token, maxHeight = 0) {
  const cap = maxHeight > 0 ? `&maxHeight=${encodeURIComponent(maxHeight)}` : '';
  return `${API}/api/yt/media/${videoId}?itag=${itag}&token=${encodeURIComponent(token || '')}${cap}`;
}

export function downloadUrl(videoId, itag, token, mux) {
  const m = mux ? '&mux=1' : '';
  return `${API}/api/yt/media/${videoId}?itag=${itag}&download=1${m}&token=${encodeURIComponent(token || '')}`;
}

export function dashUrl(videoId, token) {
  return `${API}/api/yt/dash/${videoId}?token=${encodeURIComponent(token || '')}`;
}

export function triggerDownload(videoId, token, itag = 'best', mux = false) {
  const a = document.createElement('a');
  a.href = downloadUrl(videoId, token, itag, mux);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60];
const LS_RATE = 'tojey.player.rate';
const LS_QUALITY = 'tojey.player.quality';
const LS_NEXT = 'tojey.player.autoNext';
const LS_RESUME = 'tojey.player.resume';

function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(t) {
  const s = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function readLS(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeLS(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function readResume() {
  const map = readLS(LS_RESUME, {});
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(!!mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

export default function YoutubePlayer({
  videoId,
  token,
  poster,
  autoPlay = true,
  controls = true,
  onEnded,
  onError,
  style,
  fill = false,
  embedFallback = true,
  onController,
  onUserAction,
  nextVideo,
  related,
  recommendations,
  feed,
  onNext,
}) {
  const { theme } = useTheme();
  const reduced = useReducedMotion();
  const motion = reduced ? '0ms' : '220ms';

  const videoRef = useRef(null);
  const dashRef = useRef(null);
  const containerRef = useRef(null);
  const surfaceRef = useRef(null);
  const trackRef = useRef(null);
  const rafRef = useRef(0);
  const hideTimerRef = useRef(0);
  const toastTimerRef = useRef(0);
  const feedbackTimerRef = useRef(0);
  const longPressRef = useRef(0);
  const sleepRef = useRef(null);
  const nextDeadlineRef = useRef(0);
  const nextCandidateRef = useRef(null);
  const endedHandlerRef = useRef(null);
  const endedFiredRef = useRef(false);
  const offeredRef = useRef(new Set());
  const resumeAtRef = useRef(0);
  const restoredRef = useRef(false);
  const lastSaveRef = useRef(0);
  const lastBufferedRef = useRef('');
  const pointersRef = useRef(new Map());
  const gestureRef = useRef({
    mode: null, x: 0, y: 0, t: 0, dx: 0, dy: 0, moved: false,
    base: 0, startVolume: 1, startBrightness: 1, boostPrevious: 1,
    boosting: false, pinch: 0, multiStart: 0, lastTap: 0, lastTapX: 0, lastTapY: 0, tapTimer: 0,
  });

  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const onUserActionRef = useRef(onUserAction);
  const onControllerRef = useRef(onController);
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  onUserActionRef.current = onUserAction;
  onControllerRef.current = onController;

  const applyingUntilRef = useRef(0);
  const firstPlayRef = useRef(true);
  const markApplying = useCallback((ms) => {
    applyingUntilRef.current = Math.max(applyingUntilRef.current, Date.now() + ms);
  }, []);

  const [state, setState] = useState('loading');
  const [errMsg, setErrMsg] = useState('');
  const [toast, setToast] = useState('');
  const [muted, setMuted] = useState(autoPlay);
  const [fallback, setFallback] = useState(false);
  const [useEmbed, setUseEmbed] = useState(false);
  const [nativeRetryFor, setNativeRetryFor] = useState(null);
  const [progItag, setProgItag] = useState(18);
  const [levels, setLevels] = useState([]);
  const [level, setLevel] = useState(-1);
  const [currentQuality, setCurrentQuality] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pipOn, setPipOn] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [rate, setRateState] = useState(() => {
    const saved = Number(readLS(LS_RATE, 1));
    return RATES.includes(saved) ? saved : 1;
  });
  const [audioTracks, setAudioTracks] = useState([]);
  const [audioTrackId, setAudioTrackId] = useState('');
  const [textTracks, setTextTracks] = useState([]);
  const [selectedCaption, setSelectedCaption] = useState('');
  const [buffered, setBuffered] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [brightness, setBrightness] = useState(1);
  const [locked, setLocked] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [sleepEnd, setSleepEnd] = useState(null);
  const [sleepLeft, setSleepLeft] = useState(0);
  const [autoNext, setAutoNext] = useState(() => readLS(LS_NEXT, true) !== false);
  const [nextCandidate, setNextCandidate] = useState(null);
  const [nextCount, setNextCount] = useState(0);
  const [zoom, setZoom] = useState(1);

  const latest = useRef({});
  latest.current = {
    state, useEmbed, playing, showControls, settingsOpen, dragging, dragTime,
    buffering, locked, fullscreen, rate, volume, muted, duration, currentTime,
    brightness, sleepEnd, autoNext, nextCandidate, nextCount, pipOn, zoom, level, levels, currentQuality,
    audioTracks, selectedCaption, textTracks, videoId, controls, reduced,
    onNext, onEnded, onError, onUserAction, onController,
  };

  const armHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = 0;
    const L = latest.current;
    if (!L.controls || !L.playing || L.settingsOpen || L.dragging || L.buffering || L.locked || L.state !== 'ready' || L.useEmbed) return;
    hideTimerRef.current = setTimeout(() => {
      const M = latest.current;
      if (M.playing && !M.settingsOpen && !M.dragging && !M.buffering && !M.locked) setShowControls(false);
    }, 3000);
  }, []);

  const wake = useCallback(() => {
    setShowControls(true);
    armHide();
  }, [armHide]);

  useEffect(() => {
    const L = latest.current;
    if (!L.playing || L.settingsOpen || L.dragging || L.buffering || L.locked) setShowControls(true);
    armHide();
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [playing, settingsOpen, dragging, buffering, locked, state, useEmbed, controls, armHide]);

  const showToast = useCallback((message) => {
    setToast(String(message || '').slice(0, 120));
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => { setToast(''); toastTimerRef.current = 0; }, 2600);
  }, []);

  const showFeedback = useCallback((text) => {
    setFeedback(text);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => { setFeedback(null); feedbackTimerRef.current = 0; }, 750);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    if (longPressRef.current) clearTimeout(longPressRef.current);
    if (gestureRef.current.tapTimer) clearTimeout(gestureRef.current.tapTimer);
  }, []);

  const persistResume = useCallback((force) => {
    const v = videoRef.current;
    if (!v || !videoId) return;
    const t = v.currentTime || 0;
    if (!force && Math.abs(t - lastSaveRef.current) < 5) return;
    const d = v.duration || 0;
    const complete = d > 0 && t >= d * 0.95;
    const map = readResume();
    map[videoId] = { t: complete ? 0 : Math.floor(t), d: Math.floor(d), completed: complete, ts: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > 40) {
      keys.sort((a, b) => (map[b].ts || 0) - (map[a].ts || 0)).slice(40).forEach((k) => delete map[k]);
    }
    writeLS(LS_RESUME, map);
    lastSaveRef.current = t;
  }, [videoId]);

  useEffect(() => {
    const entry = readResume()[videoId];
    resumeAtRef.current = entry && !entry.completed && entry.t > 3 && entry.d > 0 && entry.t < entry.d * 0.95 ? entry.t : 0;
    restoredRef.current = false;
    endedFiredRef.current = false;
    lastSaveRef.current = 0;
    nextDeadlineRef.current = 0;
    nextCandidateRef.current = null;
    offeredRef.current.add(videoId);
    setZoom(1);
    setBrightness(1);
    setFeedback(null);
    setSettingsOpen(false);
    setNextCandidate(null);
    setNextCount(0);
    setCurrentTime(0);
    setDuration(0);
    setBuffered([]);
    lastBufferedRef.current = '';
  }, [videoId]);

  useEffect(() => {
    setPipAvailable(typeof document !== 'undefined' && !!document.pictureInPictureEnabled && typeof HTMLVideoElement !== 'undefined' && !!HTMLVideoElement.prototype.requestPictureInPicture);
  }, []);

  useEffect(() => {
    if (useEmbed || state !== 'ready') return undefined;
    let lastUi = 0;
    const tick = (now) => {
      rafRef.current = requestAnimationFrame(tick);
      const v = videoRef.current;
      if (!v || document.hidden) return;
      if (now - lastUi < 100) return;
      lastUi = now;
      const t = v.currentTime || 0;
      if (Math.abs(t - latest.current.currentTime) > 0.05) setCurrentTime(t);
      try {
        const ranges = [];
        for (let i = 0; i < v.buffered.length; i += 1) ranges.push([v.buffered.start(i), v.buffered.end(i)]);
        const key = ranges.map((r) => `${r[0].toFixed(1)}-${r[1].toFixed(1)}`).join(',');
        if (key !== lastBufferedRef.current) {
          lastBufferedRef.current = key;
          setBuffered(ranges);
        }
      } catch (e) {}
      if (t > 0 && v.duration && Math.abs(t - lastSaveRef.current) >= 5) persistResume(false);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [useEmbed, state, persistResume]);

  useEffect(() => {
    const id = setInterval(() => {
      const L = latest.current;
      const sleep = sleepRef.current;
      if (sleep && sleep.mode === 'time' && Date.now() >= sleep.at) {
        sleepRef.current = null;
        setSleepEnd(null);
        setSleepLeft(0);
        const v = videoRef.current;
        if (v && !v.paused) v.pause();
        showToast('Sleep timer: playback paused');
      } else if (sleep && sleep.mode === 'time') {
        setSleepLeft(Math.max(0, Math.ceil((sleep.at - Date.now()) / 1000)));
      }
      if (nextDeadlineRef.current) {
        const left = Math.max(0, Math.ceil((nextDeadlineRef.current - Date.now()) / 1000));
        if (left !== L.nextCount) setNextCount(left);
        if (left === 0) {
          nextDeadlineRef.current = 0;
          const candidate = nextCandidateRef.current;
          nextCandidateRef.current = null;
          setNextCandidate(null);
          if (candidate && typeof L.onNext === 'function') L.onNext(candidate);
        }
      }
      const player = dashRef.current;
      if (player && L.levels.length && typeof player.getQualityFor === 'function') {
        try {
          const idx = player.getQualityFor('video');
          const height = L.levels.find((l) => l.index === idx)?.height || 0;
          if (height !== L.currentQuality) setCurrentQuality(height);
        } catch (e) {}
      }
    }, 1000);
    return () => clearInterval(id);
  }, [showToast]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoId) return;
    if (embedFallback && videoId && nativeRetryFor !== videoId) {
      setUseEmbed(true);
      setState('ready');
      return;
    }
    let cancelled = false;
    let player = null;
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(fastFailTimer);
    };
    const fastFailTimer = setTimeout(() => {
      if (cancelled || settled) return;
      settled = true;
      if (embedFallback && videoId) {
        try { destroy(); } catch (e) {}
        setUseEmbed(true);
        setState('ready');
      }
    }, 10000);

    setState('loading');
    setErrMsg('');
    setLevels([]);
    setLevel(-1);
    setCurrentQuality(0);
    setFallback(false);
    setUseEmbed(false);
    setSettingsOpen(false);
    setBuffering(false);
    applyingUntilRef.current = Date.now() + 1500;
    firstPlayRef.current = true;
    video.muted = autoPlay;

    const destroy = () => {
      if (player) {
        try { player.reset(); } catch (e) {}
        player = null;
        dashRef.current = null;
      }
    };

    const fail = (msg) => {
      if (cancelled) return;
      settle();
      const raw = String(msg || '');
      notePlaybackReason(raw);
      if (embedFallback && videoId && nativeRetryFor !== videoId) {
        destroy();
        setUseEmbed(true);
        setState('ready');
        return;
      }
      const shown = /bot|sign in|login|verify/i.test(raw)
        ? 'Playback is temporarily unavailable. Tap Retry.'
        : (raw || 'Playback failed');
      setState('error');
      setErrMsg(shown);
      if (onErrorRef.current) onErrorRef.current(new Error(shown));
    };

    const setupProgressive = async () => {
      destroy();
      try {
        const res = await fetch(`${API}/api/yt/streams/${videoId}`, {
          headers: { Authorization: `Bearer ${token || ''}` },
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled || settled) return;
        const prog = (data.formats || [])
          .filter((f) => f.hasVideo && f.hasAudio)
          .sort((a, b) => (b.height || 0) - (a.height || 0));
        if (!prog.length) { fail(data.reason || data.error || 'No playable stream'); return; }
        settle();
        setProgItag(prog[0].itag);
        setFallback(true);
        setState('ready');
      } catch (e) {
        if (!cancelled && !settled) fail(e.message);
      }
    };

    const setupDash = async () => {
      if (typeof window === 'undefined' || !window.MediaSource) { setupProgressive(); return; }
      let MediaPlayer;
      try {
        ({ MediaPlayer } = await loadDash());
      } catch (e) {
        setupProgressive();
        return;
      }
      if (cancelled || settled) return;
      try {
        player = MediaPlayer().create();
        dashRef.current = player;
        player.updateSettings({
          streaming: {
            buffer: {
              fastSwitchEnabled: true,
              bufferToKeep: 20,
              bufferTimeDefault: 12,
              bufferTimeAtTopQuality: 20,
              bufferTimeAtTopQualityLongForm: 60,
              initialBufferLevel: 3,
              longFormContentDurationThreshold: 300,
            },
            abr: {
              autoSwitchBitrate: { video: true, audio: true },
              initialBitrate: { video: 1500, audio: 128 },
              throughput: { useDeadTimeLatency: false },
            },
            cmcd: { enabled: false },
          },
        });
        player.on('streamInitialized', () => {
          if (cancelled || settled) return;
          settle();
          try {
            const reps = player.getRepresentationsByType('video') || [];
            const found = reps
              .map((r, i) => ({ index: i, height: r.height || 0, width: r.width || 0, bitrate: r.bandwidth || 0 }))
              .filter((r) => r.height > 0)
              .sort((a, b) => b.height - a.height);
            setLevels(found);
            const wanted = readLS(LS_QUALITY, 'auto');
            if (wanted !== 'auto') {
              const match = found.find((l) => String(l.height) === String(wanted));
              if (match) {
                setLevel(match.index);
                player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false, audio: true } } } });
                player.setRepresentationForTypeByIndex('video', match.index);
              }
            }
          } catch (e) { setLevels([]); }
          try {
            const tracks = player.getTracksFor('audio') || [];
            const found = tracks
              .map((t, i) => ({ id: String(t.id || i), label: t.lang || t.id || `Audio ${i + 1}` }))
              .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
            setAudioTracks(found);
            const current = player.getCurrentTrackFor('audio');
            setAudioTrackId(current ? String(current.id || found[0]?.id || '') : String(found[0]?.id || ''));
          } catch (e) { setAudioTracks([]); }
          try {
            const found = (player.getTextTracks() || []).map((t, i) => ({
              id: `${i}`,
              label: t.label || t.lang || `Captions ${i + 1}`,
              lang: t.lang || '',
            }));
            setTextTracks(found);
          } catch (e) { setTextTracks([]); }
          setState('ready');
          if (autoPlay) video.play().catch(() => {});
        });
        const onErr = () => {
          if (cancelled || settled) return;
          fail('Playback failed');
        };
        player.on('error', onErr);
        player.on('playbackError', onErr);
        player.on('playbackEnded', () => { if (endedHandlerRef.current) endedHandlerRef.current(); });
        player.initialize(video, dashUrl(videoId, token), autoPlay);
      } catch (e) {
        if (!cancelled && !settled) setupProgressive();
      }
    };

    setupDash();

    return () => {
      cancelled = true;
      clearTimeout(fastFailTimer);
      persistResume(true);
      destroy();
      if (video) { try { video.src = ''; video.load(); } catch (e) {} }
    };
  }, [videoId, token, nonce, autoPlay, nativeRetryFor, embedFallback, persistResume]);

  const handleCanPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setBuffering(false);
    if (!autoPlay) { v.muted = false; setMuted(false); return; }
    v.muted = false;
    v.play().then(() => setMuted(false)).catch(() => {
      v.muted = true;
      setMuted(true);
      v.play().catch(() => {});
    });
  }, [autoPlay]);

  const applyRate = useCallback((value, persist) => {
    const parsed = Number(value);
    const next = RATES.includes(parsed) ? parsed : 1;
    if (persist) {
      setRateState(next);
      writeLS(LS_RATE, next);
    }
    const v = videoRef.current;
    if (v) { try { v.playbackRate = next; } catch (e) {} }
    wake();
  }, [wake]);

  useEffect(() => {
    if (useEmbed || state !== 'ready') return;
    const v = videoRef.current;
    if (v) { try { v.playbackRate = rate; } catch (e) {} }
  }, [state, useEmbed, rate]);

  const chooseLevel = useCallback((next) => {
    const idx = Number(next);
    setLevel(idx);
    setSettingsOpen(false);
    const found = latest.current.levels.find((l) => l.index === idx);
    writeLS(LS_QUALITY, idx < 0 || !found ? 'auto' : found.height);
    const player = dashRef.current;
    if (!player) return;
    try {
      if (idx < 0) {
        player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: true, audio: true } } } });
      } else {
        player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false, audio: true } } } });
        player.setRepresentationForTypeByIndex('video', idx);
      }
    } catch (e) { showToast('Could not change quality'); }
    wake();
  }, [showToast, wake]);

  const chooseAudio = useCallback((id) => {
    setAudioTrackId(id);
    const player = dashRef.current;
    if (player) {
      try {
        const found = (player.getTracksFor('audio') || []).find((t) => String(t.id || '') === id);
        if (found) player.setCurrentTrack(found, 'audio');
      } catch (e) { showToast('Could not change audio track'); }
    }
    wake();
  }, [showToast, wake]);

  const chooseCaption = useCallback((id) => {
    const next = selectedCaption === id ? '' : id;
    setSelectedCaption(next);
    const v = videoRef.current;
    if (v && v.textTracks) {
      Array.from(v.textTracks).forEach((t, i) => {
        try { t.mode = (`native-${i}` === next || t.language === next || t.label === next) ? 'showing' : 'hidden'; } catch (e) {}
      });
    }
    const player = dashRef.current;
    if (player && typeof player.setTextTrack === 'function') {
      try {
        const idx = (player.getTextTracks() || []).findIndex((t, i) => `${i}` === id || t.lang === id);
        player.setTextTrack(next ? idx : -1);
      } catch (e) {}
    }
    wake();
  }, [selectedCaption, wake]);

  const setSleep = useCallback((value) => {
    if (value == null) {
      sleepRef.current = null;
      setSleepEnd(null);
      setSleepLeft(0);
      showToast('Sleep timer cancelled');
    } else if (value === 'end') {
      sleepRef.current = { mode: 'end', at: 0 };
      setSleepEnd({ mode: 'end', at: 0 });
      setSleepLeft(0);
      showToast('Sleep timer: pause at end of video');
    } else {
      const at = Date.now() + Number(value) * 60000;
      sleepRef.current = { mode: 'time', at };
      setSleepEnd({ mode: 'time', at });
      setSleepLeft(Number(value) * 60);
      showToast(`Sleep timer set for ${value} min`);
    }
    wake();
  }, [showToast, wake]);

  const pickNext = useCallback(() => {
    const L = latest.current;
    if (typeof L.onNext !== 'function') return null;
    const sources = [L.nextVideo];
    if (Array.isArray(L.related)) sources.push(...L.related);
    if (Array.isArray(L.recommendations)) sources.push(...L.recommendations);
    if (Array.isArray(L.feed)) sources.push(...L.feed);
    for (const item of sources) {
      if (!item || typeof item !== 'object') continue;
      const id = item.videoId || item.id;
      if (!id || id === L.videoId || offeredRef.current.has(id)) continue;
      offeredRef.current.add(id);
      return { videoId: id, title: item.title || 'Next video', channelTitle: item.channelTitle || item.channel || '' };
    }
    return null;
  }, []);

  const cancelNext = useCallback(() => {
    nextDeadlineRef.current = 0;
    nextCandidateRef.current = null;
    setNextCandidate(null);
    setNextCount(0);
    wake();
  }, [wake]);

  const handleEnded = useCallback(() => {
    if (endedFiredRef.current) return;
    endedFiredRef.current = true;
    persistResume(true);
    setPlaying(false);
    if (onEndedRef.current) onEndedRef.current();
    const sleep = sleepRef.current;
    if (sleep && sleep.mode === 'end') {
      sleepRef.current = null;
      setSleepEnd(null);
      setSleepLeft(0);
      showToast('Sleep timer: video ended');
    }
    if (!latest.current.autoNext) return;
    const candidate = pickNext();
    if (!candidate) return;
    nextCandidateRef.current = candidate;
    nextDeadlineRef.current = Date.now() + 8000;
    setNextCandidate(candidate);
    setNextCount(8);
    wake();
  }, [persistResume, pickNext, showToast, wake]);
  endedHandlerRef.current = handleEnded;

  const toggleAutoNext = useCallback(() => {
    setAutoNext((prev) => {
      const next = !prev;
      writeLS(LS_NEXT, next);
      if (!next) {
        nextDeadlineRef.current = 0;
        nextCandidateRef.current = null;
        setNextCandidate(null);
        setNextCount(0);
      }
      return next;
    });
    wake();
  }, [wake]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || useEmbed) return undefined;
    const onTime = () => {
      const t = video.currentTime || 0;
      if (Math.abs(t - latest.current.currentTime) > 0.2) setCurrentTime(t);
    };
    const onDuration = () => {
      setDuration(video.duration || 0);
    };
    const onMeta = () => {
      const d = video.duration || 0;
      setDuration(d);
      if (!restoredRef.current && resumeAtRef.current > 0 && d > resumeAtRef.current + 2) {
        restoredRef.current = true;
        try { video.currentTime = resumeAtRef.current; } catch (e) {}
        showToast(`Resumed at ${fmtTime(resumeAtRef.current)}`);
      }
      const found = [];
      if (video.textTracks) {
        Array.from(video.textTracks).forEach((t, i) => {
          found.push({ id: `native-${i}`, label: t.label || t.language || `Captions ${i + 1}`, lang: t.language || '' });
        });
      }
      if (found.length) setTextTracks((prev) => (prev.length ? prev : found));
    };
    const onPlay = () => { endedFiredRef.current = false; setPlaying(true); setBuffering(false); wake(); };
    const onPause = () => { setPlaying(false); setShowControls(true); persistResume(true); wake(); };
    const onWaiting = () => { setBuffering(true); setShowControls(true); };
    const onReady = () => { setBuffering(false); };
    const onRateChange = () => {
      if (!gestureRef.current.boosting) setRateState(video.playbackRate || 1);
    };
    const onVolume = () => {
      setVolume(video.volume == null ? 1 : video.volume);
      setMuted(!!video.muted);
    };
    const onEnd = () => handleEnded();
    const onEnterPip = () => setPipOn(true);
    const onLeavePip = () => setPipOn(false);
    const onVisibility = () => { if (document.hidden) persistResume(true); };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onWaiting);
    video.addEventListener('canplay', onReady);
    video.addEventListener('playing', onReady);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('volumechange', onVolume);
    video.addEventListener('ended', onEnd);
    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('playing', onReady);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('volumechange', onVolume);
      video.removeEventListener('ended', onEnd);
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [useEmbed, videoId, wake, persistResume, handleEnded, showToast]);

  useEffect(() => {
    const register = onControllerRef.current;
    if (!register) return undefined;
    if (useEmbed) return undefined;
    if (state !== 'ready') {
      register(null);
      return undefined;
    }
    const controller = {
      isEmbed: false,
      isReady: () => true,
      getTime: () => (videoRef.current ? videoRef.current.currentTime || 0 : 0),
      isPaused: () => (videoRef.current ? videoRef.current.paused : true),
      play: () => {
        const v = videoRef.current;
        if (!v) return;
        markApplying(900);
        v.play().catch(() => {});
      },
      pause: () => {
        const v = videoRef.current;
        if (!v) return;
        markApplying(900);
        v.pause();
      },
      seek: (t) => {
        const v = videoRef.current;
        if (!v) return;
        markApplying(1500);
        try { v.currentTime = Math.max(0, t); } catch (e) {}
      },
      setRate: (r) => {
        const v = videoRef.current;
        if (!v) return;
        try { v.playbackRate = r; } catch (e) {}
      },
    };
    register(controller);
    return () => register(null);
  }, [state, useEmbed, videoId, markApplying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onUserAction) return undefined;
    const report = (action) => () => {
      if (action === 'play' && firstPlayRef.current) {
        firstPlayRef.current = false;
        return;
      }
      if (Date.now() < applyingUntilRef.current) return;
      const cb = onUserActionRef.current;
      if (cb) cb(action, video.currentTime || 0);
    };
    const onPlay = report('play');
    const onPause = report('pause');
    const onSeeked = report('seek');
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
    };
  }, [state, useEmbed, videoId, onUserAction]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => showToast('Playback blocked — tap again'));
    else v.pause();
    wake();
  }, [showToast, wake]);

  const seekBy = useCallback((delta) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const target = Math.max(0, Math.min(v.duration || 0, (v.currentTime || 0) + delta));
    try { v.currentTime = target; } catch (e) {}
    setCurrentTime(target);
    wake();
  }, [wake]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const next = !v.muted;
    try { v.muted = next; } catch (e) {}
    setMuted(next);
    wake();
  }, [wake]);

  const changeVolume = useCallback((value) => {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    const v = videoRef.current;
    if (v) {
      try { v.volume = next; v.muted = next === 0; } catch (e) {}
    }
    setVolume(next);
    setMuted(next === 0);
    wake();
  }, [wake]);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      } else if (el.requestFullscreen) await el.requestFullscreen();
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else showToast('Fullscreen is not available in this browser');
    } catch (e) { showToast('Fullscreen was blocked'); }
    wake();
  }, [showToast, wake]);

  useEffect(() => {
    const onFs = () => { setFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement)); wake(); };
    const onFsError = () => showToast('Fullscreen could not be entered');
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    document.addEventListener('fullscreenerror', onFsError);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
      document.removeEventListener('fullscreenerror', onFsError);
    };
  }, [wake, showToast]);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    } catch (e) { showToast('Picture-in-picture is not available'); }
    wake();
  }, [showToast, wake]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const L = latest.current;
      if (L.useEmbed || L.state !== 'ready') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const active = document.activeElement;
      if (active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.getAttribute('role') === 'textbox' || active.closest?.('[contenteditable="true"]'))) return;
      const key = e.key;
      if (key === ' ' || key.toLowerCase() === 'k') { e.preventDefault(); togglePlay(); return; }
      if (key === 'ArrowRight') { e.preventDefault(); seekBy(10); showFeedback('+10s'); return; }
      if (key === 'ArrowLeft') { e.preventDefault(); seekBy(-10); showFeedback('-10s'); return; }
      if (key === 'ArrowUp') { e.preventDefault(); changeVolume((L.volume || 0) + 0.1); return; }
      if (key === 'ArrowDown') { e.preventDefault(); changeVolume((L.volume || 0) - 0.1); return; }
      const lower = key.toLowerCase();
      if (lower === 'f') { e.preventDefault(); toggleFullscreen(); return; }
      if (lower === 'm') { e.preventDefault(); toggleMute(); return; }
      if (lower === 'c') {
        e.preventDefault();
        if (L.textTracks.length) chooseCaption(L.selectedCaption ? '' : L.textTracks[0].id);
        return;
      }
      if (key === 'Escape') {
        e.preventDefault();
        if (L.settingsOpen) setSettingsOpen(false);
        else if (L.nextCandidate) cancelNext();
        else if (L.locked) setLocked(false);
        else if (document.fullscreenElement || document.webkitFullscreenElement) document.exitFullscreen?.();
        return;
      }
      if (/^[0-9]$/.test(key)) {
        e.preventDefault();
        const v = videoRef.current;
        if (v && Number.isFinite(v.duration)) {
          const target = (Number(key) / 10) * (v.duration || 0);
          try { v.currentTime = target; } catch (err) {}
          setCurrentTime(target);
          wake();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [useEmbed, state, togglePlay, seekBy, changeVolume, toggleFullscreen, toggleMute, chooseCaption, cancelNext, showFeedback, wake]);

  const barTime = useCallback((clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * (latest.current.duration || 0);
  }, []);

  const onBarDown = useCallback((e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    setDragging(true);
    setDragTime(barTime(e.clientX));
    wake();
  }, [barTime, wake]);

  const onBarMove = useCallback((e) => {
    if (!latest.current.dragging) return;
    setDragTime(barTime(e.clientX));
  }, [barTime]);

  const onBarUp = useCallback((e) => {
    if (!latest.current.dragging) return;
    const target = barTime(e.clientX);
    const v = videoRef.current;
    if (v) { try { v.currentTime = target; } catch (err) {} }
    setCurrentTime(target);
    setDragging(false);
    wake();
  }, [barTime, wake]);

  const onBarCancel = useCallback(() => {
    setDragging(false);
    wake();
  }, [wake]);

  const endBoost = useCallback(() => {
    const g = gestureRef.current;
    if (g.boosting) {
      g.boosting = false;
      applyRate(g.boostPrevious, false);
      showFeedback('');
    }
  }, [applyRate, showFeedback]);

  const onSurfaceDown = useCallback((e) => {
    const L = latest.current;
    if (L.useEmbed || L.state !== 'ready' || !L.controls) return;
    firstPlayRef.current = false;
    const g = gestureRef.current;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values());
      g.pinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      g.multiStart = g.pinch;
      g.multi = true;
      if (g.tapTimer) { clearTimeout(g.tapTimer); g.tapTimer = 0; }
      if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = 0; }
      endBoost();
      return;
    }
    if (pointersRef.current.size > 2) return;
    g.mode = null;
    g.moved = false;
    g.multi = false;
    g.x = e.clientX;
    g.y = e.clientY;
    g.t = Date.now();
    g.dx = 0;
    g.dy = 0;
    const v = videoRef.current;
    g.base = v ? v.currentTime || 0 : 0;
    g.startVolume = v && v.volume != null ? v.volume : 1;
    g.startBrightness = L.brightness;
    if (!L.locked) {
      longPressRef.current = setTimeout(() => {
        const G = gestureRef.current;
        if (G.moved || G.mode || pointersRef.current.size !== 1) return;
        G.boostPrevious = latest.current.rate;
        G.boosting = true;
        applyRate(2, false);
        showFeedback('2× speed');
      }, 500);
    }
    wake();
  }, [applyRate, endBoost, showFeedback, wake]);

  const onSurfaceMove = useCallback((e) => {
    const g = gestureRef.current;
    const point = pointersRef.current.get(e.pointerId);
    if (!point) return;
    point.x = e.clientX;
    point.y = e.clientY;
    if (pointersRef.current.size >= 2) {
      const pts = Array.from(pointersRef.current.values());
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (g.pinch > 0) setZoom(Math.max(1, Math.min(3, Math.round(latest.current.zoom * (distance / g.pinch) * 100) / 100)));
      if (Math.abs(distance - g.multiStart) > 10) g.moved = true;
      g.pinch = distance;
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.dx = dx;
    g.dy = dy;
    const L = latest.current;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (g.boosting && (absX > 10 || absY > 10)) endBoost();
    if (absX > 12 && absX > absY && !g.mode && !L.locked && !g.boosting) {
      if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = 0; }
      g.mode = 'seek';
      g.moved = true;
      setDragging(true);
      const width = Math.max(160, surfaceRef.current?.clientWidth || 320);
      setDragTime(Math.max(0, Math.min(L.duration || 0, g.base + (dx / width) * (L.duration || 0))));
    } else if (g.mode === 'seek') {
      const width = Math.max(160, surfaceRef.current?.clientWidth || 320);
      setDragTime(Math.max(0, Math.min(L.duration || 0, g.base + (dx / width) * (L.duration || 0))));
    } else if (absY > 14 && absY > absX && L.fullscreen && !L.locked && !g.boosting && !g.mode) {
      if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = 0; }
      g.mode = 'vertical';
      g.moved = true;
      const rect = surfaceRef.current?.getBoundingClientRect();
      const leftSide = rect ? e.clientX - rect.left < rect.width / 2 : e.clientX < window.innerWidth / 2;
      const delta = -dy / 220;
      if (leftSide) setBrightness(Math.max(0.35, Math.min(1, g.startBrightness + delta)));
      else changeVolume(Math.max(0, Math.min(1, g.startVolume + delta)));
    }
    wake();
  }, [changeVolume, endBoost, wake]);

  const onSurfaceUp = useCallback((e) => {
    const g = gestureRef.current;
    const point = pointersRef.current.get(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    if (point && (Math.abs(e.clientX - point.x) > 8 || Math.abs(e.clientY - point.y) > 8)) g.moved = true;
    const remaining = pointersRef.current.size;
    const wasMulti = g.multi || remaining > 0;
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = 0; }
    endBoost();
    if (wasMulti) {
      if (!g.moved && remaining === 0 && Date.now() - g.t < 350) setLocked((prev) => !prev);
      if (remaining === 0) {
        g.mode = null;
        g.multi = false;
        g.pinch = 0;
      }
      wake();
      return;
    }
    if (g.mode === 'seek') {
      const currentDrag = latest.current.dragTime;
      const target = Math.max(0, Math.min(latest.current.duration || 0, currentDrag != null ? currentDrag : g.base));
      const v = videoRef.current;
      if (v) { try { v.currentTime = target; } catch (err) {} }
      setCurrentTime(target);
      setDragging(false);
      g.mode = null;
      wake();
      return;
    }
    if (g.mode === 'vertical') {
      g.mode = null;
      wake();
      return;
    }
    if (!g.moved) {
      const now = Date.now();
      const isDouble = now - g.lastTap < 320 && Math.abs(e.clientX - g.lastTapX) < 40 && Math.abs(e.clientY - g.lastTapY) < 40;
      if (isDouble) {
        if (g.tapTimer) { clearTimeout(g.tapTimer); g.tapTimer = 0; }
        g.lastTap = 0;
        if (e.pointerType === 'mouse') toggleFullscreen();
        else {
          const rect = surfaceRef.current?.getBoundingClientRect();
          const left = rect ? e.clientX - rect.left < rect.width / 2 : true;
          seekBy(left ? -10 : 10);
          showFeedback(left ? '-10s' : '+10s');
        }
        wake();
        return;
      }
      g.lastTap = now;
      g.lastTapX = e.clientX;
      g.lastTapY = e.clientY;
      if (g.tapTimer) clearTimeout(g.tapTimer);
      g.tapTimer = setTimeout(() => {
        gestureRef.current.tapTimer = 0;
        const M = latest.current;
        if (M.locked) { setLocked(false); wake(); return; }
        if (!M.dragging && !M.settingsOpen) {
          setShowControls((prev) => !prev);
          armHide();
        }
      }, 270);
    }
    wake();
  }, [armHide, endBoost, seekBy, showFeedback, toggleFullscreen, wake]);

  const onSurfaceCancel = useCallback((e) => {
    pointersRef.current.delete(e.pointerId);
    const g = gestureRef.current;
    g.mode = null;
    g.multi = false;
    g.pinch = 0;
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = 0; }
    endBoost();
    setDragging(false);
    wake();
  }, [endBoost, wake]);

  const playLabel = playing ? 'Pause' : 'Play';
  const iconButton = {
    width: 36, height: 36, borderRadius: 18, border: 'none', cursor: 'pointer', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: '#fff',
  };
  const chipStyle = (active) => ({
    border: `1px solid ${active ? theme.primary : 'rgba(255,255,255,0.35)'}`,
    background: active ? theme.primary : 'rgba(255,255,255,0.08)',
    color: '#fff', borderRadius: 14, padding: '5px 10px', fontSize: 11, fontWeight: 700,
    cursor: 'pointer', minHeight: 28,
  });

  const src = state === 'ready' && fallback ? `${streamUrl(videoId, progItag, token)}&_=${nonce}` : undefined;

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, aspectRatio: fill ? undefined : '16/9', background: '#000', overflow: 'hidden', userSelect: 'none', ...style }}
      onMouseMove={wake}
      onMouseLeave={() => { if (!latest.current.dragging) { setSettingsOpen(false); armHide(); } }}
    >
      <style>{`
        .tp-focus:focus-visible { outline: 2px solid #fff !important; outline-offset: 2px; }
        @keyframes tp-pop { 0% { opacity: 0; transform: translate(-50%, 10px) scale(0.86); } 22% { opacity: 1; transform: translate(-50%, 0) scale(1.05); } 72% { opacity: 1; transform: translate(-50%, -4px) scale(1); } 100% { opacity: 0; transform: translate(-50%, -16px) scale(1); } }
        @media (prefers-reduced-motion: reduce) { .tp-anim { animation: none !important; transition: none !important; } }
      `}</style>
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        controls={false}
        autoPlay={autoPlay}
        muted={muted}
        playsInline
        preload="metadata"
        onCanPlay={handleCanPlay}
        onError={fallback ? () => {
          if (embedFallback && videoId) { setUseEmbed(true); setState('ready'); }
          else { setState('error'); setErrMsg('Playback failed. Check your connection and retry.'); if (onErrorRef.current) onErrorRef.current(new Error('Playback failed')); }
        } : undefined}
        style={{ width: '100%', height: '100%', objectFit: fill ? 'contain' : 'cover', background: '#000', display: useEmbed ? 'none' : 'block', transform: `scale(${zoom})`, transition: reduced ? 'none' : 'transform 180ms ease-out' }}
      />
      {useEmbed && (
        <YouTubeEmbed
          videoId={videoId}
          autoPlay={autoPlay}
          poster={poster}
          fill={fill}
          variant="full"
          style={{ position: 'absolute', inset: 0 }}
          onController={onController}
          onProgress={() => {}}
          onEnded={() => { if (endedHandlerRef.current) endedHandlerRef.current(); }}
          onError={() => {
            if (!videoId) return;
            setUseEmbed(false);
            setState('loading');
            setNativeRetryFor(videoId);
            setNonce((n) => n + 1);
          }}
        />
      )}

      {state === 'loading' && !useEmbed && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3 }}>
          <div className="spinner" style={{ width: 40, height: 40, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: '#fff', borderRadius: '50%' }} />
        </div>
      )}
      {state === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#eee', textAlign: 'center', padding: 24, gap: 12, zIndex: 7 }}>
          <Play size={30} color={theme.primary} />
          <div style={{ fontSize: 13, opacity: 0.85 }}>{errMsg}</div>
          <button className="tp-focus" onClick={() => setNonce((n) => n + 1)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: theme.primary, color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
            <RotateCcw size={14} /> Retry
          </button>
        </div>
      )}

      {state === 'ready' && !useEmbed && controls && (
        <>
          <div
            ref={surfaceRef}
            onPointerDown={onSurfaceDown}
            onPointerMove={onSurfaceMove}
            onPointerUp={onSurfaceUp}
            onPointerCancel={onSurfaceCancel}
            style={{ position: 'absolute', inset: 0, zIndex: 2, cursor: 'pointer', touchAction: fullscreen ? 'none' : 'pan-y' }}
            aria-hidden="true"
          />

          {brightness < 1 && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none', background: '#000', opacity: 1 - brightness }} />
          )}

          {locked && (
            <button
              type="button"
              className="tp-focus"
              onClick={() => { setLocked(false); wake(); }}
              aria-label="Unlock player controls"
              style={{ position: 'absolute', top: 10, left: 10, zIndex: 6, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 16, border: '1px solid rgba(255,255,255,0.55)', background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
            >
              <Lock size={13} /> Controls locked · Unlock
            </button>
          )}

          {toast && (
            <div role="status" style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 8, maxWidth: '86%', padding: '6px 12px', borderRadius: 14, background: 'rgba(0,0,0,0.78)', color: '#fff', fontSize: 12, fontWeight: 600, pointerEvents: 'none', textAlign: 'center' }}>
              {toast}
            </div>
          )}

          {feedback && (
            <div className={reduced ? '' : 'tp-anim'} style={{ position: 'absolute', top: '36%', left: '50%', transform: 'translateX(-50%)', zIndex: 6, padding: '8px 14px', borderRadius: 20, background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: 16, fontWeight: 800, pointerEvents: 'none', animation: reduced ? 'none' : 'tp-pop 750ms ease-out forwards' }}>
              {feedback}
            </div>
          )}

          {buffering && (
            <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', zIndex: 5, pointerEvents: 'none' }}>
              <div className="spinner" style={{ width: 38, height: 38, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: '#fff', borderRadius: '50%' }} />
            </div>
          )}

          {!buffering && (
            <button
              type="button"
              className="tp-focus"
              onClick={togglePlay}
              aria-label={playLabel}
              title={playLabel}
              style={{
                position: 'absolute', left: '50%', top: '50%', zIndex: 5,
                transform: `translate(-50%,-50%) scale(${showControls || !playing ? 1 : 0.8})`,
                opacity: showControls || !playing ? 1 : 0,
                pointerEvents: showControls || !playing ? 'auto' : 'none',
                width: 64, height: 64, borderRadius: 32, border: '1px solid rgba(255,255,255,0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,0,0,0.55)', color: '#fff', cursor: 'pointer',
                transition: `opacity ${motion}, transform ${motion}`, backdropFilter: 'blur(3px)',
              }}
            >
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </button>
          )}

          {nextCandidate && (
            <div style={{ position: 'absolute', right: 12, top: 12, zIndex: 7, width: 'min(280px, 76%)', padding: 12, borderRadius: 12, border: `1px solid ${theme.border || 'rgba(255,255,255,0.25)'}`, background: 'rgba(8,5,14,0.93)', color: '#fff', boxShadow: '0 8px 26px rgba(0,0,0,0.5)' }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>Up next · {nextCount}s</div>
              <div style={{ fontSize: 13, fontWeight: 800, marginTop: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nextCandidate.title}</div>
              {!!nextCandidate.channelTitle && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{nextCandidate.channelTitle}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button type="button" className="tp-focus" onClick={() => { const c = nextCandidate; cancelNext(); if (onNext) onNext(c); }} style={{ flex: 1, padding: '7px 10px', borderRadius: 16, border: 'none', cursor: 'pointer', background: theme.primary, color: '#fff', fontSize: 12, fontWeight: 800 }}>Play now</button>
                <button type="button" className="tp-focus" onClick={cancelNext} style={{ padding: '7px 10px', borderRadius: 16, border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer', background: 'transparent', color: '#fff', fontSize: 12, fontWeight: 700 }}>Cancel</button>
              </div>
            </div>
          )}

          <div
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6,
              background: 'linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0.45) 55%, transparent)',
              padding: '34px 12px 10px',
              opacity: showControls ? 1 : 0,
              pointerEvents: showControls ? 'auto' : 'none',
              transform: showControls ? 'translateY(0)' : 'translateY(8px)',
              transition: `opacity ${motion}, transform ${motion}`,
            }}
          >
            <div
              ref={trackRef}
              className="tp-focus"
              role="slider"
              tabIndex={0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration || 0)}
              aria-valuenow={Math.round(dragging ? dragTime : currentTime)}
              aria-valuetext={`${fmtTime(dragging ? dragTime : currentTime)} of ${fmtTime(duration)}`}
              onPointerDown={onBarDown}
              onPointerMove={onBarMove}
              onPointerUp={onBarUp}
              onPointerCancel={onBarCancel}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekBy(10); }
                else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekBy(-10); }
                else if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); seekBy(-(currentTime || 0)); }
                else if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); seekBy((duration || 0) - (currentTime || 0)); }
              }}
              style={{ position: 'relative', height: 26, display: 'flex', alignItems: 'center', cursor: 'pointer', touchAction: 'none' }}
            >
              <div style={{ position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.3)' }} />
              {buffered.map((range, i) => (
                <div key={i} style={{ position: 'absolute', left: `${(range[0] / (duration || 1)) * 100}%`, width: `${Math.max(0, ((range[1] - range[0]) / (duration || 1)) * 100)}%`, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.55)' }} />
              ))}
              <div style={{ position: 'absolute', left: 0, width: `${((dragging ? dragTime : currentTime) / (duration || 1)) * 100}%`, height: 4, borderRadius: 2, background: theme.primary, transition: dragging || reduced ? 'none' : 'width 120ms linear' }} />
              <div style={{ position: 'absolute', left: `${((dragging ? dragTime : currentTime) / (duration || 1)) * 100}%`, width: 13, height: 13, borderRadius: 7, background: '#fff', transform: 'translateX(-50%)', boxShadow: '0 1px 5px rgba(0,0,0,0.5)', transition: dragging || reduced ? 'none' : 'left 120ms linear' }} />
              {dragging && (
                <div style={{ position: 'absolute', bottom: 24, left: `${((dragTime || 0) / (duration || 1)) * 100}%`, transform: 'translateX(-50%)', padding: '3px 7px', borderRadius: 8, background: 'rgba(0,0,0,0.85)', color: '#fff', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                  {fmtTime(dragTime)}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', rowGap: 2, color: '#fff' }}>
              <button type="button" className="tp-focus" onClick={togglePlay} aria-label={playLabel} title={playLabel} style={{ ...iconButton, flex: '0 0 auto' }}>
                {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
              </button>
              <button type="button" className="tp-focus" onClick={() => { seekBy(-10); showFeedback('-10s'); }} aria-label="Back 10 seconds" title="Back 10 seconds" style={{ ...iconButton, flex: '0 0 auto' }}>
                <SkipBack size={19} />
              </button>
              <button type="button" className="tp-focus" onClick={() => { seekBy(10); showFeedback('+10s'); }} aria-label="Forward 10 seconds" title="Forward 10 seconds" style={{ ...iconButton, flex: '0 0 auto' }}>
                <SkipForward size={19} />
              </button>
              <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', marginLeft: 2 }}>{fmtTime(dragging ? dragTime : currentTime)} / {fmtTime(duration)}</span>
              <div style={{ flex: '1 1 8px', minWidth: 4 }} />
              <button type="button" className="tp-focus" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} style={{ ...iconButton, flex: '0 0 auto' }}>
                {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <input
                className="tp-focus"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onChange={(e) => changeVolume(e.target.value)}
                aria-label="Volume"
                style={{ width: 68, flex: '0 0 auto', accentColor: theme.primary, cursor: 'pointer' }}
              />
              {sleepEnd && (
                <button type="button" className="tp-focus" onClick={() => setSleep(null)} aria-label="Cancel sleep timer" title="Cancel sleep timer" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 14, border: '1px solid rgba(255,255,255,0.45)', background: 'rgba(0,0,0,0.4)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', flex: '0 0 auto' }}>
                  <Moon size={12} /> {sleepEnd.mode === 'end' ? 'End' : fmtClock(sleepLeft)}
                </button>
              )}
              <div style={{ position: 'relative', flex: '0 0 auto' }}>
                <button
                  type="button"
                  className="tp-focus"
                  onClick={() => { setSettingsOpen((v) => !v); wake(); }}
                  aria-label="Player settings"
                  aria-expanded={settingsOpen}
                  title="Player settings"
                  style={{ ...iconButton, color: settingsOpen ? theme.primary : '#fff' }}
                >
                  <SlidersHorizontal size={19} />
                </button>
                {settingsOpen && (
                  <div
                    role="dialog"
                    aria-label="Player settings"
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ position: 'absolute', right: 0, bottom: 44, width: 'min(320px, 78vw)', maxHeight: 'min(62vh, 360px)', overflowY: 'auto', overscrollBehavior: 'contain', background: 'rgba(10,8,16,0.97)', border: `1px solid ${theme.border || 'rgba(255,255,255,0.2)'}`, borderRadius: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.55)', color: '#fff', zIndex: 10 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
                      <span style={{ fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.7 }}>Settings</span>
                      <button type="button" className="tp-focus" onClick={() => { setSettingsOpen(false); wake(); }} aria-label="Close settings" style={{ ...iconButton, width: 26, height: 26, borderRadius: 13 }}>
                        <X size={15} />
                      </button>
                    </div>
                    <div style={{ padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Quality{currentQuality ? ` · ${currentQuality}p` : ''}</div>
                        {levels.length ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <button type="button" className="tp-focus" onClick={() => chooseLevel(-1)} aria-pressed={level < 0} style={chipStyle(level < 0)}>Auto</button>
                            {levels.map((l) => (
                              <button key={l.index} type="button" className="tp-focus" onClick={() => chooseLevel(l.index)} aria-pressed={level === l.index} style={chipStyle(level === l.index)}>{l.height}p</button>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>Quality options are not available from this source.</div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Speed</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {RATES.map((r) => (
                            <button key={r} type="button" className="tp-focus" onClick={() => applyRate(r, true)} aria-pressed={rate === r} style={chipStyle(rate === r)}>{r}x</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Audio track</div>
                        {audioTracks.length ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {audioTracks.map((t) => (
                              <button key={t.id} type="button" className="tp-focus" onClick={() => chooseAudio(t.id)} aria-pressed={audioTrackId === t.id} style={chipStyle(audioTrackId === t.id)}>{t.label}</button>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>Audio tracks are not available from this source.</div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Captions</div>
                        {textTracks.length ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            <button type="button" className="tp-focus" onClick={() => chooseCaption('')} aria-pressed={!selectedCaption} style={chipStyle(!selectedCaption)}>Off</button>
                            {textTracks.map((t) => (
                              <button key={t.id} type="button" className="tp-focus" onClick={() => chooseCaption(t.id)} aria-pressed={selectedCaption === t.id} style={chipStyle(selectedCaption === t.id)}>{t.label}</button>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>Captions are not available from this source.</div>
                        )}
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Sleep timer</div>
                        {sleepEnd && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11, fontWeight: 700 }}>
                            <Moon size={12} />
                            <span>{sleepEnd.mode === 'end' ? 'Pause at end of video' : `${fmtClock(sleepLeft)} remaining`}</span>
                            <button type="button" className="tp-focus" onClick={() => setSleep(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: theme.primary, cursor: 'pointer', fontWeight: 800, fontSize: 11 }}>Cancel</button>
                          </div>
                        )}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {SLEEP_MINUTES.map((m) => (
                            <button key={m} type="button" className="tp-focus" onClick={() => setSleep(m)} style={chipStyle(false)}>{m} min</button>
                          ))}
                          <button type="button" className="tp-focus" onClick={() => setSleep('end')} style={chipStyle(sleepEnd?.mode === 'end')}>End of video</button>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>Autoplay next</div>
                        <button type="button" className="tp-focus" onClick={toggleAutoNext} aria-pressed={autoNext} style={{ ...chipStyle(autoNext), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {autoNext ? <Check size={12} /> : <X size={12} />} {autoNext ? 'On' : 'Off'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="tp-focus"
                onClick={() => { setLocked((prev) => !prev); wake(); }}
                aria-label={locked ? 'Unlock controls' : 'Lock controls'}
                title={locked ? 'Unlock controls' : 'Lock controls'}
                style={{ ...iconButton, flex: '0 0 auto', color: locked ? theme.primary : '#fff' }}
              >
                {locked ? <LockOpen size={18} /> : <Lock size={18} />}
              </button>
              {pipAvailable && (
                <button type="button" className="tp-focus" onClick={togglePip} aria-label={pipOn ? 'Exit picture-in-picture' : 'Picture-in-picture'} title={pipOn ? 'Exit picture-in-picture' : 'Picture-in-picture'} style={{ ...iconButton, flex: '0 0 auto' }}>
                  {pipOn ? <PictureInPicture size={18} /> : <PictureInPicture2 size={18} />}
                </button>
              )}
              <button type="button" className="tp-focus" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} style={{ ...iconButton, flex: '0 0 auto' }}>
                {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
