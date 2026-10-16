import React, { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { ArrowLeft, Trash2, Download, Check, X, Loader2 } from 'lucide-react';
import YoutubePlayer, { triggerDownload } from '../components/YoutubePlayer';

const SAVED_KEY = 'tojey_saved_v2';

function readSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; }
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

export default function DownloadsScreen({ token, onBack, onOpenChats }) {
  const { theme } = useTheme();
  const [items, setItems] = useState([]);
  const [watch, setWatch] = useState(null);
  const [downloading, setDownloading] = useState(null);

  useEffect(() => { setItems(readSaved()); }, []);

  const remove = (id) => {
    const next = items.filter((x) => x.videoId !== id);
    saveList(next);
    setItems(next);
  };

  const startDownload = (v) => {
    // The proxy streams with Content-Disposition: attachment, so the browser
    // saves the file directly - no in-page buffering needed.
    triggerDownload(v.videoId, token);
    setDownloading(v.videoId);
    setTimeout(() => setDownloading((cur) => (cur === v.videoId ? null : cur)), 3000);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: theme.background }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 8, background: theme.background }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}>
          <ArrowLeft size={22} color={theme.text} />
        </button>
        <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, flex: 1 }}>Downloads</div>
        <span style={{ fontSize: 12, color: theme.textSecondary }}>Saved offline</span>
      </div>

      {items.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, textAlign: 'center', color: theme.textSecondary }}>
          <div style={{ width: 76, height: 76, borderRadius: 38, background: theme.primaryLight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Download size={42} color={theme.primary} />
          </div>
          <div style={{ fontSize: 17, fontWeight: 800, color: theme.text, marginTop: 16 }}>No saved videos yet</div>
          <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.45 }}>
            Tap the download button on any video in YouTube to save it here.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map((v) => (
              <div key={v.videoId} style={{ display: 'flex', alignItems: 'center', borderRadius: 14, border: `1px solid ${theme.border}`, background: theme.card, padding: 10 }}>
                <button onClick={() => setWatch(v)} style={{ display: 'flex', alignItems: 'center', flex: 1, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', minWidth: 0 }}>
                  <div style={{ position: 'relative', width: 108, height: 61, borderRadius: 10, overflow: 'hidden', background: '#000', flexShrink: 0 }}>
                    <img src={thumbnailUrlFor(v)} alt={v.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Check size={20} color="#fff" />
                    </div>
                  </div>
                  <div style={{ marginLeft: 12, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.title}</div>
                    <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 3 }}>
                      {v.channelTitle || 'YouTube'} <span style={{ color: theme.online, fontWeight: 700 }}>· Saved</span>
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => startDownload(v)}
                  title={downloading === v.videoId ? 'Download started' : 'Download file'}
                  style={{
                    background: downloading === v.videoId ? theme.primaryLight : 'none',
                    border: 'none', cursor: 'pointer', padding: 8, marginLeft: 2, borderRadius: 8,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {downloading === v.videoId
                    ? <Loader2 size={17} color={theme.primary} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
                    : <Download size={17} color={theme.primary} />}
                </button>
                <button onClick={() => remove(v.videoId)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 8, marginLeft: 6 }}>
                  <Trash2 size={17} color={theme.textSecondary} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!!watch && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', flexDirection: 'column', background: theme.background, maxWidth: 480, width: '100%', margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 10, background: theme.background }}>
            <button onClick={() => setWatch(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, display: 'flex' }}><X size={22} color={theme.text} /></button>
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, color: theme.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{watch.title}</div>
          </div>
          <div style={{ flex: 1, background: '#000' }}>
            {sanitizeVideoId(watch.videoId) ? (
              <YoutubePlayer videoId={watch.videoId} token={token} poster={thumbnailUrlFor(watch)} fill />
            ) : (
              <div style={{ color: '#999', textAlign: 'center', padding: 30 }}>Video unavailable</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}