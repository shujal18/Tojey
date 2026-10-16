import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { Search, X, Clock, List, PlayCircle, ChevronLeft, History, Bookmark, Trash2 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || '';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'videos', label: 'Videos' },
  { id: 'channels', label: 'Channels' },
  { id: 'playlists', label: 'Playlists' },
  { id: 'shorts', label: 'Shorts' },
];

const HISTORY_KEY = 'tojey_search_history_v1';
const WATCH_KEY = 'tojey_watch_history_v1';
const SAVED_KEY = 'tojey_saved_v2';
const HISTORY_MAX = 20;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (e) { return fallback; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

export function addWatchHistory(entry) {
  if (!entry || !entry.videoId) return;
  const list = readJSON(WATCH_KEY, []);
  const next = [entry, ...list.filter((x) => x.videoId !== entry.videoId)].slice(0, 60);
  writeJSON(WATCH_KEY, next);
}

export function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function thumbnailUrlFor(item) {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) return item.thumbnailUrl.trim();
  const vid = item && item.videoId;
  return vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
}

function useApi(token) {
  return useMemo(() => {
    const headers = { Authorization: `Bearer ${token}` };
    async function get(path) {
      const res = await fetch(`${API}${path}`, { headers });
      if (!res.ok) throw new Error(`api ${res.status}`);
      return res.json();
    }
    return {
      get,
      search: (q, filter, nextToken) => {
        const p = [];
        if (q) p.push(`q=${encodeURIComponent(q)}`);
        if (filter && filter !== 'all') p.push(`filter=${encodeURIComponent(filter)}`);
        if (nextToken) p.push(`token=${encodeURIComponent(nextToken)}`);
        return get(`/api/yt/search${p.length ? `?${p.join('&')}` : ''}`);
      },
      suggestions: (q) => get(`/api/yt/suggestions?q=${encodeURIComponent(q)}`).then((r) => r.suggestions || []),
      channel: (id, tab, nextToken) => {
        const p = [];
        if (tab && tab !== 'videos') p.push(`tab=${encodeURIComponent(tab)}`);
        if (nextToken) p.push(`token=${encodeURIComponent(nextToken)}`);
        return get(`/api/yt/channel/${encodeURIComponent(id)}${p.length ? `?${p.join('&')}` : ''}`);
      },
      playlist: (id, nextToken) => get(`/api/yt/playlist/${encodeURIComponent(id)}${nextToken ? `?token=${encodeURIComponent(nextToken)}` : ''}`),
    };
  }, [token]);
}

