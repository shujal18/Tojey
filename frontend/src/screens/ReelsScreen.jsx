import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { RefreshCw, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';
import { streamUrl } from '../components/YoutubePlayer';

const API = import.meta.env.VITE_API_URL || '';

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
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

  const shellRef = useRef(null);
  const toastTimerRef = useRef(null);
  const requestIdRef = useRef(0);
  const activeIdxRef = useRef(0);
  const pausedRef = useRef(false);
  const inflightRef = useRef(false);
  const seenVideoIdsRef = useRef(new Set());
  const failedVideoIdsRef = useRef(new Set());
  const currentVideoIdRef = useRef(null);

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
    const el0 = playerElsRef.current[0];
    const el1 = playerElsRef.current[1];
    if (!el0 || !el1) return;
    const list = videosRef.current;
    const videoId = sanitizeVideoId(list[idx] && list[idx].videoId);
    if (!videoId) {
      currentVideoIdRef.current = null;
      return;
    }
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

  const skipOnError = useCallback((erroredVideoId) => {
    if (erroredVideoId) failedVideoIdsRef.current.add(erroredVideoId);
    loadedVideoIdBySlotRef.current[activeSlotRef.current] = null;
    currentVideoIdRef.current = null;
    const cur = activeIdxRef.current;
    let next = cur + 1;
    while (videosRef.current[next] && failedVideoIdsRef.current.has(sanitizeVideoId(videosRef.current[next].videoId))) next++;
    if (videosRef.current[next]) {
      switchToIndex(next);
    } else {
      showToast('Some videos are unavailable');
      fetchFeed(category, { refresh: true });
    }
  }, [switchToIndex, showToast, category, fetchFeed]);

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
  // possibly-expired upstream URL), then skip the clip like the old YT player did.
  const errorRetriesRef = useRef(0);
  const handleVideoError = useCallback(() => {
    const slot = activeSlotRef.current;
    const el = playerElsRef.current[slot];
    const vid = loadedVideoIdBySlotRef.current[slot];
    if (!el || !vid) return;
    if (errorRetriesRef.current < 1) {
      errorRetriesRef.current += 1;
      const fresh = mediaSrc(vid, token, Date.now());
      el.src = fresh;
      el.load();
      if (!pausedRef.current) el.play().catch(() => {});
      return;
    }
    errorRetriesRef.current = 0;
    skipOnError(vid);
  }, [token, skipOnError]);

  const handleSlotEnded = useCallback((slot) => {
    if (slot !== activeSlotRef.current) return;
    handleEnded();
  }, [handleEnded]);

  const handleSlotError = useCallback((slot) => {
    if (slot !== activeSlotRef.current) return;
    handleVideoError();
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
        <div
          ref={shellRef}
          onClick={handleTap}
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: 'scroll',
            scrollSnapType: 'y mandatory',
            background: '#000',
            position: 'relative',
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
                    }}
                  />
                ) : (
                  <div style={{ position: 'absolute', inset: 0, background: '#111' }} />
                )}

                {isActive && (
                  <div style={{ position: 'absolute', left: 14, right: 60, bottom: 16, zIndex: 5, pointerEvents: 'none' }}>
                    <div style={{
                      color: '#fff', fontSize: 15, fontWeight: 700, lineHeight: 1.3,
                      textShadow: '0 1px 6px rgba(0,0,0,0.8)', overflow: 'hidden', display: '-webkit-box',
                      WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}>
                      {item.title || ''}
                    </div>
                    <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, marginTop: 3, textShadow: '0 1px 6px rgba(0,0,0,0.8)' }}>
                      {item.channelTitle || ''}
                      {item.durationSeconds ? `  •  ${Math.round(item.durationSeconds)}s` : ''}
                    </div>
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

          <div
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: viewH,
              transform: `translateY(${-activeIdx * viewH}px)`,
              transition: 'transform 0.15s ease-out',
              pointerEvents: 'none',
              zIndex: 4,
            }}
          >
            <>
              <video
                ref={el => {
                  playerElsRef.current[0] = el;
                  if (playerElsRef.current[0] && playerElsRef.current[1] && !poolReady) setPoolReady(true);
                }}
                playsInline
                preload="auto"
                onEnded={() => handleSlotEnded(0)}
                onError={() => handleSlotError(0)}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'contain', background: '#000',
                  zIndex: 3,
                  opacity: (overlayVideoId && activeSlot === 0) ? 1 : 0,
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
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  objectFit: 'contain', background: '#000',
                  zIndex: 2,
                  opacity: (overlayVideoId && activeSlot === 1) ? 1 : 0,
                  pointerEvents: 'none',
                }}
              />
              {overlayVideoId && paused && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div style={{
                    width: 64, height: 64, borderRadius: 32, background: 'rgba(0,0,0,0.55)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <div style={{ width: 0, height: 0, borderLeft: '20px solid #fff', borderTop: '12px solid transparent', borderBottom: '12px solid transparent', marginLeft: 4 }} />
                  </div>
                </div>
              )}
            </>
          </div>
        </div>
      )}

      {videos.length > 0 && categories.length > 0 && (
        <div
          style={{
            position: 'absolute', top: 10, left: onBack ? 58 : 12, right: 12,
            zIndex: 46, display: 'flex', gap: 8, overflowX: 'auto',
            scrollbarWidth: 'none', msOverflowStyle: 'none', padding: '4px 0',
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
                  padding: '6px 13px', borderRadius: 16, fontSize: 13, fontWeight: 700,
                  color: active ? '#fff' : 'rgba(255,255,255,0.9)',
                  background: active ? theme.primary : 'rgba(0,0,0,0.5)',
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
        <button onClick={onBack} title="Back to chats" style={{
          position: 'absolute', top: 10, left: 12, zIndex: 50,
          width: 38, height: 38, borderRadius: 19,
          background: 'rgba(0,0,0,0.5)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', cursor: 'pointer',
        }}>
          <ArrowLeft size={20} />
        </button>
      )}

      {loadMoreSpinner && (
        <div style={{ position: 'absolute', bottom: 8, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 45 }}>
          <RefreshCw size={20} color="rgba(255,255,255,0.8)" style={{ animation: 'spin 1s linear infinite' }} />
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