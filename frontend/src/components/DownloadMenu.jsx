import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { X, Download, Film, Music, Check } from 'lucide-react';

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

// The picker renders usable qualities immediately; a background probe then
// replaces them with the exact heights/sizes this video actually offers. The
// probe never blocks downloading, so a slow/blocked YouTube lookup can no longer
// turn into "Downloading isn't available for this video right now."
const BASE_VIDEO = [
  { key: 'auto', label: 'Auto (best)', height: 0, note: 'Best available · MP4' },
  { key: '1080', label: '1080p', height: 1080, note: 'Full HD · MP4' },
  { key: '720', label: '720p', height: 720, note: 'HD · MP4' },
  { key: '480', label: '480p', height: 480, note: 'SD · MP4' },
  { key: '360', label: '360p', height: 360, note: 'MP4' },
  { key: '240', label: '240p', height: 240, note: 'MP4' },
  { key: '144', label: '144p', height: 144, note: 'MP4' },
];

const BASE_AUDIO = [
  { key: 'm4a', label: 'Audio · M4A', ext: 'm4a', note: 'Best audio · M4A · works everywhere' },
  { key: 'webm', label: 'Audio · Opus', ext: 'webm', note: 'Best audio · WebM/Opus' },
];

export default function DownloadMenu({ videoId, token, title, onClose }) {
  const { theme } = useTheme();
  const [tab, setTab] = useState('video');
  const [videoOptions, setVideoOptions] = useState(BASE_VIDEO);
  const [audioOptions, setAudioOptions] = useState(BASE_AUDIO);
  const [exact, setExact] = useState(false);
  const [picked, setPicked] = useState('');
  const closeTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    fetch(`${API}/api/yt/streams/${videoId}?probe=1`, {
      headers: { Authorization: `Bearer ${token || ''}` },
      signal: ctrl.signal,
    })
      .finally(() => clearTimeout(t))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => {
        if (cancelled) return;
        const all = [...(data.formats || []), ...(data.adaptiveFormats || [])];
        const videoOnly = (data.adaptiveFormats || []).filter((f) => f.hasVideo && !f.hasAudio);
        const progressive = (data.formats || []).filter((f) => f.hasVideo && f.hasAudio);

        // Exact heights the video really offers, with their largest size.
        const byHeight = new Map();
        for (const f of [...videoOnly, ...progressive]) {
          const h = Number(f.height) || 0;
          if (!h) continue;
          const size = Number(f.contentLength) || 0;
          const cur = byHeight.get(h);
          if (!cur || size > cur.size) byHeight.set(h, { size, withAudio: !!f.hasAudio });
        }
        const heights = [...byHeight.keys()].sort((a, b) => b - a);
        if (heights.length) {
          const autoSize = Number((data.formats || []).find((f) => f.hasVideo && f.hasAudio)?.contentLength) || 0;
          const opts = [{ key: 'auto', label: 'Auto (best)', height: 0, note: `Best available · MP4${autoSize ? ` · ${fmtSize(autoSize)}` : ''}` }];
          for (const h of heights) {
            const meta = byHeight.get(h);
            const bits = ['MP4'];
            bits.push(meta.withAudio ? 'with audio' : 'merged with audio');
            if (meta.size) bits.push(fmtSize(meta.size));
            opts.push({ key: String(h), label: `${h}p`, height: h, note: bits.join(' · ') });
          }
          setVideoOptions(opts);
          setExact(true);
        }

        const auds = (data.adaptiveFormats || []).filter((f) => f.hasAudio && !f.hasVideo);
        const m4a = auds.filter((f) => /m4a|mp4a/.test(`${f.ext || ''} ${f.mimeType || ''} ${f.codecs || ''}`)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        const webm = auds.filter((f) => /webm|opus/.test(`${f.ext || ''} ${f.mimeType || ''} ${f.codecs || ''}`)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        const audioOpts = [];
        if (m4a) audioOpts.push({ key: 'm4a', label: 'Audio · M4A', ext: 'm4a', note: ['M4A', fmtKbps(m4a.bitrate), fmtSize(m4a.contentLength)].filter(Boolean).join(' · ') });
        if (webm) audioOpts.push({ key: 'webm', label: 'Audio · Opus', ext: 'webm', note: ['WebM', fmtKbps(webm.bitrate), fmtSize(webm.contentLength)].filter(Boolean).join(' · ') });
        if (audioOpts.length) setAudioOptions(audioOpts);
      })
      .catch(() => { /* keep the instant list; downloads still work */ });
    return () => { cancelled = true; ctrl.abort(); };
  }, [videoId, token]);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  function pick(f) {
    const isAudio = tab === 'audio';
    const qs = new URLSearchParams();
    qs.set('audio', isAudio ? '1' : '0');
    if (isAudio) {
      if (f.ext) qs.set('ext', f.ext);
    } else if (f.height) {
      qs.set('height', String(f.height));
    }
    if (token) qs.set('token', token);
    const a = document.createElement('a');
    a.href = `${API}/api/yt/download/${videoId}?${qs.toString()}`;
    a.rel = 'noopener';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setPicked(f.key);
    // Give the browser a beat to start the download, then close.
    closeTimerRef.current = setTimeout(() => { if (onClose) onClose(); }, 350);
  }

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
      onClick={(e) => { e.stopPropagation(); if (onClose) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(8,5,14,0.6)', padding: 'clamp(8px, 2vw, 20px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420, maxHeight: '82vh', display: 'flex', flexDirection: 'column',
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
          {options.map((f) => {
            const isAudio = tab === 'audio';
            const isPicked = picked === f.key;
            return (
              <button
                key={`${tab}-${f.key}`}
                onClick={() => pick(f)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 10, padding: '11px 12px', marginTop: 6, borderRadius: 10, cursor: 'pointer',
                  background: isPicked ? (theme.primaryLight || 'rgba(124,58,237,0.18)') : (theme.panelBg || theme.primaryLight),
                  border: `1px solid ${isPicked ? theme.primary : theme.border}`,
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ color: theme.text, fontSize: 14, fontWeight: 700 }}>{f.label}</span>
                  <span style={{ color: theme.textSecondary, fontSize: 11.5 }}>{f.note}</span>
                </span>
                {isPicked ? <Check size={17} color={theme.primary} /> : <Download size={17} color={theme.primary} />}
              </button>
            );
          })}
          <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.5, color: theme.textSecondary }}>
            {exact
              ? 'Choose a quality to start. Your browser saves the file when the server finishes preparing it.'
              : 'Showing standard qualities. The server picks the closest available and merges audio automatically.'}
          </div>
        </div>
      </div>
    </div>
  );
}