function GridCard({ item, onPlay, onOpenChannel, onDownload, downloaded }) {
  const { theme } = useTheme();
  return (
    <div className="tf-nav-hover" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', borderRadius: 12, overflow: 'hidden', background: '#000', cursor: 'pointer' }} onClick={() => onPlay(item)}>
        <img src={thumbnailUrlFor(item)} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
        {!!item.durationSeconds && (
          <div style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(16,11,26,0.85)', borderRadius: 4, padding: '1px 5px', fontSize: 10, color: '#fff', fontWeight: 700 }}>
            {fmtDuration(item.durationSeconds)}
          </div>
        )}
        {!!onDownload && (
          <button
            onClick={(e) => { e.stopPropagation(); onDownload(item); }}
            title={downloaded ? 'Saved' : 'Save'}
            style={{ position: 'absolute', left: 6, top: 6, width: 24, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', background: downloaded ? theme.primary : 'rgba(16,11,26,0.7)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Bookmark size={13} />
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.title}</div>
      <div
        onClick={() => item.channelId && onOpenChannel && onOpenChannel(item)}
        style={{ fontSize: 11, color: theme.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: item.channelId ? 'pointer' : 'default' }}
      >
        {item.channelTitle}{item.views ? ` · ${item.views}` : ''}
      </div>
    </div>
  );
}

function ListRow({ item, onPlay, onOpenChannel, onOpenPlaylist }) {
  const { theme } = useTheme();
  const click = item.type === 'channel' ? () => onOpenChannel && onOpenChannel(item)
    : item.type === 'playlist' ? () => onOpenPlaylist && onOpenPlaylist(item)
    : () => onPlay(item);
  return (
    <div className="tf-nav-hover" onClick={click} style={{ display: 'flex', gap: 12, padding: '6px 0', cursor: 'pointer', alignItems: 'center' }}>
      <div style={{ position: 'relative', width: 168, minWidth: 168, aspectRatio: '16/9', borderRadius: 10, overflow: 'hidden', background: '#000' }}>
        <img src={thumbnailUrlFor(item)} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
        {!!item.durationSeconds && (
          <div style={{ position: 'absolute', right: 5, bottom: 5, background: 'rgba(16,11,26,0.85)', borderRadius: 4, padding: '1px 5px', fontSize: 10, color: '#fff', fontWeight: 700 }}>{fmtDuration(item.durationSeconds)}</div>
        )}
        {item.type === 'playlist' && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 12 }}>
            <List size={16} style={{ marginRight: 4 }} /> {item.videoCount || ''}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: theme.text, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.title}</div>
        <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.type === 'channel' ? (item.subscribers || '') : item.channelTitle}
          {item.views && item.type !== 'channel' ? ` · ${item.views}` : ''}
          {item.publishedAt ? ` · ${item.publishedAt}` : ''}
        </div>
      </div>
      {item.type === 'shorts' && <PlayCircle size={16} color={theme.textSecondary} />}
    </div>
  );
}

function ChannelHeader({ data, theme }) {
  return (
    <div style={{ display: 'flex', gap: 16, padding: '10px 0 16px', alignItems: 'center' }}>
      {data.avatar ? (
        <img src={data.avatar} alt="" style={{ width: 72, height: 72, borderRadius: 36, objectFit: 'cover', background: theme.inputBg }} />
      ) : (
        <div style={{ width: 72, height: 72, borderRadius: 36, background: theme.inputBg }} />
      )}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: theme.text }}>{data.channelTitle}</div>
        {!!data.subscribers && <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{data.subscribers}</div>}
      </div>
    </div>
  );
}

const CHANNEL_TABS = [
  { id: 'videos', label: 'Videos' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'playlists', label: 'Playlists' },
];

