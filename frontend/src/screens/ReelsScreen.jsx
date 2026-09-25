import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { RefreshCw, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';

const API = import.meta.env.VITE_API_URL || '';

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function thumbnailUrlFor(item) {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) {
    return item.thumbnailUrl.trim();
  }
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
}

function embedUrl(videoId, paused) {
  const qs = new URLSearchParams({
    autoplay: paused ? '0' : '1',
    mute: '0',
    controls: '0',
    playsinline: '1',
    rel: '0',
    loop: '1',
    playlist: videoId,
    disablekb: '1',
    modestbranding: '1',
  });
  return `https://www.youtube.com/embed/${videoId}?${qs.toString()}`;
}

function parseYTErrorCode(errorCode) {
  if (typeof errorCode === 'number') return errorCode;
  if (typeof errorCode === 'string') {
    const parts = errorCode.trim().split(/[\s,-]+/);
    const code = parseInt(parts[0], 10);
    if (!isNaN(code)) return code;
  }
  return null;
}

function isPlayableError(errorCode) {
  const code = parseYTErrorCode(errorCode);
  if (code === null) return false;
  return [2, 5, 100, 101, 102, 103, 104, 105, 150, 152, 153, 154, 155].includes(code);
}

export default function ReelsScreen({ token, user, refreshTick = 0, onBack }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewH, setViewH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 600));
  const [loadMoreSpinner, setLoadMoreSpinner] = useState(false);

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

  useEffect(() => { videosRef.current = videos; }, [videos]);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Track the real container height so reels fill the shell exactly.
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

  const fetchFeed = useCallback(async (cat, opts = {}) => {
    if (inflightRef.current) return;
    const { refresh = false, append = false, pageToken = null } = opts;
    const currentRequestId = ++requestIdRef.current;
    inflightRef.current = true;
    if (!append) setLoading(true);
    if (append) setLoadMoreSpinner(true);
    setError(null);

    try {
      const queryParts = [`category=${encodeURIComponent(cat)}`, `refresh=${refresh ? 'true' : 'false'}`];
      if (pageToken) queryParts.push(`pageToken=${encodeURIComponent(pageToken)}`);
      const qs = queryParts.join('&');

      // Cached client-side feed for instant first paint (mirrors the app cache).
      if (!append && !pageToken && !refresh) {
        const cacheKey = `tojey_reels_cache_${cat}`;
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

      const res = await fetch(`${API}/api/reels/feed?${qs}`, { headers: authHeaders });
      const data = await res.json();

      if (!isMountedRef.current || currentRequestId !== requestIdRef.current) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load feed');

      let validVideos = (data.videos || []).filter(v =>
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
            localStorage.setItem(`tojey_reels_cache_${cat}`, JSON.stringify({ videos: validVideos, timestamp: Date.now() }));
          } catch (e) {}
        }
      }

      nextPageTokenRef.current = data.nextPageToken || null;
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

  // Boot feed; refresh when the category chip changes.
  useEffect(() => {
    seenVideoIdsRef.current.clear();
    nextPageTokenRef.current = null;
    hasMoreRef.current = true;
    fetchFeed(category, {});
  }, [category, fetchFeed]);

  // Re-tap on the Reels tab (HomeLayout bumps refreshTick) -> fresh feed.
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

  // Pause playback when the tab is hidden.
  useEffect(() => {
    const handler = () => {
      if (document.hidden && !pausedRef.current) {
        setPaused(true);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

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
    setPaused(p => !p);
  }, []);

  const activeItem = videos[activeIdx];
  const activeVideoId = sanitizeVideoId(activeItem && activeItem.videoId);
  // Failed/blocked videos fall through to the next one automatically.
  const overlayVideoId = activeVideoId && !failedVideoIdsRef.current.has(activeVideoId)
    ? activeVideoId
    : null;

  useEffect(() => {
    if (overlayVideoId) currentVideoIdRef.current = overlayVideoId;
  }, [overlayVideoId]);

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
          {videos.map((item, i) => {
            const thumb = thumbnailUrlFor(item);
            const isActive = i === activeIdx;
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

                {/* Active-cell chrome: caption sits inside the cell so it stays in place */}
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

          {/* Single active player overlay, translated to follow the active cell.
              pointer-events:none so wheel/touch scrolling keeps reaching the list. */}
          {overlayVideoId && (
            <div
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: viewH,
                transform: `translateY(${-activeIdx * viewH}px)`,
                transition: 'transform 0.15s ease-out',
                pointerEvents: 'none',
                zIndex: 4,
              }}
            >
              <iframe
                title="reel-player"
                src={embedUrl(overlayVideoId, paused)}
                frameBorder="0"
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                style={{ width: '100%', height: '100%', border: 'none', background: '#000' }}
              />
              {paused && (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div style={{
                    width: 64, height: 64, borderRadius: 32, background: 'rgba(0,0,0,0.55)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <div style={{ width: 0, height: 0, borderLeft: '20px solid #fff', borderTop: '12px solid transparent', borderBottom: '12px solid transparent', marginLeft: 4 }} />
                  </div>
                </div>
              )}
            </div>
          )}
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