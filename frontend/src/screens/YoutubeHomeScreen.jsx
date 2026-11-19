import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { MessageCircle, Settings, MoreVertical, PlaySquare, Download, Check, Bookmark, X, Search, Users, LogOut, Maximize, Minimize, Smile, Send } from 'lucide-react';
import YoutubePlayer from '../components/YoutubePlayer';
import YoutubeBrowse from '../components/YoutubeBrowse';
import DownloadMenu from '../components/DownloadMenu';
import { useWatchTogether } from '../services/WatchTogetherContext';
import { getRecommendationSeeds, getWatchedVideoIds } from '../services/recommendation';
import { addWatchHistory } from '../components/YoutubeBrowse';

const API = import.meta.env.VITE_API_URL || '';

const FALLBACK_CATEGORIES = [
  { id: 'recommended', label: 'For You' },
  { id: 'music', label: 'Music' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'news', label: 'News' },
];

const SAVED_KEY = 'tojey_saved_v2';
const FEED_TTL = 5 * 60 * 1000;
const SHORTS_TTL = 10 * 60 * 1000;
const SIGNALS_TTL = 20 * 1000;
const REFRESH_COOLDOWN = 20 * 1000;
const CACHE_CAP = 12;
const SCROLLBAR_HIDE = '::-webkit-scrollbar{display:none}';
const quickReactions = ['😂', '🔥', '❤️', '👍', '😮', '👏'];

let signals = null;
const feedCache = new Map();
const shortsCache = new Map();

function getSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; }
}

function saveList(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (e) {}
}

function readCache(map, key) {
  const raw = map.get(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (e) {
    return null;
  }
}

function writeCache(map, key, value) {
  const raw = JSON.stringify(value);
  if (map.get(key) === raw) return;
  map.set(key, raw);
  if (map.size > CACHE_CAP) map.delete(map.keys().next().value);
}

function getSignals(force) {
  const now = Date.now();
  if (!force && signals && now - signals.at < SIGNALS_TTL) return signals;
  signals = { seeds: getRecommendationSeeds(8), watched: getWatchedVideoIds(250), at: now };
  return signals;
}

function invalidateSignals() {
  signals = null;
}

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const t = videoId.trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(t) ? t : null;
}

function thumbnailUrlFor(item) {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) return item.thumbnailUrl.trim();
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
}

function dedupeVideos(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((v) => {
    if (!v || !v.videoId || seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });
}

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const CategoryChips = memo(function CategoryChips({ category, onSelect, theme }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 14px' }}>
      {FALLBACK_CATEGORIES.map((c) => {
        const active = c.id === category;
        return (
          <button key={c.id} onClick={() => onSelect(c.id)} style={{
            padding: '6px 13px', borderRadius: 16, border: 'none', cursor: 'pointer',
            background: active ? theme.primary : theme.inputBg,
            color: active ? '#fff' : theme.textSecondary, fontSize: 12, fontWeight: 600,
          }}>
            {c.label}
          </button>
        );
      })}
    </div>
  );
});

