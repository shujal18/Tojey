import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { RefreshCw, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';
import { streamUrl, ytEgressBlocked, noteEgressBlocked } from '../components/YoutubePlayer';
import YouTubeEmbed from '../components/YouTubeEmbed';

const API = import.meta.env.VITE_API_URL || '';

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

// "0:55" style length for the caption.
function fmtLen(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function thumbnailUrlFor(item, quality = 'hqdefault') {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) {
    return item.thumbnailUrl.trim();
  }
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/${quality}.jpg` : '';
}

function mediaSrc(videoId, token, nonce) {
  // `itag=best` never matches a real itag, so the proxy's pickFormat falls
  // through to the highest muxed (video+audio) format.
  const base = streamUrl(videoId, 'best', token);
  return nonce ? `${base}&_=${nonce}` : base;
}

// Mirrors backend/src/shortsFeed.js CATEGORIES so the chip row renders instantly
// (and still renders if the categories request fails offline).
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
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewH, setViewH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 600));
  const [loadMoreSpinner, setLoadMoreSpinner] = useState(false);
  const [activeSlot, setActiveSlot] = useState(0);
  // When the native proxy can't play the active short (e.g. the backend's
  // datacenter IP is flagged by YouTube), we show the official embed for it
  // instead of skipping. Cleared every time the active clip changes.
  const [embedVideoId, setEmbedVideoId] = useState(null);
  // Playback position/length for the thin Shorts progress bar.
  const [progress, setProgress] = useState({ current: 0, duration: 0 });

  const shellRef = useRef(null);
  const toastTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const activeIdxRef = useRef(0);
  const pausedRef = useRef(false);
  const inflightRef = useRef(false);
  const seenVideoIdsRef = useRef(new Set());
  const failedVideoIdsRef = useRef(new Set());
  const currentVideoIdRef = useRef(null);
  // Set once native playback proves broken (e.g. the backend's egress IP is
  // blocked by YouTube). Every clip fails identically, so later clips go
  // straight to the embed instead of re-trying the proxy for each one. Pre-seeded
  // from the shared memo so entering Shorts after a blocked watch video is instant.
  const nativeBrokenRef = useRef(ytEgressBlocked());
  // Guards the embed's onError so one unavailable Short is skipped at most once.
  const embedErrorHandledRef = useRef(false);

  const videosRef = useRef([]);
  const nextPageTokenRef = useRef(null);
  const hasMoreRef = useRef(true);
  const isMountedRef = useRef(true);

  // Two native <video> slots, both fed by the backend byte proxy. Slot A is
  // visible and playing; slot B is preloading the next clip so a swipe starts
  // instantly.
  const playerElsRef = useRef([null, null]);
  const loadedVideoIdBySlotRef = useRef([null, null]);
  const activeSlotRef = useRef(0);
  // Flips true once both <video> slots are mounted. Refs alone can't wake the
  // effects above (they don't re-render), so this state does it.
  const [poolReady, setPoolReady] = useState(false);

  useEffect(() => { videosRef.current = videos; }, [videos]);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    isMountedRef.current = true;
    const el = shellRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (isMountedRef.current && el.clientHeight) setViewH(el.clientHeight);
    });
    ro.observe(el);
    if (el.clientHeight) setViewH(el.clientHeight);
    return () => {
      isMountedRef.current = false;
      ro.disconnect();
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
    const el = shellRef.current;
    if (el) el.scrollTop = 0;
  }, [category]);

  const fetchFeed = useCallback(async (cat, opts = {}) => {
    if (inflightRef.current) return;
    const { refresh = false, append = false, pageToken = null } = opts;
    const currentRequestId = ++requestIdRef.current;
    inflightRef.current = true;
    if (!append) setLoading(true);
    if (append) setLoadMoreSpinner(true);
    setError(null);

    try {
      // /api/shorts/* is our own innertube feed; the old /api/reels/feed was the
      // YouTube Data API path and is gone. Its params and response field names
      // differ: `nextToken` (not `pageToken`) and `items` (not `videos`).
      const queryParts = [`category=${encodeURIComponent(cat)}`, `refresh=${refresh ? 'true' : 'false'}`];
      if (pageToken) queryParts.push(`nextToken=${encodeURIComponent(pageToken)}`);
      const qs = queryParts.join('&');

      if (!append && !pageToken && !refresh) {
        // v2: the feed source changed from the YouTube Data API to our own
        // innertube feed, so v1 entries (which could hold 3-to-130-minute
        // uploads) must not be reused.
        const cacheKey = `tojey_reels_cache_v2_${cat}`;
        try {
          const cachedRaw = localStorage.getItem(cacheKey);
          if (cachedRaw) {
            const cached = JSON.parse(cachedRaw);
            const timestamp = cached.timestamp || 0;
            if (Array.isArray(cached.videos) && cached.videos.length > 0 && Date.now() - timestamp < 30 * 60 * 1000) {
              const valid = cached.videos.filter(v => v.videoId && !failedVideoIdsRef.current.has(v.videoId));
              if (valid.length > 0) {
                const unseen = valid.filter(v => !seenVideoIdsRef.current.has(v.videoId));
                const toUse = unseen.length >= 3 ? unseen : valid;
                const rotateBy = Math.min(seenVideoIdsRef.current.size, toUse.length - 1);
                const rotated = rotateBy > 0 ? [...toUse.slice(rotateBy), ...toUse.slice(0, rotateBy)] : toUse;
                rotated.forEach(v => seenVideoIdsRef.current.add(v.videoId));
                videosRef.current = rotated;
                setVideos(rotated);
                activeIdxRef.current = 0;
                setActiveIdx(0);
                currentVideoIdRef.current = null;
                if (shellRef.current) shellRef.current.scrollTop = 0;
              }
            }
          }
        } catch (e) {}
      }

      const res = await fetch(`${API}/api/shorts/feed?${qs}`, { headers: authHeaders });
      const data = await res.json();

      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load feed');

      let validVideos = (data.items || []).filter(v =>
        v.videoId && typeof v.videoId === 'string' && v.videoId.trim().length > 0 &&
        !failedVideoIdsRef.current.has(v.videoId)
      );

      if (!append && !pageToken && !refresh) {
        const unseen = validVideos.filter(v => !seenVideoIdsRef.current.has(v.videoId));
        const toUse = unseen.length >= 3 ? unseen : validVideos;
        const rotateBy = Math.min(seenVideoIdsRef.current.size, toUse.length - 1);
        validVideos = rotateBy > 0 ? [...toUse.slice(rotateBy), ...toUse.slice(0, rotateBy)] : toUse;
      }
      validVideos.forEach(v => seenVideoIdsRef.current.add(v.videoId));

      if (append) {
        setVideos(prev => {
          const existingIds = new Set(prev.map(v => v.videoId));
          const merged = [...prev, ...validVideos.filter(v => !existingIds.has(v.videoId))];
          videosRef.current = merged;
          return merged;
        });
      } else {
        videosRef.current = validVideos;
        setVideos(validVideos);
        activeIdxRef.current = 0;
        setActiveIdx(0);
        setPaused(false);
        currentVideoIdRef.current = null;
        if (shellRef.current) shellRef.current.scrollTop = 0;
        if (!refresh && !pageToken && validVideos.length > 0) {
          try {
            localStorage.setItem(`tojey_reels_cache_v2_${cat}`, JSON.stringify({ videos: validVideos, timestamp: Date.now() }));
          } catch (e) {}
        }
      }

      nextPageTokenRef.current = data.nextToken || null;
      hasMoreRef.current = data.hasMore === true;
      if (data.warning) showToast(data.warning);
    } catch (e) {
      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;
      setError(e.message);
      showToast(e.message);
    } finally {
      if (isMountedRef.current && currentRequestId === requestIdRef.current) {
        setLoading(false);
        setLoadMoreSpinner(false);
        inflightRef.current = false;
      }
    }
  }, [authHeaders, showToast]);

  const loadMore = useCallback(() => {
    const tokenToUse = nextPageTokenRef.current;
    if (!tokenToUse || !hasMoreRef.current || inflightRef.current) return;
    fetchFeed(category, { append: true, pageToken: tokenToUse });
  }, [category, fetchFeed]);

  useEffect(() => {
    // Switch request generation BEFORE fetching so any in-flight fetch from the
    // previous category is ignored when it resolves (its requestId is now stale) and
    // the new category fetch isn't blocked by the old one's inflight guard.
    requestIdRef.current += 1;
    inflightRef.current = false;
    seenVideoIdsRef.current.clear();
    nextPageTokenRef.current = null;
    hasMoreRef.current = true;
    fetchFeed(category, {});
  }, [category, fetchFeed]);

  const prevRefreshTickRef = useRef(0);
  useEffect(() => {
    if (!refreshTick || refreshTick === prevRefreshTickRef.current) return;
    prevRefreshTickRef.current = refreshTick;
    seenVideoIdsRef.current.clear();
    failedVideoIdsRef.current.clear();
    nextPageTokenRef.current = null;
    hasMoreRef.current = true;
    fetchFeed(category, { refresh: true });
  }, [refreshTick, category, fetchFeed]);

  useEffect(() => {
    const handler = () => {
      if (document.hidden && !pausedRef.current) {
        setPaused(true);
      }
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
    // Known-broken native path: show the embed for this clip immediately.
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
    const target = alreadyActive ? a : b;

    const el = target === 0 ? el0 : el1;
    if (loadedVideoIdBySlotRef.current[target] !== videoId) {
      loadedVideoIdBySlotRef.current[target] = videoId;
      el.src = mediaSrc(videoId, token);
      el.load();
    }
    if (!pausedRef.current) {
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => {
        // No user activation yet (autoplay policy): fall back to muted so the
        // feed still moves, and unmute on the first tap in handleTap.
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
        oldEl.src = mediaSrc(nextId, token);
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
  }, [token]);

  const handleEnded = useCallback(() => {
    if (pausedRef.current) return;
    const cur = activeIdxRef.current;
    const nextItem = videosRef.current[cur + 1];
    if (nextItem) {
      switchToIndex(cur + 1);
    } else if (videosRef.current[cur]) {
      const el = playerElsRef.current[activeSlotRef.current];
      if (el) {
        try { el.currentTime = 0; el.play(); } catch (e) {}
      }
    }
  }, [switchToIndex]);

  // Retry once with a cache-busting query (forces the proxy to re-resolve a
  // possibly-expired upstream URL). If it still fails, fall back to the official
  // YouTube embed: the embed plays from the viewer's own IP, so it works even
  // when the backend's IP is flagged.
  const errorRetriesRef = useRef(0);
  const handleVideoError = useCallback((slot) => {
    const el = playerElsRef.current[slot];
    const vid = loadedVideoIdBySlotRef.current[slot];
    if (!el || !vid) return;
    if (!nativeBrokenRef.current && slot === activeSlotRef.current && errorRetriesRef.current < 1) {
      errorRetriesRef.current += 1;
      const fresh = mediaSrc(vid, token, Date.now());
      el.src = fresh;
      el.load();
      if (!pausedRef.current) el.play().catch(() => {});
      return;
    }
    errorRetriesRef.current = 0;
    nativeBrokenRef.current = true;
    noteEgressBlocked();
    loadedVideoIdBySlotRef.current[slot] = null;
    try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) {}
    // Only the visible slot drives the embed; a preload-slot failure just flips
    // the flag so the clip embeds the moment it becomes active.
    if (slot === activeSlotRef.current) {
      currentVideoIdRef.current = null;
      setEmbedVideoId(vid);
    }
  }, [token]);

  const handleSlotEnded = useCallback((slot) => {
    if (slot !== activeSlotRef.current) return;
    handleEnded();
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
    if (paused) {
      try { el.pause(); } catch (e) {}
    } else if (currentVideoIdRef.current) {
      const pr = el.play();
      if (pr && pr.catch) pr.catch(() => {
        el.muted = true;
        el.play().catch(() => {});
      });
    }
  }, [paused, poolReady]);

  useEffect(() => {
    const nextItem = videos[activeIdx + 1];
    const nextId = nextItem && sanitizeVideoId(nextItem.videoId);
    if (!nextId) return;
    const img = new Image();
    img.src = thumbnailUrlFor(nextItem, 'maxresdefault');
  }, [activeIdx, videos]);

  // Reset the progress bar / error guard whenever the active clip changes.
  useEffect(() => {
    setProgress({ current: 0, duration: 0 });
    embedErrorHandledRef.current = false;
  }, [activeIdx, embedVideoId]);

  // Swiping to another Short always resumes playback (like the YouTube app).
  useEffect(() => {
    setPaused(false);
  }, [activeIdx]);

  // The embed reports YouTube error codes: 100/101/150 mean the video is gone or
  // embedding is disallowed → skip it. Anything else is surfaced, not skipped.
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

  const handleScroll = useCallback(() => {
    const el = shellRef.current;
    if (!el || !viewH) return;
    const y = el.scrollTop;
    const idx = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / viewH)));
    if (idx !== activeIdxRef.current) {
      activeIdxRef.current = idx;
      setActiveIdx(idx);
    }
    if (idx >= videosRef.current.length - 3) loadMore();
  }, [viewH, loadMore]);

  const handleTap = useCallback(() => {
    const next = !pausedRef.current;
    // Resuming is a user gesture, so it's where we restore sound after a
    // muted-autoplay fallback.
    if (!next) {
      const el = playerElsRef.current[activeSlotRef.current];
      if (el) el.muted = false;
    }
    setPaused(next);
  }, []);

  const activeItem = videos[activeIdx];
  const activeVideoId = sanitizeVideoId(activeItem && activeItem.videoId);
  const overlayVideoId = activeVideoId && !failedVideoIdsRef.current.has(activeVideoId)
    ? activeVideoId
    : null;

  const WINDOW = 3;
  const windowStart = Math.max(0, activeIdx - WINDOW);
  const windowEnd = Math.min(videos.length, activeIdx + WINDOW + 1);

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#000', position: 'relative', overflow: 'hidden' }}
    >
      {loading && videos.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.background }}>
          <RefreshCw size={32} color={theme.primary} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
        </div>
      ) : error && videos.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, background: theme.background }}>
          <AlertTriangle size={48} color={theme.danger} />
          <div style={{ color: theme.text, fontSize: 15, textAlign: 'center' }}>{error}</div>
          <button onClick={() => fetchFeed(category, { refresh: true })} style={{
            padding: '10px 24px', borderRadius: 10, border: 'none', background: theme.primary, color: '#fff', fontWeight: 600, cursor: 'pointer',
          }}>
            Retry
          </button>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', background: '#000', minHeight: 0, position: 'relative' }}>
          {/* Centered portrait (9:16) viewing area, like the YouTube Shorts
              player. On phones it just fills the available width. */}
          <div style={{
            position: 'relative', height: '100%', aspectRatio: '9 / 16', maxWidth: '100%',
            flex: '0 0 auto', background: '#000', overflow: 'hidden',
          }}>
            <div
              ref={shellRef}
              onClick={handleTap}
              onScroll={handleScroll}
              style={{
                position: 'absolute', inset: 0,
                overflowY: 'scroll',
                scrollSnapType: 'y mandatory',
                background: '#000',
                cursor: 'pointer',
                WebkitOverflowScrolling: 'touch',
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
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
                  <div
                    key={item.videoId}
                    style={{
                      height: viewH,
                      scrollSnapAlign: 'start',
                      position: 'relative',
                      background: '#000',
                    }}
                  >
                    {vid ? (
                      <div
                        style={{
                          position: 'absolute', inset: 0,
                          backgroundImage: `url(${thumb})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                          backgroundRepeat: 'no-repeat',
                          opacity: isActive ? 0 : 1,
                        }}
                      />
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
                  {toast && (
                    <button onClick={() => fetchFeed(category, { refresh: true })} style={{
                      padding: '10px 24px', borderRadius: 10, border: 'none', background: theme.primary, color: '#fff', fontWeight: 600, cursor: 'pointer',
                    }}>
                      Retry
                    </button>
                  )}
                </div>
              )}

              {/* The single active player layer, translated onto the active row. */}
              <div
                style={{
                  position: 'absolute', top: 0, left: 0, width: '100%', height: viewH,
                  transform: `translateY(${-activeIdx * viewH}px)`,
                  transition: 'transform 0.15s ease-out',
                  pointerEvents: 'none',
                  zIndex: 4,
                  background: '#000',
                }}
              >
                <video
                  ref={el => {
                    playerElsRef.current[0] = el;
                    if (playerElsRef.current[0] && playerElsRef.current[1] && !poolReady) setPoolReady(true);
                  }}
                  playsInline
                  preload="auto"
                  onEnded={() => handleSlotEnded(0)}
                  onError={() => handleSlotError(0)}
                  onTimeUpdate={(e) => {
                    if (activeSlotRef.current !== 0) return;
                    const v = e.currentTarget;
                    setProgress({ current: v.currentTime || 0, duration: Number.isFinite(v.duration) ? v.duration : 0 });
                  }}
                  style={{
                    position: 'absolute', inset: 0, width: '100%', height: '100%',
                    objectFit: 'contain', background: 'transparent',
                    zIndex: 3,
                    opacity: (!embedVideoId && overlayVideoId && activeSlot === 0) ? 1 : 0,
                    pointerEvents: 'none',
                  }}
                />
                <video
                  ref={el => {
                    playerElsRef.current[1] = el;
                    if (playerElsRef.current[0] && playerElsRef.current[1] && !poolReady) setPoolReady(true);
                  }}
                  playsInline
                  preload="auto"
                  onEnded={() => handleSlotEnded(1)}
                  onError={() => handleSlotError(1)}
                  onTimeUpdate={(e) => {
                    if (activeSlotRef.current !== 1) return;
                    const v = e.currentTarget;
                    setProgress({ current: v.currentTime || 0, duration: Number.isFinite(v.duration) ? v.duration : 0 });
                  }}
                  style={{
                    position: 'absolute', inset: 0, width: '100%', height: '100%',
                    objectFit: 'contain', background: 'transparent',
                    zIndex: 2,
                    opacity: (!embedVideoId && overlayVideoId && activeSlot === 1) ? 1 : 0,
                    pointerEvents: 'none',
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

                {/* Bottom scrim + caption: gradient only where the text sits. */}
                {overlayVideoId && (
                  <>
                    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 170, zIndex: 5, pointerEvents: 'none', background: 'linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0))' }} />
                    <div style={{ position: 'absolute', left: 16, right: 16, bottom: 18, zIndex: 6, pointerEvents: 'none' }}>
                      <div style={{
                        color: '#fff', fontSize: 15, fontWeight: 700, lineHeight: 1.3,
                        textShadow: '0 1px 6px rgba(0,0,0,0.9)', overflow: 'hidden', display: '-webkit-box',
                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                      }}>
                        {activeItem?.title || ''}
                      </div>
                      <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, marginTop: 4, textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>
                        {activeItem?.channelTitle || ''}
                        {fmtLen(activeItem?.durationSeconds || progress.duration) ? `  •  ${fmtLen(activeItem?.durationSeconds || progress.duration)}` : ''}
                      </div>
                    </div>
                  </>
                )}

                {/* Video length / position indicator. */}
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, zIndex: 7, background: 'rgba(255,255,255,0.25)', pointerEvents: 'none' }}>
                  <div style={{ height: '100%', width: `${progress.duration ? Math.min(100, (progress.current / progress.duration) * 100) : 0}%`, background: '#fff', transition: 'width 0.25s linear' }} />
                </div>

                {/* Minimal play glyph; tap anywhere (outside chips/buttons) to toggle. */}
                {paused && overlayVideoId && (
                  <div style={{ position: 'absolute', inset: 0, zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.18)', pointerEvents: 'none' }}>
                    <div style={{ width: 72, height: 72, borderRadius: 36, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 0, height: 0, borderLeft: '22px solid #fff', borderTop: '13px solid transparent', borderBottom: '13px solid transparent', marginLeft: 5 }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Top scrim so the category chips stay readable over any video. */}
            {videos.length > 0 && (
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 132, zIndex: 44, pointerEvents: 'none', background: 'linear-gradient(to bottom, rgba(0,0,0,0.72), rgba(0,0,0,0))' }} />
            )}

            {videos.length > 0 && categories.length > 0 && (
              <div
                style={{
                  position: 'absolute', top: 14, left: onBack ? 60 : 12, right: 12,
                  zIndex: 46, display: 'flex', gap: 8, overflowX: 'auto',
                  scrollbarWidth: 'none', msOverflowStyle: 'none', padding: '2px 0',
                }}
                onClick={(e) => e.stopPropagation()}
                className="reels-chip-row"
              >
                <style>{'.reels-chip-row::-webkit-scrollbar{display:none}'}</style>
                {categories.map((c) => {
                  const active = c.id === category;
                  return (
                    <button
                      key={c.id}
                      onClick={() => selectCategory(c.id)}
                      style={{
                        flexShrink: 0, border: 'none', cursor: 'pointer',
                        padding: '7px 14px', borderRadius: 16, fontSize: 13, fontWeight: 700,
                        color: active ? '#fff' : 'rgba(255,255,255,0.95)',
                        background: active ? theme.primary : 'rgba(0,0,0,0.55)',
                        boxShadow: active ? 'none' : '0 1px 6px rgba(0,0,0,0.45)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}

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
          </div>

          {loadMoreSpinner && (
            <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 45, pointerEvents: 'none' }}>
              <RefreshCw size={20} color="rgba(255,255,255,0.8)" style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}
        </div>
      )}

      {toast && (
        <div onClick={() => setToast('')} style={{
          position: 'absolute', bottom: 40, left: 24, right: 24, zIndex: 60,
          background: 'rgba(20,20,26,0.92)', color: '#fff', padding: '10px 14px', borderRadius: 10,
          fontSize: 13, textAlign: 'center', cursor: 'pointer', boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}