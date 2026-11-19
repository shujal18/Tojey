import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { RefreshCw, AlertTriangle, ArrowLeft, MoreVertical, Music2, Settings } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';
import { streamUrl, ytEgressBlocked, noteEgressBlocked } from '../components/YoutubePlayer';
import YouTubeEmbed from '../components/YouTubeEmbed';
import { addWatchHistory } from '../components/YoutubeBrowse';
import { getRecommendationSeeds, getWatchedVideoIds } from '../services/recommendation';

const API = import.meta.env.VITE_API_URL || '';
const REEL_CYCLE_SIZE = 50;

const QUALITY_OPTIONS = [
  { label: 'Auto', value: 'auto', maxHeight: 0 },
  { label: '1080p', value: '1080', maxHeight: 1080 },
  { label: '720p', value: '720', maxHeight: 720 },
  { label: '480p', value: '480', maxHeight: 480 },
  { label: '360p', value: '360', maxHeight: 360 },
];

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(trimmed) ? trimmed : null;
}

function avatarUrlFor(item) {
  if (!item) return '';
  const value = item.avatar || item.channelAvatar || item.avatarUrl;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function fmtLen(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function maxHeightFor(value) {
  const found = QUALITY_OPTIONS.find((q) => q.value === value);
  return found ? found.maxHeight : 0;
}

function thumbnailUrlFor(item, quality = 'maxresdefault') {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) {
    return item.thumbnailUrl.trim();
  }
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/${quality}.jpg` : '';
}

function mediaSrc(videoId, token, nonce, quality) {
  const base = streamUrl(videoId, 'best', token, maxHeightFor(quality));
  return nonce ? `${base}&_=${nonce}` : base;
}

async function readJson(response) {
  const type = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
  const html = /html/i.test(type);
  let data = {};
  let parsed = false;
  if (!html) {
    try {
      const value = await response.json();
      if (value && typeof value === 'object') data = value;
      parsed = true;
    } catch (e) {
      parsed = false;
    }
  }
  return { data, parseFailed: html || !parsed };
}

function canUseFeedFallback(response, parseFailed) {
  return parseFailed || response.status === 404 || response.status === 405;
}

function sessionExpiredError() {
  const err = new Error('Session expired. Please sign in again.');
  err.sessionExpired = true;
  return err;
}

function extractItems(data) {
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.videos)) return data.videos;
  return [];
}

async function fetchShortsPayload(baseUrl, request) {
  const response = await fetch(`${baseUrl}/api/shorts/refresh`, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const parsed = await readJson(response);
  if (response.status === 401) throw sessionExpiredError();
  if (canUseFeedFallback(response, parsed.parseFailed)) {
    const feedResponse = await fetch(
      `${baseUrl}/api/shorts/feed?category=${encodeURIComponent(request.category)}&refresh=1`,
      { method: 'GET', headers: request.headers },
    );
    const feedParsed = await readJson(feedResponse);
    if (feedResponse.status === 401) throw sessionExpiredError();
    if (feedParsed.parseFailed) throw new Error('Feed fallback returned an invalid response');
    if (!feedResponse.ok) {
      throw new Error(feedParsed.data.error || feedParsed.data.detail || `Feed request failed (${feedResponse.status})`);
    }
    return { data: feedParsed.data, usedFallback: true };
  }
  if (!response.ok) {
    throw new Error(parsed.data.error || parsed.data.detail || 'Failed to refresh reels');
  }
  return { data: parsed.data, usedFallback: false };
}

const FALLBACK_CATEGORIES = [
  { id: 'trending', label: 'For You' },
  { id: 'romantic', label: 'Romantic/Love' },
  { id: 'foreign', label: 'Foreign' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'funny', label: 'Funny' },
  { id: 'education', label: 'Education' },
  { id: 'motivation', label: 'Motivation' },
  { id: 'meme', label: 'Meme' },
  { id: 'nepali', label: 'Nepali' },
];

export default function ReelsScreen({ token, refreshTick = 0, onBack }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewH, setViewH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 600));
  const [activeSlot, setActiveSlot] = useState(0);
  const [embedVideoId, setEmbedVideoId] = useState(null);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [cycleId, setCycleId] = useState(null);
  const [quality, setQuality] = useState('auto');
  const [speed, setSpeed] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [usingFeedFallback, setUsingFeedFallback] = useState(false);

  const shellRef = useRef(null);
  const toastTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const activeIdxRef = useRef(0);
  const pausedRef = useRef(false);
  const inflightRef = useRef(false);
  const seenVideoIdsRef = useRef(new Set());
  const failedVideoIdsRef = useRef(new Set());
  const currentVideoIdRef = useRef(null);
  const nativeBrokenRef = useRef(ytEgressBlocked());
  const nativeFailStreakRef = useRef(0);
  const embedErrorHandledRef = useRef(false);
  const errorRetriesRef = useRef(new Map());
  const videosRef = useRef([]);
  const isMountedRef = useRef(true);
  const fetchCycleRef = useRef(null);
  const qualityRef = useRef('auto');
  const speedRef = useRef(1);
  const prevRefreshTickRef = useRef(refreshTick);

  const playerElsRef = useRef([null, null]);
  const loadedVideoIdBySlotRef = useRef([null, null]);
  const activeSlotRef = useRef(0);
  const [poolReady, setPoolReady] = useState(false);

  useEffect(() => { videosRef.current = videos; }, [videos]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { qualityRef.current = quality; }, [quality]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    const savedQuality = localStorage.getItem('tojey_reels_quality') || 'auto';
    const savedSpeed = Number(localStorage.getItem('tojey_reels_speed') || '1');
    setQuality(QUALITY_OPTIONS.some((q) => q.value === savedQuality) ? savedQuality : 'auto');
    setSpeed(SPEED_OPTIONS.includes(savedSpeed) ? savedSpeed : 1);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    const el = shellRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      if (isMountedRef.current && el.clientHeight) setViewH(el.clientHeight);
    });
    ro.observe(el);
    if (el.clientHeight) setViewH(el.clientHeight);
    return () => {
      isMountedRef.current = false;
      ro.disconnect();
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/api/shorts/categories`, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('categories'))))
      .then((d) => {
        if (cancelled) return;
        const list = Array.isArray(d.categories) ? d.categories.filter((c) => c && c.id) : [];
        if (list.length) setCategories(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authHeaders]);

  const selectCategory = useCallback((id) => {
    if (id === category) return;
    setCategory(id);
    activeIdxRef.current = 0;
    setActiveIdx(0);
    if (shellRef.current) shellRef.current.scrollTop = 0;
  }, [category]);

  const fetchCycle = useCallback(async (cat, opts = {}) => {
    if (inflightRef.current) return;
    const currentRequestId = ++requestIdRef.current;
    inflightRef.current = true;
    const hadList = videosRef.current.length > 0;
    setLoading(!hadList);
    setRefreshing(hadList);
    setError(null);

    try {
      const seeds = getRecommendationSeeds(8);
      const exclude = Array.from(new Set([
        ...getWatchedVideoIds(250),
        ...seenVideoIdsRef.current,
        ...failedVideoIdsRef.current,
      ])).slice(-300);
      const nonce = opts.nonce || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { data, usedFallback } = await fetchShortsPayload(API, {
        category: cat,
        headers: authHeaders,
        body: { category: cat, seeds, exclude, nonce, requestId: nonce },
      });
      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;

      const ids = new Set();
      const unique = [];
      for (const raw of extractItems(data)) {
        const id = sanitizeVideoId(raw && raw.videoId);
        if (!id || ids.has(id)) continue;
        if (failedVideoIdsRef.current.has(id)) continue;
        ids.add(id);
        unique.push({ ...raw, videoId: id });
        if (unique.length >= REEL_CYCLE_SIZE) break;
      }
      if (!unique.length) throw new Error(data.message || 'No reels available right now');

      unique.forEach((item) => seenVideoIdsRef.current.add(item.videoId));
      videosRef.current = unique;
      setVideos(unique);
      setCycleId(usedFallback ? null : (data.cycleId || null));
      setUsingFeedFallback(usedFallback);
      activeIdxRef.current = 0;
      setActiveIdx(0);
      setPaused(false);
      setEmbedVideoId(null);
      currentVideoIdRef.current = null;
      errorRetriesRef.current.clear();
      nativeFailStreakRef.current = 0;
      nativeBrokenRef.current = ytEgressBlocked();
      loadedVideoIdBySlotRef.current = [null, null];
      if (shellRef.current) shellRef.current.scrollTop = 0;
      showToast(usedFallback ? 'Feed fallback active' : (data.message || ''));
    } catch (e) {
      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;
      setError(e.message);
      showToast(e.message);
    } finally {
      if (isMountedRef.current && currentRequestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
        inflightRef.current = false;
      }
    }
  }, [authHeaders, showToast]);

  useEffect(() => { fetchCycleRef.current = fetchCycle; }, [fetchCycle]);

  useEffect(() => {
    requestIdRef.current += 1;
    inflightRef.current = false;
    seenVideoIdsRef.current.clear();
    failedVideoIdsRef.current.clear();
    if (fetchCycleRef.current) fetchCycleRef.current(category, { nonce: `category-${category}-${Date.now()}` });
  }, [category]);

  useEffect(() => {
    if (!refreshTick || refreshTick === prevRefreshTickRef.current) return;
    prevRefreshTickRef.current = refreshTick;
    failedVideoIdsRef.current.clear();
    if (fetchCycleRef.current) fetchCycleRef.current(category, { nonce: `tick-${refreshTick}-${Date.now()}` });
  }, [refreshTick, category]);

  const refreshCycle = useCallback(() => {
    if (refreshing) return;
    if (fetchCycleRef.current) fetchCycleRef.current(category, { nonce: `refresh-${Date.now()}` });
  }, [category, refreshing]);

  useEffect(() => {
    const handler = () => {
      if (document.hidden && !pausedRef.current) setPaused(true);
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const switchToIndex = useCallback((idx) => {
    const el = shellRef.current;
    if (!el || !viewH) return;
    el.scrollTop = idx * viewH;
  }, [viewH]);

  const playAt = useCallback((idx) => {
    const list = videosRef.current;
    const videoId = sanitizeVideoId(list[idx] && list[idx].videoId);
    if (!videoId) {
      currentVideoIdRef.current = null;
      return;
    }
    if (nativeBrokenRef.current) {
      try { playerElsRef.current[0] && playerElsRef.current[0].pause(); } catch (e) {}
      try { playerElsRef.current[1] && playerElsRef.current[1].pause(); } catch (e) {}
      currentVideoIdRef.current = videoId;
      setEmbedVideoId(videoId);
      return;
    }
    const el0 = playerElsRef.current[0];
    const el1 = playerElsRef.current[1];
    if (!el0 || !el1) return;
    setEmbedVideoId(null);
    const a = activeSlotRef.current;
    const b = 1 - a;
    const alreadyActive = loadedVideoIdBySlotRef.current[a] === videoId;
    const noSlotLoaded = !loadedVideoIdBySlotRef.current[0] && !loadedVideoIdBySlotRef.current[1];
    const target = (alreadyActive || noSlotLoaded) ? a : b;

    const el = target === 0 ? el0 : el1;
    if (loadedVideoIdBySlotRef.current[target] !== videoId) {
      loadedVideoIdBySlotRef.current[target] = videoId;
      el.src = mediaSrc(videoId, token, null, qualityRef.current);
      el.playbackRate = speedRef.current;
      el.load();
    }
    el.playbackRate = speedRef.current;
    if (!pausedRef.current) {
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => {
        el.muted = true;
        el.play().catch(() => {});
      });
    }

    const old = 1 - target;
    const oldEl = old === 0 ? el0 : el1;
    const nextId = sanitizeVideoId(list[idx + 1] && list[idx + 1].videoId);
    if (nextId && nextId !== videoId) {
      if (loadedVideoIdBySlotRef.current[old] !== nextId) {
        loadedVideoIdBySlotRef.current[old] = nextId;
        oldEl.src = mediaSrc(nextId, token, null, qualityRef.current);
        oldEl.playbackRate = speedRef.current;
        oldEl.load();
      }
      oldEl.pause();
    } else if (loadedVideoIdBySlotRef.current[old]) {
      oldEl.pause();
      oldEl.removeAttribute('src');
      oldEl.load();
      loadedVideoIdBySlotRef.current[old] = null;
    }

    currentVideoIdRef.current = videoId;
    activeSlotRef.current = target;
    setActiveSlot(target);
    setTimeout(() => {
      if (nativeBrokenRef.current) return;
      if (currentVideoIdRef.current !== videoId) return;
      if (activeSlotRef.current !== target) return;
      const elCheck = target === 0 ? el0 : el1;
      if (elCheck && elCheck.paused && elCheck.currentTime === 0 && !pausedRef.current) {
        try { elCheck.play().catch(() => {}); } catch (e) {}
      }
    }, 300);
  }, [token]);

  const handleEnded = useCallback(() => {
    if (pausedRef.current) return;
    const cur = activeIdxRef.current;
    const nextItem = videosRef.current[cur + 1];
    if (nextItem) {
      switchToIndex(cur + 1);
    } else {
      showToast('You reached the end of this 50-reel cycle');
    }
  }, [showToast, switchToIndex]);

  const handleVideoError = useCallback((slot) => {
    const el = playerElsRef.current[slot];
    const vid = loadedVideoIdBySlotRef.current[slot];
    if (!el || !vid) return;
    const retries = errorRetriesRef.current.get(vid) || 0;

    if (!nativeBrokenRef.current && slot === activeSlotRef.current && retries < 1) {
      errorRetriesRef.current.set(vid, retries + 1);
      el.src = mediaSrc(vid, token, Date.now(), qualityRef.current);
      el.playbackRate = speedRef.current;
      el.load();
      if (!pausedRef.current) el.play().catch(() => {});
      return;
    }

    errorRetriesRef.current.set(vid, retries + 1);
    failedVideoIdsRef.current.add(vid);
    nativeFailStreakRef.current += 1;
    if (nativeFailStreakRef.current >= 3) {
      nativeBrokenRef.current = true;
      noteEgressBlocked();
    }
    loadedVideoIdBySlotRef.current[slot] = null;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}

    if (slot !== activeSlotRef.current) return;
    currentVideoIdRef.current = null;
    const cur = activeIdxRef.current;
    if (cur + 1 < videosRef.current.length) {
      switchToIndex(cur + 1);
      showToast('Skipped an unavailable Short');
    } else if (nativeBrokenRef.current) {
      setEmbedVideoId(vid);
    } else {
      showToast('This Short is unavailable');
    }
  }, [showToast, switchToIndex, token]);

  const handleSlotEnded = useCallback((slot) => {
    if (slot === activeSlotRef.current) handleEnded();
  }, [handleEnded]);

  const handleSlotError = useCallback((slot) => {
    handleVideoError(slot);
  }, [handleVideoError]);

  useEffect(() => {
    if (!poolReady || videos.length === 0) return;
    const idx = activeIdxRef.current;
    const vid = sanitizeVideoId(videos[idx] && videos[idx].videoId);
    if (vid && currentVideoIdRef.current === vid) return;
    playAt(idx);
  }, [videos, playAt, poolReady]);

  useEffect(() => {
    if (!poolReady || videos.length === 0) return;
    playAt(activeIdx);
  }, [activeIdx, playAt, poolReady]);

  useEffect(() => () => {
    try { playerElsRef.current[0] && playerElsRef.current[0].pause(); } catch (e) {}
    try { playerElsRef.current[1] && playerElsRef.current[1].pause(); } catch (e) {}
    loadedVideoIdBySlotRef.current = [null, null];
    activeSlotRef.current = 0;
  }, []);

  useEffect(() => {
    if (!poolReady) return;
    const el = playerElsRef.current[activeSlotRef.current];
    if (!el) return;
    el.playbackRate = speedRef.current;
    if (paused) {
      try { el.pause(); } catch (e) {}
    } else if (currentVideoIdRef.current) {
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => {
        el.muted = true;
        el.play().catch(() => {});
      });
    }
  }, [paused, poolReady, speed]);

  useEffect(() => {
    const nextItem = videos[activeIdx + 1];
    const nextId = nextItem && sanitizeVideoId(nextItem.videoId);
    if (!nextId) return;
    const img = new Image();
    img.src = thumbnailUrlFor(nextItem, 'maxresdefault');
  }, [activeIdx, videos]);

  useEffect(() => {
    setProgress({ current: 0, duration: 0 });
    embedErrorHandledRef.current = false;
  }, [activeIdx, embedVideoId]);

  useEffect(() => {
    setPaused(false);
    setMenuOpen(false);
    setCaptionExpanded(false);
  }, [activeIdx]);

  const handleEmbedError = useCallback((code) => {
    if (embedErrorHandledRef.current) return;
    if (code !== 100 && code !== 101 && code !== 150) {
      showToast('Playback error — swipe to continue');
      return;
    }
    embedErrorHandledRef.current = true;
    const list = videosRef.current;
    const cur = activeIdxRef.current;
    const item = list[cur];
    if (item && item.videoId) failedVideoIdsRef.current.add(item.videoId);
    if (cur + 1 < list.length) {
      switchToIndex(cur + 1);
      showToast('Skipped an unavailable Short');
    } else {
      showToast('This Short is unavailable');
    }
  }, [showToast, switchToIndex]);

  useEffect(() => {
    const item = videos[activeIdx];
    if (!item || !item.videoId) return;
    seenVideoIdsRef.current.add(item.videoId);
    addWatchHistory({
      videoId: item.videoId,
      title: item.title,
      thumbnailUrl: thumbnailUrlFor(item),
      channelTitle: item.channelTitle || item.author,
      durationSeconds: item.durationSeconds,
    });
  }, [videos, activeIdx]);

  const handleScroll = useCallback(() => {
    const el = shellRef.current;
    if (!el || !viewH) return;
    const y = el.scrollTop;
    const idx = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / viewH)));
    if (idx !== activeIdxRef.current) {
      activeIdxRef.current = idx;
      setActiveIdx(idx);
    }
  }, [viewH]);

  const handleTap = useCallback(() => {
    const next = !pausedRef.current;
    if (!next) {
      const el = playerElsRef.current[activeSlotRef.current];
      if (el) el.muted = false;
    }
    setPaused(next);
  }, []);

  const selectQuality = useCallback((value) => {
    setQuality(value);
    localStorage.setItem('tojey_reels_quality', value);
    qualityRef.current = value;
    loadedVideoIdBySlotRef.current = [null, null];
    nativeBrokenRef.current = ytEgressBlocked();
    setEmbedVideoId(null);
    setSettingsOpen(false);
    if (poolReady) playAt(activeIdxRef.current);
  }, [playAt, poolReady]);

  const selectSpeed = useCallback((value) => {
    setSpeed(value);
    localStorage.setItem('tojey_reels_speed', String(value));
    speedRef.current = value;
    playerElsRef.current.forEach((el) => { if (el) el.playbackRate = value; });
    setSettingsOpen(false);
  }, []);

  const activeItem = videos[activeIdx];
  const creatorArtwork = avatarUrlFor(activeItem);
  const activeVideoId = sanitizeVideoId(activeItem && activeItem.videoId);
  const audioArt = activeVideoId ? thumbnailUrlFor(activeItem) : '';
  const overlayVideoId = activeVideoId && !failedVideoIdsRef.current.has(activeVideoId)
    ? activeVideoId
    : null;

  const WINDOW = 3;
  const windowStart = Math.max(0, activeIdx - WINDOW);
  const windowEnd = Math.min(videos.length, activeIdx + WINDOW + 1);

  return (
    <div style={{ minHeight: '100vh', width: '100%', display: 'flex', flexDirection: 'column', background: '#000', position: 'relative', overflow: 'hidden', overflowX: 'hidden' }}>
      {loading && videos.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
          <RefreshCw size={32} color="#fff" className="spin" style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : error && videos.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, background: theme.background }}>
          <AlertTriangle size={48} color={theme.danger} />
          <div style={{ color: theme.text, fontSize: 15, textAlign: 'center' }}>{error}</div>
          <button onClick={refreshCycle} style={{
            padding: '10px 24px', borderRadius: 10, border: 'none', background: theme.primary, color: '#fff', fontWeight: 600, cursor: 'pointer',
          }}>
            Retry
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', background: '#000', minHeight: 0, position: 'relative' }}>
          <div style={{
            position: 'relative', height: '100%', aspectRatio: '9 / 16', maxWidth: '100%',
            flex: '0 0 auto', background: '#000', overflow: 'hidden',
          }}>
            <div
              ref={shellRef}
              onClick={handleTap}
              onScroll={handleScroll}
              style={{
                position: 'static', width: '100%', height: '100%',
                overflowY: 'scroll', scrollSnapType: 'y mandatory', background: '#000',
                cursor: 'pointer', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none',
              }}
            >
              <style>{'::-webkit-scrollbar{display:none}'}</style>
              {windowStart > 0 && <div style={{ height: windowStart * viewH }} />}
              {videos.slice(windowStart, windowEnd).map((item, i) => {
                const index = windowStart + i;
                const thumb = thumbnailUrlFor(item);
                const isActive = index === activeIdx;
                const vid = sanitizeVideoId(item.videoId);
                return (
                  <div key={item.videoId} style={{ height: viewH, scrollSnapAlign: 'start', position: 'relative', background: '#000' }}>
                    {vid ? (
                      <div style={{
                        position: 'absolute', inset: 0, backgroundImage: `url(${thumb})`, backgroundSize: 'cover',
                        backgroundPosition: 'center', backgroundRepeat: 'no-repeat', opacity: isActive ? 0 : 1,
                      }} />
                    ) : (
                      <div style={{ position: 'absolute', inset: 0, background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>Unavailable</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {windowEnd < videos.length && <div style={{ height: (videos.length - windowEnd) * viewH }} />}
              {videos.length === 0 && !loading && (
                <div style={{ height: viewH, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 40 }}>
                  <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 15, textAlign: 'center' }}>
                    {toast || 'No videos available right now'}
                  </div>
                  <button onClick={refreshCycle} style={{
                    padding: '10px 24px', borderRadius: 10, border: 'none', background: theme.primary, color: '#fff', fontWeight: 600, cursor: 'pointer',
                  }}>
                    Refresh Reels
                  </button>
                </div>
              )}

              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: viewH, pointerEvents: 'none', zIndex: 4, background: '#000' }}>
                <video
                  ref={el => {
                    playerElsRef.current[0] = el;
                    if (playerElsRef.current[0] && playerElsRef.current[1] && !poolReady) setPoolReady(true);
                  }}
                  playsInline preload="auto" muted webkit-playsinline="true"
                  onCanPlay={(e) => {
                    if (activeSlotRef.current === 0 && !pausedRef.current && loadedVideoIdBySlotRef.current[0] === currentVideoIdRef.current) {
                      e.currentTarget.play().catch(() => {});
                    }
                  }}
                  onEnded={() => handleSlotEnded(0)}
                  onError={() => handleSlotError(0)}
                  onTimeUpdate={(e) => {
                    if (activeSlotRef.current !== 0) return;
                    const v = e.currentTarget;
                    setProgress({ current: v.currentTime || 0, duration: Number.isFinite(v.duration) ? v.duration : 0 });
                  }}
                  style={{
                    position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain',
                    background: '#000', zIndex: activeSlot === 0 ? 3 : 2, pointerEvents: 'none',
                  }}
                />
                <video
                  ref={el => {
                    playerElsRef.current[1] = el;
                    if (playerElsRef.current[0] && playerElsRef.current[1] && !poolReady) setPoolReady(true);
                  }}
                  playsInline preload="auto" muted webkit-playsinline="true"
                  onCanPlay={(e) => {
                    if (activeSlotRef.current === 1 && !pausedRef.current && loadedVideoIdBySlotRef.current[1] === currentVideoIdRef.current) {
                      e.currentTarget.play().catch(() => {});
                    }
                  }}
                  onEnded={() => handleSlotEnded(1)}
                  onError={() => handleSlotError(1)}
                  onTimeUpdate={(e) => {
                    if (activeSlotRef.current !== 1) return;
                    const v = e.currentTarget;
                    setProgress({ current: v.currentTime || 0, duration: Number.isFinite(v.duration) ? v.duration : 0 });
                  }}
                  style={{
                    position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain',
                    background: '#000', zIndex: activeSlot === 1 ? 3 : 2, pointerEvents: 'none',
                  }}
                />
                {embedVideoId && (
                  <YouTubeEmbed
                    videoId={embedVideoId}
                    autoPlay
                    variant="short"
                    loop
                    paused={paused}
                    onProgress={(current, duration) => setProgress({ current, duration: Number.isFinite(duration) ? duration : 0 })}
                    onError={handleEmbedError}
                    style={{ position: 'absolute', inset: 0, zIndex: 4 }}
                  />
                )}

                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, zIndex: 7, background: 'rgba(255,255,255,0.25)', pointerEvents: 'none' }}>
                  <div style={{ height: '100%', width: `${progress.duration ? Math.min(100, (progress.current / progress.duration) * 100) : 0}%`, background: '#fff', transition: 'width 0.25s linear' }} />
                </div>

                {paused && overlayVideoId && (
                  <div style={{ position: 'absolute', inset: 0, zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.18)', pointerEvents: 'none' }}>
                    <div style={{ width: 72, height: 72, borderRadius: 36, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 0, height: 0, borderLeft: '22px solid #fff', borderTop: '13px solid transparent', borderBottom: '13px solid transparent', marginLeft: 5 }} />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 120, zIndex: 5, pointerEvents: 'none', background: 'linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 190, zIndex: 5, pointerEvents: 'none', background: 'linear-gradient(to top, rgba(0,0,0,0.88), rgba(0,0,0,0))' }} />

              {overlayVideoId && activeItem ? (
                <>
                  <div style={{ position: 'absolute', left: 16, bottom: 20, width: 'calc(100% - 88px)', zIndex: 6 }}>
                    {activeItem.channelTitle || activeItem.channelId ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        {creatorArtwork ? (
                          <img src={creatorArtwork} alt="" style={{ width: 28, height: 28, borderRadius: 14, objectFit: 'cover' }} />
                        ) : (
                          <div style={{ width: 28, height: 28, borderRadius: 14, background: 'rgba(255,255,255,0.24)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800 }}>
                            {(activeItem.channelTitle || '?').trim().charAt(0).toUpperCase()}
                          </div>
                        )}
                        {activeItem.channelTitle ? (
                          <span style={{ color: '#fff', fontSize: 13, fontWeight: 700, textShadow: '0 1px 6px rgba(0,0,0,0.9)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {activeItem.channelTitle}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); setCaptionExpanded((value) => !value); }}
                      style={{
                        color: '#fff', fontSize: 14, fontWeight: 600, lineHeight: 1.35, cursor: 'pointer',
                        textShadow: '0 1px 6px rgba(0,0,0,0.9)',
                        overflow: captionExpanded ? 'visible' : 'hidden',
                        display: captionExpanded ? 'block' : '-webkit-box',
                        WebkitLineClamp: captionExpanded ? undefined : 3,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {activeItem.title || ''}
                    </div>
                    {captionExpanded ? (
                      <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 6, textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>
                        {fmtLen(activeItem.durationSeconds || progress.duration)}
                        {usingFeedFallback ? '  -  Feed fallback active' : ''}
                      </div>
                    ) : null}
                  </div>
                  <div title="Audio" style={{ position: 'absolute', right: 16, bottom: 20, width: 40, height: 40, borderRadius: 12, zIndex: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.16)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                    {audioArt ? (
                      <img src={audioArt} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <Music2 size={18} />
                    )}
                  </div>
                </>
              ) : null}
            </div>

            {onBack && (
              <button onClick={(e) => { e.stopPropagation(); onBack(); }} title="Back" style={{
                position: 'absolute', top: 14, left: 12, zIndex: 50,
                width: 38, height: 38, borderRadius: 19,
                background: 'rgba(0,0,0,0.55)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', cursor: 'pointer',
              }}>
                <ArrowLeft size={20} />
              </button>
            )}

            <div style={{ position: 'absolute', top: 14, right: 12, zIndex: 50 }}>
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen((value) => !value); }}
                title="More options"
                aria-label="More options"
                style={{
                  width: 38, height: 38, borderRadius: 19, background: 'rgba(0,0,0,0.55)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer',
                }}
              >
                <MoreVertical size={20} />
              </button>
              {menuOpen ? (
                <div style={{
                  marginTop: 8, width: 208, borderRadius: 14, padding: '6px 0', zIndex: 51,
                  background: 'rgba(18,18,22,0.94)', color: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); setSettingsOpen(true); }}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', border: 'none', background: 'transparent', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}
                  >
                    <Settings size={18} /> Quality & speed
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(false); refreshCycle(); }}
                    disabled={refreshing}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', border: 'none', background: 'transparent', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}
                  >
                    <RefreshCw size={18} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing...' : 'Refresh feed'}
                  </button>
                  <div style={{ height: 1, background: 'rgba(255,255,255,0.14)', margin: '4px 0' }} />
                  <div style={{ padding: '8px 14px', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                    {videos.length ? `${activeIdx + 1}/${videos.length} in cycle` : 'No cycle loaded'}
                    {usingFeedFallback ? ' - feed fallback active' : ''}
                  </div>
                </div>
              ) : null}
            </div>

            {activeIdx === videos.length - 1 && videos.length > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); refreshCycle(); }}
                disabled={refreshing}
                style={{
                  position: 'absolute', bottom: 96, left: '50%', transform: 'translateX(-50%)', zIndex: 50,
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 24,
                  border: 'none', background: theme.primary, color: '#fff', fontWeight: 700, cursor: 'pointer',
                }}
              >
                <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
                {refreshing ? 'Refreshing...' : 'Refresh Reels'}
              </button>
            )}
          </div>

          {refreshing && videos.length > 0 && (
            <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 45, pointerEvents: 'none' }}>
              <RefreshCw size={20} color="rgba(255,255,255,0.8)" style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}
        </div>
      )}

      {settingsOpen && (
        <div
          onClick={(e) => { e.stopPropagation(); setSettingsOpen(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 420, borderRadius: 18, padding: 20, background: theme.surface || '#1E1A27', color: theme.text || '#fff' }}
          >
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 14 }}>Video settings</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.textSecondary || '#B9B3C6', marginBottom: 10 }}>Quality</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {QUALITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => selectQuality(option.value)}
                  style={{
                    padding: '8px 12px', borderRadius: 16, border: `1px solid ${quality === option.value ? theme.primary : '#443E52'}`,
                    background: 'transparent', color: quality === option.value ? theme.primary : '#fff', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: theme.textSecondary || '#B9B3C6', marginTop: 16, marginBottom: 10 }}>Speed</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {SPEED_OPTIONS.map((option) => (
                <button
                  key={option}
                  onClick={() => selectSpeed(option)}
                  style={{
                    padding: '8px 12px', borderRadius: 16, border: `1px solid ${speed === option ? theme.primary : '#443E52'}`,
                    background: 'transparent', color: speed === option ? theme.primary : '#fff', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  {option}x
                </button>
              ))}
            </div>
            <div style={{ marginTop: 16, fontSize: 11, color: '#9A93A8', textAlign: 'center' }}>
              {usingFeedFallback
                ? 'Feed fallback active - no cycle id from server'
                : `Cycle ${cycleId ? 'ready' : 'loading'} — ${REEL_CYCLE_SIZE} reels per refresh`}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div onClick={() => setToast('')} style={{
          position: 'absolute', bottom: 78, left: 24, right: 24, zIndex: 60,
          background: 'rgba(20,20,26,0.92)', color: '#fff', padding: '10px 14px', borderRadius: 10,
          fontSize: 13, textAlign: 'center', cursor: 'pointer', boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