const ShortsStrip = memo(function ShortsStrip({ items, onClick, theme }) {
  if (!items.length) return null;
  return (
    <button onClick={onClick} style={{ display: 'block', width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px' }}>
        <PlaySquare size={18} color={theme.primary} />
        <span style={{ fontSize: 16, fontWeight: 800, color: theme.text }}>Shorts</span>
        <span style={{ fontSize: 12, color: theme.textSecondary }}>→ watch full screen</span>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '0 14px', marginTop: 10, overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
        <style>{SCROLLBAR_HIDE}</style>
        {items.map((s) => (
          <img key={s.videoId} src={thumbnailUrlFor(s)} alt="short" style={{ width: 92, height: 126, borderRadius: 10, objectFit: 'cover', background: '#000', flexShrink: 0 }} loading="lazy" />
        ))}
      </div>
    </button>
  );
});

const FeedCard = memo(function FeedCard({ video, isSaved, onOpen, onToggleSave, theme }) {
  return (
    <div data-yt-card={video.videoId} style={{ cursor: 'pointer' }} onClick={() => onOpen(video)}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', borderRadius: 12, overflow: 'hidden', background: '#000', minWidth: 0 }}>
        <img src={thumbnailUrlFor(video)} alt={video.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
        <div style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(16,11,26,0.85)', borderRadius: 4, padding: '1px 5px', fontSize: 10, color: '#fff', fontWeight: 700 }}>
          {fmtDuration(video.durationSeconds)}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSave(video); }}
          style={{
            position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
            background: isSaved ? theme.primary : 'rgba(16,11,26,0.7)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="Save for offline"
        >
          {isSaved ? <Check size={14} /> : <Download size={14} />}
        </button>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, padding: '0 2px', color: theme.text, lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {video.title}
      </div>
      <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2, padding: '0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {video.channelTitle}
      </div>
    </div>
  );
});

function YoutubeHomeScreenInner({ token, refreshTick = 0, onOpenChats, onOpenSettings, onChangeToShorts }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('recommended');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [watch, setWatch] = useState(null);
  const [mode, setMode] = useState('home');
  const [browseView, setBrowseView] = useState('search');
  const [shortsStrip, setShortsStrip] = useState([]);
  const [saved, setSaved] = useState(getSaved);
  const nextPageTokenRef = useRef(null);
  const requestIdRef = useRef(0);
  const servedIdsRef = useRef(new Set());
  const recNonceRef = useRef(0);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(new Set());
  const loadMoreInFlightRef = useRef(false);
  const lastScrollAtRef = useRef(0);
  const lastFetchAtRef = useRef(0);
  const refreshTickRef = useRef(refreshTick);
  const shortsTickRef = useRef(refreshTick);
  const shortsFetchedAtRef = useRef(0);
  const shortsInFlightRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      inFlightRef.current.clear();
      loadMoreInFlightRef.current = false;
      shortsInFlightRef.current = false;
    };
  }, []);

  const { room } = useWatchTogether();
  useEffect(() => {
    const rid = room && sanitizeVideoId(room.videoId);
    if (!rid) return;
    setWatch((prev) => {
      if (prev && sanitizeVideoId(prev.videoId) === rid) return prev;
      return { videoId: rid, title: room.title || 'Shared video', channelTitle: 'Watch together' };
    });
  }, [room && room.videoId, room && room.roomId]);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchPage = useCallback(async (cat, pageToken, opts = {}) => {
    if (!aliveRef.current) return;
    const replace = !!opts.replace;
    const background = !!opts.background;
    const key = `${cat}|${pageToken || ''}|${replace ? 'r' : 'p'}`;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    try {
      if (replace) requestIdRef.current += 1;
      const reqId = requestIdRef.current;
      try {
        setError('');
        if (replace && !background) setLoading(true);
        else if (!replace) setLoadingMore(true);
        const q = [`category=${encodeURIComponent(cat)}`, `refresh=${opts.refresh ? 'true' : 'false'}`];
        if (pageToken) q.push(`pageToken=${encodeURIComponent(pageToken)}`);
        if (cat === 'recommended') {
          const { seeds, watched } = getSignals(!!opts.refresh);
          const exclude = new Set([...watched, ...servedIdsRef.current]);
          if (seeds.length) q.push(`seeds=${encodeURIComponent(JSON.stringify(seeds))}`);
          if (exclude.size) q.push(`exclude=${encodeURIComponent(JSON.stringify([...exclude].slice(-300)))}`);
          q.push(`nonce=${replace ? recNonceRef.current++ : recNonceRef.current}`);
        }
        const res = await fetch(`${API}/api/youtube/feed?${q.join('&')}`, { headers: authHeaders });
        const data = await res.json();
        if (!aliveRef.current || reqId !== requestIdRef.current) return;
        const page = dedupeVideos(data.videos);
        if (cat === 'recommended') {
          page.forEach((v) => servedIdsRef.current.add(v.videoId));
          if (servedIdsRef.current.size > 400) {
            servedIdsRef.current = new Set([...servedIdsRef.current].slice(-320));
          }
        }
        setVideos((prev) => {
          if (replace) return page;
          const seen = new Set(prev.map((v) => v.videoId));
          return [...prev, ...page.filter((v) => !seen.has(v.videoId))];
        });
        nextPageTokenRef.current = data.nextPageToken || null;
        setHasMore(!!data.hasMore);
        if (data.warning) setError(data.warning);
        if (replace) {
          lastFetchAtRef.current = Date.now();
          writeCache(feedCache, `${token}|${cat}`, {
            videos: page,
            nextPageToken: data.nextPageToken || null,
            hasMore: !!data.hasMore,
            ts: Date.now(),
          });
        }
      } catch (e) {
        if (aliveRef.current && reqId === requestIdRef.current && replace && !background) {
          setError('Could not load the feed right now.');
        }
      } finally {
        if (aliveRef.current && reqId === requestIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    } finally {
      inFlightRef.current.delete(key);
    }
  }, [authHeaders, token]);

  useEffect(() => {
    const cached = readCache(feedCache, `${token}|${category}`);
    if (cached && Array.isArray(cached.videos) && cached.videos.length) {
      setVideos(cached.videos);
      nextPageTokenRef.current = cached.nextPageToken || null;
      setHasMore(!!cached.hasMore);
      setLoading(false);
      if (Date.now() - cached.ts < FEED_TTL) return undefined;
      fetchPage(category, null, { replace: true, background: true });
      return undefined;
    }
    fetchPage(category, null, { replace: true });
    return undefined;
  }, [category, fetchPage, token]);

  useEffect(() => {
    if (refreshTick === refreshTickRef.current) return;
    refreshTickRef.current = refreshTick;
    if (Date.now() - lastFetchAtRef.current < REFRESH_COOLDOWN) return;
    invalidateSignals();
    fetchPage(category, null, { replace: true, refresh: true, background: true });
  }, [refreshTick, category, fetchPage]);

  useEffect(() => {
    let active = true;
    const tickChanged = refreshTick !== shortsTickRef.current;
    shortsTickRef.current = refreshTick;
    const cacheKey = `${token}|shorts`;
    (async () => {
      const cached = readCache(shortsCache, cacheKey);
      if (active && cached && Array.isArray(cached.items) && cached.items.length) {
        setShortsStrip(cached.items.slice(0, 8));
        shortsFetchedAtRef.current = cached.ts || Date.now();
      }
      if (!active || !aliveRef.current) return;
      if (!tickChanged && Date.now() - shortsFetchedAtRef.current < SHORTS_TTL) return;
      if (tickChanged && Date.now() - shortsFetchedAtRef.current < REFRESH_COOLDOWN) return;
      if (shortsInFlightRef.current) return;
      shortsInFlightRef.current = true;
      try {
        const { seeds, watched } = getSignals(tickChanged);
        const exclude = new Set([...watched, ...servedIdsRef.current]);
        const q = ['category=trending', 'refresh=false'];
        if (seeds.length) q.push(`seeds=${encodeURIComponent(JSON.stringify(seeds))}`);
        if (exclude.size) q.push(`exclude=${encodeURIComponent(JSON.stringify([...exclude].slice(-300)))}`);
        const res = await fetch(`${API}/api/shorts/feed?${q.join('&')}`, { headers: authHeaders });
        const d = await res.json();
        if (!active || !aliveRef.current || !Array.isArray(d.items)) return;
        const items = d.items.slice(0, 8);
        setShortsStrip(items);
        shortsFetchedAtRef.current = Date.now();
        writeCache(shortsCache, cacheKey, { items, ts: Date.now() });
      } catch (e) {} finally {
        shortsInFlightRef.current = false;
      }
    })();
    return () => { active = false; };
  }, [authHeaders, refreshTick, token]);

  const savedIds = useMemo(() => new Set(saved.map((s) => s.videoId)), [saved]);
  const dlMap = useMemo(() => Object.fromEntries(saved.map((s) => [s.videoId, true])), [saved]);

  const toggleSave = useCallback((v) => {
    const list = getSaved();
    const idx = list.findIndex((x) => x.videoId === v.videoId);
    if (idx >= 0) list.splice(idx, 1); else list.unshift({ videoId: v.videoId, title: v.title, thumbnailUrl: thumbnailUrlFor(v), channelTitle: v.channelTitle, durationSeconds: v.durationSeconds });
    saveList(list);
    setSaved(list);
  }, []);

  const openWatch = useCallback((v) => {
    addWatchHistory(v);
    setWatch(v);
  }, []);

  const openBrowseVideo = useCallback((v) => setWatch(v), []);
  const openNext = useCallback((v) => {
    addWatchHistory(v);
    setWatch(v);
  }, []);
  const closeWatch = useCallback(() => setWatch(null), []);
  const openBrowse = useCallback((view) => { setBrowseView(view); setMode('browse'); }, []);
  const openSearch = useCallback(() => openBrowse('search'), [openBrowse]);
  const openLibrary = useCallback(() => openBrowse('library'), [openBrowse]);

  const loadMore = useCallback(() => {
    if (loadMoreInFlightRef.current || !hasMore || loadingMore || loading) return;
    const pageToken = nextPageTokenRef.current;
    if (!pageToken) return;
    loadMoreInFlightRef.current = true;
    Promise.resolve(fetchPage(category, pageToken, {})).finally(() => {
      loadMoreInFlightRef.current = false;
    });
  }, [hasMore, loadingMore, loading, category, fetchPage]);

  const handleScroll = useCallback((e) => {
    const target = e && e.target;
    if (!target) return;
    const now = Date.now();
    if (now - lastScrollAtRef.current < 120) return;
    lastScrollAtRef.current = now;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 300) loadMore();
  }, [loadMore]);

  const retry = useCallback(() => fetchPage(category, null, { replace: true }), [category, fetchPage]);

  if (mode !== 'home') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.background, padding: '10px 14px' }}>
        <YoutubeBrowse
          token={token}
          key={browseView}
          initialView={browseView}
          onPlay={openBrowseVideo}
          onDownload={toggleSave}
          dlMap={dlMap}
        />
        {!!watch && (
          <WatchModal item={watch} token={token} onClose={closeWatch} related={videos} onNext={openNext} />
        )}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', overflowX: 'hidden', background: theme.background }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', background: theme.background }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 900, color: theme.primary, letterSpacing: 0.2 }}>Tojey</div>
          <div style={{ fontSize: 11, color: theme.textSecondary }}>YouTube inside</div>
        </div>
        <button onClick={openSearch} style={headerBtnStyle} title="Search">
          <Search size={21} color={theme.primary} />
        </button>
        <button onClick={openLibrary} style={{ ...headerBtnStyle, marginLeft: 12 }} title="Library">
          <Bookmark size={20} color={theme.primary} />
        </button>
        <button onClick={onOpenChats} style={{ ...headerBtnStyle, marginLeft: 12 }}>
          <MessageCircle size={21} color={theme.primary} />
        </button>
        <button onClick={onOpenSettings} style={{ ...headerBtnStyle, marginLeft: 12 }}>
          <Settings size={20} color={theme.primary} />
        </button>
      </div>

      {loading && videos.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner" style={{ width: 34, height: 34, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: theme.primary, borderRadius: '50%' }} />
        </div>
      ) : error && videos.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: theme.textSecondary, padding: 30, textAlign: 'center' }}>
          {error}
          <button onClick={retry} style={{ marginTop: 14, color: theme.primary, fontWeight: 700, background: 'none', border: 'none' }}>Retry</button>
        </div>
      ) : (
        <div
          style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}
          onScroll={handleScroll}
        >
          <CategoryChips category={category} onSelect={setCategory} theme={theme} />

          <ShortsStrip items={shortsStrip} onClick={onChangeToShorts} theme={theme} />

          <div style={{ fontSize: 15, fontWeight: 800, margin: '16px 14px 8px', color: theme.text }}>
            {category === 'recommended' ? 'Recommended for you' : `${FALLBACK_CATEGORIES.find((c) => c.id === category)?.label || ''} videos`}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, padding: '0 8px' }}>
            {videos.map((v) => (
              <FeedCard key={v.videoId} video={v} isSaved={savedIds.has(v.videoId)} onOpen={openWatch} onToggleSave={toggleSave} theme={theme} />
            ))}
          </div>

          {loadingMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 14 }}>
              <div className="spinner" style={{ width: 24, height: 24, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: theme.primary, borderRadius: '50%' }} />
            </div>
          )}
        </div>
      )}

      {!!watch && (
        <WatchModal item={watch} token={token} onClose={closeWatch} related={videos} onNext={openNext} />
      )}
    </div>
  );
}

