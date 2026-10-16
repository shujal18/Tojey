import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { Play, RotateCcw } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || '';

export function streamUrl(videoId, itag, token) {
  return `${API}/api/yt/media/${videoId}?itag=${itag}&token=${encodeURIComponent(token || '')}`;
}

export function downloadUrl(videoId, itag, token) {
  return `${API}/api/yt/media/${videoId}?itag=${itag}&download=1&token=${encodeURIComponent(token || '')}`;
}

// Hands the file to the browser's own downloader. The proxy sets
// `Content-Disposition: attachment`, so the browser saves it instead of
// navigating. A synthetic (non-user-gesture) click may be ignored by some
// browsers, but every call site here is a real button press.
export function triggerDownload(videoId, token, itag = 'best') {
  const a = document.createElement('a');
  a.href = downloadUrl(videoId, itag, token);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function fmtBytes(n) {
  if (!n) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
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
}) {
  const { theme } = useTheme();
  const [formats, setFormats] = useState([]);
  const [itag, setItag] = useState(null);
  const [state, setState] = useState('loading');
  const [errMsg, setErrMsg] = useState('');
  const [muted, setMuted] = useState(autoPlay);
  const [nonce, setNonce] = useState(0);
  const videoRef = useRef(null);
  const requestId = useRef(0);
  const retriesRef = useRef(0);

  const load = useCallback(async (forceRefresh = false) => {
    if (!videoId) return;
    const rid = ++requestId.current;
    setNonce((n) => (forceRefresh ? n + 1 : n));
    setState('loading');
    setErrMsg('');
    try {
      const res = await fetch(`${API}/api/yt/streams/${videoId}${forceRefresh ? '?refresh=true' : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (rid !== requestId.current) return;
      if (!res.ok) throw new Error(data.error || 'Stream unavailable');
      const prog = (data.formats || [])
        .filter((f) => f.hasVideo && f.hasAudio)
        .sort((a, b) => (a.height || 0) - (b.height || 0));
      if (!prog.length) throw new Error(data.reason || 'No playable stream');
      setFormats(prog);
      setItag((cur) => (cur && prog.some((f) => f.itag === cur)
        ? cur
        : (prog.find((f) => f.itag === 18)?.itag ?? prog[prog.length - 1].itag)));
      setState('ready');
    } catch (e) {
      if (rid !== requestId.current) return;
      setState('error');
      setErrMsg(e.message || 'Playback failed');
      onError && onError(e);
    }
  }, [videoId, token, onError]);

  useEffect(() => { retriesRef.current = 0; load(); }, [load]);

  const handleVideoError = () => {
    if (retriesRef.current < 2) {
      retriesRef.current += 1;
      setTimeout(() => load(true), 400);
    } else {
      setState('error');
      setErrMsg('Playback failed');
    }
  };

  const src = videoId && itag ? `${streamUrl(videoId, itag, token)}&_=${nonce}` : '';

  return (
    <div style={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, aspectRatio: fill ? undefined : '16/9', background: '#000', overflow: 'hidden', ...style }}>
      {state === 'ready' && src && (
        <video
          ref={videoRef}
          key={`${itag}-${nonce}`}
          src={src}
          poster={poster}
          controls={controls}
          autoPlay={autoPlay}
          muted={muted}
          playsInline
          preload="metadata"
          onCanPlay={() => {
            retriesRef.current = 0;
            const v = videoRef.current;
            if (!v) return;
            if (!autoPlay) { v.muted = false; setMuted(false); return; }
            v.muted = false;
            v.play().then(() => setMuted(false)).catch(() => {
              v.muted = true;
              setMuted(true);
              v.play().catch(() => {});
            });
          }}
          onEnded={onEnded}
          onError={handleVideoError}
          style={{ width: '100%', height: '100%', objectFit: fill ? 'contain' : 'cover', background: '#000' }}
        />
      )}
      {state === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner" style={{ width: 40, height: 40, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: theme.primary, borderRadius: '50%' }} />
        </div>
      )}
      {state === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#eee', textAlign: 'center', padding: 24, gap: 12 }}>
          <Play size={30} color={theme.primary} />
          <div style={{ fontSize: 13, opacity: 0.85 }}>{errMsg}</div>
          <button onClick={() => load(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: theme.primary, color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
            <RotateCcw size={14} /> Retry
          </button>
        </div>
      )}
      {state === 'ready' && formats.length > 1 && (
        <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 6, zIndex: 2 }}>
          {formats.map((f) => (
            <button
              key={f.itag}
              onClick={() => setItag(f.itag)}
              title={fmtBytes(f.contentLength)}
              style={{
                border: 'none', cursor: 'pointer', borderRadius: 14, padding: '4px 10px', fontSize: 11, fontWeight: 700,
                background: f.itag === itag ? theme.primary : 'rgba(20,14,32,0.8)', color: '#fff',
              }}
            >
              {f.qualityLabel || `${f.height}p`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
