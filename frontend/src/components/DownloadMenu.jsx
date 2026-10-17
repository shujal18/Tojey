import React, { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { X, Download, Film, Music, RefreshCw } from 'lucide-react';
import { triggerDownload } from './YoutubePlayer';

const API = import.meta.env.VITE_API_URL || '';

function fmtSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function fmtKbps(bitrate) {
  const n = Number(bitrate);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.round(n / 1000)} kbps`;
}

// Small modal that lets the user pick a format/quality and downloads the file
// straight to their device. Bytes stream through the backend proxy
// (/api/yt/media ...&download=1), which sets Content-Disposition: attachment so
// the browser saves the file instead of navigating.
export default function DownloadMenu({ videoId, token, title, onClose }) {
  const { theme } = useTheme();
  const [tab, setTab] = useState('video');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [videoOptions, setVideoOptions] = useState([]);
  const [audioOptions, setAudioOptions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`${API}/api/yt/streams/${videoId}`, {
      headers: { Authorization: `Bearer ${token || ''}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => {
        if (cancelled) return;
        const muxed = (data.formats || [])
          .filter((f) => f.hasVideo && f.hasAudio)
          .map((f) => ({ ...f, muxed: true }));
        const videoOnly = (data.adaptiveFormats || [])
          .filter((f) => f.hasVideo && !f.hasAudio)
          .map((f) => ({ ...f, muxed: false }));
        const vids = [...muxed, ...videoOnly].sort((a, b) => {
          if (a.muxed !== b.muxed) return a.muxed ? -1 : 1;
          return (b.height || 0) - (a.height || 0);
        });
        const auds = (data.adaptiveFormats || [])
          .filter((f) => f.hasAudio && !f.hasVideo)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        setVideoOptions(vids);
        setAudioOptions(auds);
        if (!vids.length && auds.length) setTab('audio');
      })
      .catch(() => {
        if (!cancelled) setError('Downloading isn’t available for this video right now.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [videoId, token]);

  const pick = (itag) => {
    try { triggerDownload(videoId, token, itag); } catch (e) {}
    onClose();
  };

  const options = tab === 'video' ? videoOptions : audioOptions;

  const tabBtn = (key, label, Icon) => {
    const active = tab === key;
    return (
      <button
        onClick={() => setTab(key)}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '9px 10px', border: 'none', cursor: 'pointer', borderRadius: 10,
          background: active ? theme.primary : 'transparent',
          color: active ? '#fff' : theme.textSecondary,
          fontSize: 13, fontWeight: 700,
        }}
      >
        <Icon size={15} /> {label}
      </button>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(8,5,14,0.6)', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 400, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          background: theme.background, borderRadius: 14, overflow: 'hidden', boxShadow: theme.frameShadow,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: `1px solid ${theme.border}` }}>
          <Download size={18} color={theme.primary} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: theme.text }}>Download</div>
            <div style={{ fontSize: 12, color: theme.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title || ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textSecondary, display: 'flex', padding: 4 }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '10px 12px 4px' }}>
          {tabBtn('video', 'Video', Film)}
          {tabBtn('audio', 'Audio', Music)}
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 12px 14px' }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 28, color: theme.textSecondary, fontSize: 13 }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} /> Preparing formats…
            </div>
          )}

          {!loading && error && (
            <div style={{ padding: 20, textAlign: 'center', color: theme.textSecondary, fontSize: 13, lineHeight: 1.5 }}>
              {error}
            </div>
          )}

          {!loading && !error && options.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: theme.textSecondary, fontSize: 13 }}>
              No {tab} format available.
            </div>
          )}

          {!loading && !error && options.map((f) => {
            const isAudio = tab === 'audio';
            const label = isAudio
              ? (f.bitrate ? fmtKbps(f.bitrate) : 'Audio')
              : (f.qualityLabel || (f.height ? `${f.height}p` : 'Video'));
            const size = fmtSize(f.contentLength);
            const bits = [isAudio ? 'M4A' : 'MP4'];
            if (!isAudio && f.muxed) bits.push('with audio');
            if (!isAudio && !f.muxed) bits.push('no audio');
            if (!isAudio && f.fps && f.fps >= 50) bits.push(`${f.fps}fps`);
            if (size) bits.push(size);
            return (
              <button
                key={`${tab}-${f.itag}`}
                onClick={() => pick(f.itag)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10, padding: '11px 12px', marginTop: 6, borderRadius: 10, cursor: 'pointer',
                  background: theme.panelBg || theme.primaryLight, border: `1px solid ${theme.border}`,
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ color: theme.text, fontSize: 14, fontWeight: 700 }}>{label}</span>
                  <span style={{ color: theme.textSecondary, fontSize: 11.5 }}>{bits.join(' · ')}</span>
                </span>
                <Download size={17} color={theme.primary} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
