import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { MessageCircle, Settings, PlaySquare, Download, Check, Bookmark, X, Search, MoreVertical, Users, LogOut } from 'lucide-react';
import YoutubePlayer from '../components/YoutubePlayer';
import YoutubeBrowse from '../components/YoutubeBrowse';
import DownloadMenu from '../components/DownloadMenu';
import { useWatchTogether } from '../services/WatchTogetherContext';

const API = import.meta.env.VITE_API_URL || '';

const FALLBACK_CATEGORIES = [
  { id: 'trending', label: 'Trending' },
  { id: 'music', label: 'Music' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'gaming', label: 'Gaming' },
  { id: 'tech', label: 'Tech' },
  { id: 'news', label: 'News' },
];

const SAVED_KEY = 'tojey_saved_v2';

function readSaved() {
  return (
    localStorage.getItem(SAVED_KEY) || '[]'
  );
}

function getSaved() {
  try { return JSON.parse(readSaved()); } catch (e) { return []; }
}

function saveList(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (e) {}
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

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export default function YoutubeHomeScreen({ token, refreshTick = 0, onOpenChats, onOpenSettings, onChangeToShorts }) {
  const { theme } = useTheme();
  const [category, setCategory] = useState('trending');
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [watch, setWatch] = useState(null);
  const [mode, setMode] = useState('home');
  const [browseView, setBrowseView] = useState('search');
  const [shortsStrip, setShortsStrip] = useState([]);
  const [saved, setSaved] = useState([]);
  const nextPageTokenRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => { setSaved(getSaved()); }, []);

  // Watch Together: when a shared room starts (or as the partner), open the exact
  // same video locally so both players show the same thing.
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
    if (opts.replace) requestIdRef.current += 1;
    const reqId = requestIdRef.current;
    try {
      setError('');
      if (opts.replace) setLoading(true); else setLoadingMore(true);
      const q = [`category=${encodeURIComponent(cat)}`, `refresh=${opts.refresh ? 'true' : 'false'}`];
      if (pageToken) q.push(`pageToken=${encodeURIComponent(pageToken)}`);
      const res = await fetch(`${API}/api/youtube/feed?${q.join('&')}`, { headers: authHeaders });
      const data = await res.json();
      if (reqId !== requestIdRef.current) return;
      setVideos((prev) => (opts.replace ? data.videos || [] : [...prev, ...(data.videos || [])]));
      nextPageTokenRef.current = data.nextPageToken;
      setHasMore(!!data.hasMore);
      if (data.warning) setError(data.warning);
    } catch (e) {
      if (reqId === requestIdRef.current && opts.replace) setError('Could not load the feed right now.');
    } finally {
      if (reqId === requestIdRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [authHeaders]);

  useEffect(() => {
    let mounted = true;
    fetch(`${API}/api/shorts/feed?category=trending`, { headers: authHeaders })
      .then((r) => r.json())
      .then((d) => { if (mounted && Array.isArray(d.items)) setShortsStrip(d.items.slice(0, 8)); })
      .catch(() => {});
    return () => { mounted = false; };
  }, [authHeaders]);

  useEffect(() => { fetchPage(category, null, { replace: true }); }, [category]);
  useEffect(() => { if (refreshTick > 0) fetchPage(category, null, { replace: true, refresh: true }); }, [refreshTick]);

  const toggleSave = (v) => {
    const list = getSaved();
    const idx = list.findIndex((x) => x.videoId === v.videoId);
    if (idx >= 0) list.splice(idx, 1); else list.unshift({ videoId: v.videoId, title: v.title, thumbnailUrl: thumbnailUrlFor(v), channelTitle: v.channelTitle, durationSeconds: v.durationSeconds });
    saveList(list);
    setSaved(list);
  };

  const isSaved = (id) => saved.some((x) => x.videoId === id);

  if (mode !== 'home') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.background, padding: '10px 14px' }}>
        <YoutubeBrowse
          token={token}
          key={browseView}
          initialView={browseView}
          onPlay={(v) => setWatch(v)}
          onDownload={toggleSave}
          dlMap={Object.fromEntries(saved.map((s) => [s.videoId, true]))}
        />
        {!!watch && (
          <WatchModal item={watch} token={token} onClose={() => setWatch(null)} />
        )}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.background }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', background: theme.background }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 900, color: theme.primary, letterSpacing: 0.2 }}>Tojey</div>
          <div style={{ fontSize: 11, color: theme.textSecondary }}>YouTube inside</div>
        </div>
        <button onClick={() => { setBrowseView('search'); setMode('browse'); }} style={headerBtnStyle} title="Search">
          <Search size={21} color={theme.primary} />
        </button>
        <button onClick={() => { setBrowseView('library'); setMode('browse'); }} style={{ ...headerBtnStyle, marginLeft: 12 }} title="Library">
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
          <button onClick={() => fetchPage(category, null, { replace: true })} style={{ marginTop: 14, color: theme.primary, fontWeight: 700, background: 'none', border: 'none' }}>Retry</button>
        </div>
      ) : (
        <div
          style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}
          onScroll={(e) => {
            if (!hasMore || loadingMore || loading) return;
            if (e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 300) fetchPage(category, nextPageTokenRef.current, {});
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '0 14px' }}>
            {FALLBACK_CATEGORIES.map((c) => {
              const active = c.id === category;
              return (
                <button key={c.id} onClick={() => setCategory(c.id)} style={{
                  padding: '6px 13px', borderRadius: 16, border: 'none', cursor: 'pointer',
                  background: active ? theme.primary : theme.inputBg,
                  color: active ? '#fff' : theme.textSecondary, fontSize: 12, fontWeight: 600,
                }}>
                  {c.label}
                </button>
              );
            })}
          </div>

          {shortsStrip.length > 0 && (
            <button onClick={onChangeToShorts} style={{ display: 'block', width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px' }}>
                <PlaySquare size={18} color={theme.primary} />
                <span style={{ fontSize: 16, fontWeight: 800, color: theme.text }}>Shorts</span>
                <span style={{ fontSize: 12, color: theme.textSecondary }}>→ watch full screen</span>
              </div>
              <div style={{ display: 'flex', gap: 8, padding: '0 14px', marginTop: 10 }}>
                {shortsStrip.map((s) => (
                  <img key={s.videoId} src={thumbnailUrlFor(s)} alt="short" style={{ width: 92, height: 126, borderRadius: 10, objectFit: 'cover', background: '#000' }} />
                ))}
              </div>
            </button>
          )}

          <div style={{ fontSize: 15, fontWeight: 800, margin: '16px 14px 8px', color: theme.text }}>
            {FALLBACK_CATEGORIES.find((c) => c.id === category)?.label} videos
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '0 8px' }}>
            {videos.map((v) => (
              <div key={v.videoId} style={{ cursor: 'pointer' }} onClick={() => setWatch(v)}>
                <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
                  <img src={thumbnailUrlFor(v)} alt={v.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  <div style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(16,11,26,0.85)', borderRadius: 4, padding: '1px 5px', fontSize: 10, color: '#fff', fontWeight: 700 }}>
                    {fmtDuration(v.durationSeconds)}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleSave(v); }}
                    style={{
                      position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                      background: isSaved(v.videoId) ? theme.primary : 'rgba(16,11,26,0.7)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    aria-label="Save for offline"
                  >
                    {isSaved(v.videoId) ? <Check size={14} /> : <Download size={14} />}
                  </button>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6, padding: '0 2px', color: theme.text, lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {v.title}
                </div>
                <div style={{ fontSize: 11, color: theme.textSecondary, marginTop: 2, padding: '0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {v.channelTitle}
                </div>
              </div>
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
        <WatchModal item={watch} token={token} onClose={() => setWatch(null)} />
      )}
    </div>
  );
}

const headerBtnStyle = { background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' };

function WatchModal({ item, token, onClose }) {
  const { theme } = useTheme();
  const [showDownload, setShowDownload] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const vid = sanitizeVideoId(item.videoId);
  const wt = useWatchTogether();
  const inRoom = !!(wt.room && sanitizeVideoId(wt.room.videoId) === vid);
  const partnerName = (wt.partner && wt.partner.displayName) || 'Friend';
  const partnerOnline = wt.room ? (wt.room.partnerOnline !== false) : (wt.partner ? wt.partner.isOnline : false);

  const onController = useCallback((c) => { wt.registerController(c); }, [wt.registerController]);
  const onUserAction = useCallback((action, position) => { wt.reportLocal(action, position); }, [wt.reportLocal]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(8,5,14,0.72)', padding: 20,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex', flexDirection: 'column', background: theme.background, borderRadius: 14, overflow: 'hidden',
          width: '100%', maxWidth: 980, maxHeight: '92vh', boxShadow: theme.frameShadow,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 10, background: theme.panelHeader || theme.background, position: 'relative' }}>
          <button onClick={onClose} style={headerBtnStyle}><X size={22} color={theme.text} /></button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
            <div style={{ fontSize: 12, color: theme.textSecondary }}>{item.channelTitle}</div>
          </div>

          {inRoom && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderRadius: 16, background: theme.primaryLight || 'rgba(124,58,237,0.14)', color: theme.primary, fontSize: 12, fontWeight: 700 }}>
              <Users size={14} />
              <span style={{ whiteSpace: 'nowrap' }}>{partnerName}{partnerOnline ? '' : ' (reconnecting…)'}</span>
              <button
                onClick={wt.leaveRoom}
                style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', cursor: 'pointer', background: theme.primary, color: '#fff', borderRadius: 14, padding: '4px 10px', fontSize: 11, fontWeight: 700 }}
              >
                <LogOut size={12} /> Leave
              </button>
            </div>
          )}

          <button
            onClick={() => setMenuOpen((o) => !o)}
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
        <div style={{ background: '#000', width: '100%', position: 'relative' }}>
          {vid ? (
            <YoutubePlayer videoId={vid} token={token} poster={thumbnailUrlFor(item)} onController={onController} onUserAction={onUserAction} />
          ) : (
            <div style={{ color: theme.textSecondary, textAlign: 'center', padding: 30 }}>Video unavailable</div>
          )}
          {!!wt.partnerLeft && sanitizeVideoId(wt.partnerLeft.videoId) === vid && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(8,5,14,0.82)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: 24 }}>
              <div style={{ color: '#fff', fontSize: 15, fontWeight: 700 }}>
                {(wt.partnerLeft.by && wt.partnerLeft.by.displayName) || 'Your friend'} left the room.
              </div>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Your video is paused.</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button
                  onClick={() => { wt.resetPartnerLeft(); wt.leaveRoom(); }}
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