export default function YoutubeBrowse({ token, initialView = 'search', initialQuery = '', onPlay, onDownload, dlMap = {} }) {
  const { theme } = useTheme();
  const api = useApi(token);
  const [view, setView] = useState(initialView);
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState('all');
  const [suggestions, setSuggestions] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(() => readJSON(HISTORY_KEY, []));
  const [saved, setSaved] = useState(() => readJSON(SAVED_KEY, []));
  const [watched, setWatched] = useState(() => readJSON(WATCH_KEY, []));
  const [channel, setChannel] = useState(null);
  const [channelTab, setChannelTab] = useState('videos');
  const [playlist, setPlaylist] = useState(null);
  const nextTokenRef = useRef(null);
  const reqIdRef = useRef(0);

  const addRecent = useCallback((q) => {
    const t = q.trim();
    if (!t) return;
    setHistory((prev) => {
      const next = [t, ...prev.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, HISTORY_MAX);
      writeJSON(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const runSearch = useCallback(async (q, f, pageToken, replace) => {
    if (!q.trim()) { setItems([]); setHasMore(false); return; }
    if (replace) reqIdRef.current += 1;
    const rid = reqIdRef.current;
    if (replace) setLoading(true); else setLoadingMore(true);
    setError('');
    try {
      const res = await api.search(q, f, pageToken);
      if (rid !== reqIdRef.current) return;
      setItems((prev) => (replace ? res.items || [] : [...prev, ...(res.items || [])]));
      nextTokenRef.current = res.nextToken || null;
      setHasMore(!!res.hasMore && !!res.nextToken);
    } catch (e) {
      if (rid === reqIdRef.current && replace) setError('Search unavailable right now.');
    } finally {
      if (rid === reqIdRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [api]);

  useEffect(() => {
    if (initialQuery) { addRecent(initialQuery); runSearch(initialQuery, 'all', null, true); }
  }, []); // eslint-disable-line

  useEffect(() => {
    if (view !== 'search' || !query.trim() || items.length) return undefined;
    const t = setTimeout(() => { api.suggestions(query).then(setSuggestions).catch(() => setSuggestions([])); }, 220);
    return () => clearTimeout(t);
  }, [query, view, api, items.length]);

  const openChannel = useCallback(async (item) => {
    const channelId = item.channelId || item.channelId;
    if (!channelId) return;
    setView('channel');
    setChannel({ loading: true, channelId, channelTitle: item.channelTitle });
    setChannelTab('videos');
    try {
      const data = await api.channel(channelId, 'videos');
      setChannel(data);
    } catch (e) {
      setChannel({ error: 'Could not load channel', channelId, channelTitle: item.channelTitle });
    }
  }, [api]);

  const switchChannelTab = useCallback(async (tab) => {
    if (!channel || channel.loading) return;
    setChannelTab(tab);
    try {
      const data = await api.channel(channel.channelId, tab);
      setChannel((c) => ({ ...c, ...data }));
    } catch (e) {}
  }, [api, channel]);

  const loadMoreChannel = useCallback(async () => {
    if (!channel || !channel.hasMore || channel.loadingMore) return;
    setChannel((c) => ({ ...c, loadingMore: true }));
    try {
      const data = await api.channel(channel.channelId, channelTab, channel.nextToken);
      setChannel((c) => ({ ...c, items: [...(c.items || []), ...(data.items || [])], nextToken: data.nextToken, hasMore: data.hasMore, loadingMore: false }));
    } catch (e) {
      setChannel((c) => ({ ...c, loadingMore: false }));
    }
  }, [api, channel, channelTab]);

  const openPlaylist = useCallback(async (item) => {
    const playlistId = item.playlistId;
    if (!playlistId) return;
    setView('playlist');
    setPlaylist({ loading: true, playlistId, title: item.title });
    try {
      const data = await api.playlist(playlistId);
      setPlaylist(data);
    } catch (e) {
      setPlaylist({ error: 'Could not load playlist', playlistId, title: item.title });
    }
  }, [api]);

  const loadMorePlaylist = useCallback(async () => {
    if (!playlist || !playlist.hasMore || playlist.loadingMore) return;
    setPlaylist((p) => ({ ...p, loadingMore: true }));
    try {
      const data = await api.playlist(playlist.playlistId, playlist.nextToken);
      setPlaylist((p) => ({ ...p, videos: [...(p.videos || []), ...(data.videos || [])], nextToken: data.nextToken, hasMore: data.hasMore, loadingMore: false }));
    } catch (e) {
      setPlaylist((p) => ({ ...p, loadingMore: false }));
    }
  }, [api, playlist]);

  const refreshSaved = () => setSaved(readJSON(SAVED_KEY, []));
  const refreshWatched = () => setWatched(readJSON(WATCH_KEY, []));

  const back = () => { setView(initialView === 'library' ? 'library' : 'search'); setChannel(null); setPlaylist(null); };

  const handlePlay = (item) => {
    addWatchHistory({ videoId: item.videoId, title: item.title, thumbnailUrl: thumbnailUrlFor(item), channelTitle: item.channelTitle, durationSeconds: item.durationSeconds });
    refreshWatched();
    onPlay && onPlay(item);
  };

  const downloaded = (id) => (dlMap && dlMap[id]) || saved.some((s) => s.videoId === id);

  const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 14, padding: '4px 0 20px' };

  const renderItems = (list, opts = {}) => {
    if (!list.length) return null;
    if (opts.grid) {
      return (
        <div style={gridStyle}>
          {list.map((it) => (
            <GridCard
              key={it.videoId || it.playlistId || it.channelId}
              item={it}
              onPlay={handlePlay}
              onOpenChannel={openChannel}
              onDownload={onDownload}
              downloaded={downloaded(it.videoId)}
            />
          ))}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {list.map((it) => (
          <ListRow key={it.videoId || it.playlistId || it.channelId} item={it} onPlay={handlePlay} onOpenChannel={openChannel} onOpenPlaylist={openPlaylist} />
        ))}
      </div>
    );
  };

  const center = (children) => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: theme.textSecondary, textAlign: 'center', padding: 30, gap: 12 }}>{children}</div>
  );

  // Header: back button + search box for non-library views.
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
      {view !== 'search' && (
        <button onClick={back} className="tf-icon-btn" style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.text, padding: 4 }}>
          <ChevronLeft size={22} />
        </button>
      )}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: theme.inputBg, borderRadius: 22, padding: '0 12px', height: 40 }}>
        <Search size={16} color={theme.textSecondary} />
        <input
          value={query}
          placeholder="Search YouTube"
          onChange={(e) => { setQuery(e.target.value); setItems([]); setView('search'); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && query.trim()) { setSuggestions([]); addRecent(query); setView('search'); runSearch(query, filter, null, true); } }}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: theme.text, fontSize: 14 }}
        />
        {!!query && (
          <button onClick={() => { setQuery(''); setItems([]); setSuggestions([]); }} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', color: theme.textSecondary }}>
            <X size={16} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {view !== 'library' && header}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {view === 'search' && (
          <div>
            {suggestions.length > 0 && (
              <div style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 10 }}>
                {suggestions.map((s, i) => (
                  <div key={i} className="tf-nav-hover" onClick={() => { setQuery(s); setSuggestions([]); addRecent(s); runSearch(s, filter, null, true); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', color: theme.text }}>
                    <Search size={15} color={theme.textSecondary} />
                    <span style={{ fontSize: 13, flex: 1 }}>{s}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {FILTERS.map((f) => {
                const active = f.id === filter;
                return (
                  <button key={f.id} onClick={() => { setFilter(f.id); if (query.trim()) runSearch(query, f.id, null, true); }} style={{ padding: '6px 13px', borderRadius: 16, border: 'none', cursor: 'pointer', background: active ? theme.primary : theme.inputBg, color: active ? '#fff' : theme.textSecondary, fontSize: 12, fontWeight: 600 }}>
                    {f.label}
                  </button>
                );
              })}
            </div>

            {loading ? (
              center(<div className="spinner" style={{ width: 34, height: 34, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: theme.primary, borderRadius: '50%' }} />)
            ) : !query.trim() ? (
              history.length ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 4px' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: theme.text }}>Recent searches</span>
                    <button onClick={() => { setHistory([]); writeJSON(HISTORY_KEY, []); }} style={{ background: 'none', border: 'none', color: theme.primary, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>Clear</button>
                  </div>
                  {history.map((h, i) => (
                    <div key={i} className="tf-nav-hover" onClick={() => { setQuery(h); addRecent(h); runSearch(h, filter, null, true); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 6px', cursor: 'pointer', color: theme.text }}>
                      <Clock size={15} color={theme.textSecondary} />
                      <span style={{ fontSize: 13, flex: 1 }}>{h}</span>
                    </div>
                  ))}
                </div>
              ) : center(<span style={{ fontSize: 13 }}>Search for videos, channels and playlists</span>)
            ) : error && !items.length ? (
              center(<><span style={{ fontSize: 13 }}>{error}</span><button onClick={() => runSearch(query, filter, null, true)} style={{ color: theme.primary, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>Retry</button></>)
            ) : (
              <>
                {renderItems(items, { grid: filter === 'videos' })}
                {loadingMore && center(<div className="spinner" style={{ width: 26, height: 26, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: theme.primary, borderRadius: '50%' }} />)}
                {hasMore && !loadingMore && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                    <button onClick={() => runSearch(query, filter, nextTokenRef.current, false)} style={{ background: theme.inputBg, color: theme.text, border: 'none', borderRadius: 18, padding: '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Load more</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {view === 'channel' && channel && (
          channel.loading ? center(<div className="spinner" style={{ width: 30, height: 30, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: theme.primary, borderRadius: '50%' }} />)
          : channel.error ? center(<span style={{ fontSize: 13 }}>{channel.error}</span>)
          : (
            <div>
              <ChannelHeader data={channel} theme={theme} />
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                {CHANNEL_TABS.map((t) => {
                  const active = t.id === channelTab;
                  return (
                    <button key={t.id} onClick={() => switchChannelTab(t.id)} style={{ padding: '6px 14px', borderRadius: 16, border: 'none', cursor: 'pointer', background: active ? theme.primary : theme.inputBg, color: active ? '#fff' : theme.textSecondary, fontSize: 12, fontWeight: 600 }}>{t.label}</button>
                  );
                })}
              </div>
              {renderItems(channel.items || [], { grid: channelTab !== 'videos' ? false : true })}
              {channel.hasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                  <button onClick={loadMoreChannel} disabled={channel.loadingMore} style={{ background: theme.inputBg, color: theme.text, border: 'none', borderRadius: 18, padding: '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{channel.loadingMore ? 'Loading…' : 'Load more'}</button>
                </div>
              )}
            </div>
          )
        )}

        {view === 'playlist' && playlist && (
          playlist.loading ? center(<div className="spinner" style={{ width: 30, height: 30, border: '3px solid rgba(255,255,255,0.2)', borderTopColor: theme.primary, borderRadius: '50%' }} />)
          : playlist.error ? center(<span style={{ fontSize: 13 }}>{playlist.error}</span>)
          : (
            <div>
              <div style={{ padding: '6px 0 14px' }}>
                <div style={{ fontSize: 19, fontWeight: 800, color: theme.text }}>{playlist.title}</div>
                <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{playlist.channelTitle}{playlist.videoCount ? ` · ${playlist.videoCount} videos` : ''}</div>
              </div>
              {renderItems(playlist.videos || [], {})}
              {playlist.hasMore && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
                  <button onClick={loadMorePlaylist} disabled={playlist.loadingMore} style={{ background: theme.inputBg, color: theme.text, border: 'none', borderRadius: 18, padding: '8px 18px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>{playlist.loadingMore ? 'Loading…' : 'Load more'}</button>
                </div>
              )}
            </div>
          )
        )}

        {view === 'library' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 14px' }}>
              <button onClick={back} className="tf-icon-btn" style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.text, padding: 4 }}><ChevronLeft size={22} /></button>
              <span style={{ fontSize: 19, fontWeight: 800, color: theme.text }}>Library</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <Bookmark size={16} color={theme.primary} /><span style={{ fontSize: 14, fontWeight: 800, color: theme.text }}>Saved</span>
              <span style={{ fontSize: 12, color: theme.textSecondary }}>({saved.length})</span>
            </div>
            {saved.length ? renderItems(saved, { grid: true }) : <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 16 }}>Nothing saved yet.</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '10px 0 8px' }}>
              <History size={16} color={theme.primary} /><span style={{ fontSize: 14, fontWeight: 800, color: theme.text }}>Watch history</span>
              {!!watched.length && (
                <button onClick={() => { setWatched([]); writeJSON(WATCH_KEY, []); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: theme.textSecondary, cursor: 'pointer', display: 'flex' }}><Trash2 size={15} /></button>
              )}
            </div>
            {watched.length ? renderItems(watched, {}) : <div style={{ fontSize: 12, color: theme.textSecondary }}>No history yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