const headerBtnStyle = { background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' };

function WatchModal({ item, token, onClose, related, onNext }) {
  const { theme } = useTheme();
  const [showDownload, setShowDownload] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const vid = sanitizeVideoId(item.videoId);
  const wt = useWatchTogether();
  const wtRef = useRef(wt);
  wtRef.current = wt;
  const inRoom = !!(wt.room && sanitizeVideoId(wt.room.videoId) === vid);
  const inRoomRef = useRef(inRoom);
  inRoomRef.current = inRoom;
  const partnerName = (wt.partner && wt.partner.displayName) || 'Friend';
  const partnerOnline = wt.room ? (wt.room.partnerOnline !== false) : (wt.partner ? wt.partner.isOnline : false);

  const onController = useCallback((c) => { wtRef.current.registerController(c); }, []);
  const onUserAction = useCallback((action, position) => { wtRef.current.reportLocal(action, position); }, []);
  const leaveRoom = useCallback(() => {
    const current = wtRef.current;
    if (current && typeof current.leaveRoom === 'function') current.leaveRoom();
  }, []);
  const handleClose = useCallback(() => {
    if (inRoomRef.current) leaveRoom();
    onClose();
  }, [leaveRoom, onClose]);

  const isGuest = inRoom && !wt.isHost;
  const playerWrapRef = useRef(null);
  const chatEndRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    if (!chatOpen) return;
    if (chatEndRef.current) chatEndRef.current.scrollTop = chatEndRef.current.scrollHeight;
  }, [chatOpen, wt.messages.length]);

  const toggleFullscreen = useCallback(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch (e) {}
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,5,14,0.72)', padding: 'clamp(8px, 2vw, 20px)',
    }} className="wt-modal-overlay" onClick={handleClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column', background: theme.background, borderRadius: 14, overflow: 'hidden',
          width: '100%', maxWidth: 980, maxHeight: 'clamp(88vh, 95vh, 100dvh)', boxShadow: theme.frameShadow,
        }} className="wt-modal-card"
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 10, background: theme.panelHeader || theme.background, position: 'relative' }}>
          {!inRoom && <button onClick={onClose} style={headerBtnStyle}><X size={22} color={theme.text} /></button>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
            <div style={{ fontSize: 12, color: theme.textSecondary }}>{item.channelTitle}</div>
          </div>

          {inRoom && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 16, background: theme.primaryLight || 'rgba(124,58,237,0.14)', color: theme.primary, fontSize: 12, fontWeight: 700 }}
              className="wt-partner-chip">
              <Users size={14} />
              <span className="wt-partner-label" style={{ whiteSpace: 'nowrap' }}>{partnerName}{partnerOnline ? '' : ' (reconnecting…)'}</span>
              <button
                onClick={leaveRoom}
                style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', cursor: 'pointer', background: theme.primary, color: '#fff', borderRadius: 14, padding: '4px 10px', fontSize: 11, fontWeight: 700 }}
              >
                <LogOut size={12} /> Leave
              </button>
            </div>
          )}

          {inRoom && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => { setReactOpen((o) => !o); setChatOpen(false); setMenuOpen(false); }}
                style={{ width: 38, height: 38, borderRadius: 20, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.panelBg, color: theme.text }}
                aria-label="Send a reaction"
                title="Send a reaction"
              >
                <Smile size={18} />
              </button>
              {reactOpen && (
                <div style={{ position: 'absolute', top: 44, right: 0, zIndex: 8, display: 'flex', gap: 2, padding: 6, borderRadius: 14, background: theme.panelBg, border: `1px solid ${theme.border}`, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
                  {quickReactions.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => { wt.sendReaction(emoji); setReactOpen(false); }}
                      title={`React ${emoji}`}
                      style={{ fontSize: 20, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 10 }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {inRoom && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => { setChatOpen((o) => !o); setReactOpen(false); setMenuOpen(false); }}
                style={{ width: 38, height: 38, borderRadius: 20, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.panelBg, color: theme.text }}
                aria-label="Watch chat"
                title="Watch chat"
              >
                <MessageCircle size={18} />
              </button>
              {chatOpen && (
                <div style={{ position: 'absolute', top: 44, right: 0, zIndex: 8, width: 268, maxHeight: 320, display: 'flex', flexDirection: 'column', borderRadius: 12, overflow: 'hidden', background: theme.panelBg, border: `1px solid ${theme.border}`, boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
                  <div ref={chatEndRef} style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 70 }}>
                    {wt.messages.length ? wt.messages.map((m) => (
                      <div key={m.id} style={{ fontSize: 12, lineHeight: 1.4, color: theme.text, wordBreak: 'break-word' }}>
                        <b style={{ color: theme.primary }}>{(m.by && m.by.displayName) || 'Friend'}</b>{': '}{m.text}
                      </div>
                    )) : (
                      <div style={{ fontSize: 12, color: theme.textSecondary }}>No messages yet. Say hi!</div>
                    )}
                  </div>
                  <form
                    onSubmit={(e) => { e.preventDefault(); wt.sendMessage(chatText); setChatText(''); }}
                    style={{ display: 'flex', gap: 6, padding: 8, borderTop: `1px solid ${theme.border}` }}
                  >
                    <input
                      value={chatText}
                      onChange={(e) => setChatText(e.target.value)}
                      maxLength={500}
                      placeholder="Message…"
                      style={{ flex: 1, minWidth: 0, background: theme.inputBg || theme.background, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 8, padding: '7px 9px', fontSize: 12, outline: 'none' }}
                    />
                    <button type="submit" aria-label="Send message" style={{ width: 34, height: 34, borderRadius: 8, border: 'none', cursor: 'pointer', background: theme.primary, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Send size={15} />
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => { setMenuOpen((o) => !o); setReactOpen(false); setChatOpen(false); }}
            style={{ width: 38, height: 38, borderRadius: 20, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.panelBg, color: theme.text }}
            aria-label="Video options"
            title="Video options"
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div style={{ position: 'absolute', top: 50, right: 12, minWidth: 190, background: theme.panelBg, borderRadius: 12, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', border: `1px solid ${theme.border}`, zIndex: 5 }}>
              <button
                onClick={() => { setMenuOpen(false); if (vid) setShowDownload(true); }}
                disabled={!vid}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', cursor: vid ? 'pointer' : 'not-allowed', padding: '12px 14px', fontSize: 13, fontWeight: 600, background: 'transparent', color: theme.text, opacity: vid ? 1 : 0.5 }}
              >
                <Download size={16} /> Download
              </button>
              <button
                onClick={() => { setMenuOpen(false); if (vid) wt.sendInvite({ videoId: vid, title: item.title }); }}
                disabled={!vid || inRoom}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', border: 'none', cursor: (vid && !inRoom) ? 'pointer' : 'not-allowed', padding: '12px 14px', fontSize: 13, fontWeight: 600, background: 'transparent', color: theme.text, opacity: (vid && !inRoom) ? 1 : 0.5 }}
              >
                <Users size={16} /> Play with Friend
              </button>
            </div>
          )}
        </div>
        <div ref={playerWrapRef} data-wt-player="" style={{ background: '#000', width: '100%', position: 'relative' }}>
          <style>{`[data-wt-player]:fullscreen .wt-player,[data-wt-player]:fullscreen .wt-player>div{width:100%!important;height:100%!important;aspect-ratio:auto!important}`}</style>
          {vid ? (
            <div className="wt-player" style={{ width: '100%' }}>
              <YoutubePlayer videoId={vid} token={token} poster={thumbnailUrlFor(item)} onController={onController} onUserAction={onUserAction} related={related} onNext={onNext} />
            </div>
          ) : (
            <div style={{ color: theme.textSecondary, textAlign: 'center', padding: 30 }}>Video unavailable</div>
          )}

          {wt.bubble && (
            <div
              key={wt.bubble.id}
              style={{
                position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 9,
                maxWidth: '82%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 12px', borderRadius: 16, pointerEvents: 'none',
                background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.9)',
                color: '#fff', fontSize: 12.5, lineHeight: 1.35, backdropFilter: 'blur(6px)',
                boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
              }}
            >
              {wt.bubble.kind === 'reaction' ? <span style={{ fontSize: 18, lineHeight: 1 }}>{wt.bubble.emoji}</span> : null}
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <b>{(wt.bubble.by && wt.bubble.by.displayName) || 'Friend'}</b>
                {wt.bubble.kind === 'message' ? `: ${wt.bubble.text}` : ' reacted'}
              </span>
            </div>
          )}

          {isGuest && (
            <div
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={toggleFullscreen}
              title="Only the host controls playback"
              style={{ position: 'absolute', inset: 0, zIndex: 6, cursor: 'default', background: 'transparent' }}
            />
          )}

          {isGuest && (
            <button
              onClick={toggleFullscreen}
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              style={{ position: 'absolute', right: 10, bottom: 10, zIndex: 8, width: 34, height: 34, borderRadius: 18, border: '1px solid rgba(255,255,255,0.6)', background: 'rgba(0,0,0,0.55)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            </button>
          )}

          {!!wt.partnerLeft && sanitizeVideoId(wt.partnerLeft.videoId) === vid && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(8,5,14,0.82)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: 24 }}>
              <div style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>
                {(wt.partnerLeft.by && wt.partnerLeft.by.displayName) || 'Your friend'} left the room.
              </div>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Your video is paused.</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button
                  onClick={() => { wt.resetPartnerLeft(); leaveRoom(); }}
                  style={{ background: theme.primary, color: '#fff', border: 'none', borderRadius: 20, padding: '9px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  Watch alone
                </button>
                <button
                  onClick={() => { wt.resetPartnerLeft(); if (vid) wt.sendInvite({ videoId: vid, title: item.title }); }}
                  style={{ background: 'none', color: '#fff', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 20, padding: '9px 16px', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
                >
                  Start new session
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {showDownload && vid && (
        <DownloadMenu videoId={vid} token={token} title={item.title} onClose={() => setShowDownload(false)} />
      )}
    </div>
  );
}

export default memo(YoutubeHomeScreenInner);
