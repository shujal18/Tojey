import React, { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { X, Download, Film, Music } from 'lucide-react';

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
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState(null);
  const [jobError, setJobError] = useState('');

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
        const videoOnly = (data.adaptiveFormats || []).filter((f) => f.hasVideo && !f.hasAudio);
        const progressive = (data.formats || []).filter((f) => f.hasVideo && f.hasAudio);

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
          const autoSize = Number(progressive.find((f) => f.hasVideo && f.hasAudio)?.contentLength) || 0;
          const opts = [{ key: 'auto', label: 'Auto (best)', height: 0, size: autoSize, note: `Best available · MP4${autoSize ? ` · ${fmtSize(autoSize)}` : ''}` }];
          for (const h of heights) {
            const meta = byHeight.get(h);
            const bits = ['MP4'];
            bits.push(meta.withAudio ? 'with audio' : 'merged with audio');
            if (meta.size) bits.push(fmtSize(meta.size));
            opts.push({ key: String(h), label: `${h}p`, height: h, size: meta.size, note: bits.join(' · ') });
          }
          setVideoOptions(opts);
          setExact(true);
        }

        const auds = (data.adaptiveFormats || []).filter((f) => f.hasAudio && !f.hasVideo);
        const m4a = auds.filter((f) => /m4a|mp4a/.test(`${f.ext || ''} ${f.mimeType || ''} ${f.codecs || ''}`)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        const webm = auds.filter((f) => /webm|opus/.test(`${f.ext || ''} ${f.mimeType || ''} ${f.codecs || ''}`)).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        const audioOpts = [];
        if (m4a) audioOpts.push({ key: 'm4a', label: 'Audio · M4A', ext: 'm4a', size: Number(m4a.contentLength) || 0, note: ['M4A', fmtKbps(m4a.bitrate), fmtSize(m4a.contentLength)].filter(Boolean).join(' · ') });
        if (webm) audioOpts.push({ key: 'webm', label: 'Audio · Opus', ext: 'webm', size: Number(webm.contentLength) || 0, note: ['WebM', fmtKbps(webm.bitrate), fmtSize(webm.contentLength)].filter(Boolean).join(' · ') });
        if (audioOpts.length) setAudioOptions(audioOpts);
      })
      .catch(() => { /* keep the instant list; downloads still work */ });
    return () => { cancelled = true; ctrl.abort(); };
  }, [videoId, token]);

  useEffect(() => {
    if (!job || ['done', 'error', 'cancelled'].includes(job.status)) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const r = await fetch(`${API}/api/yt/downloads/${job.jobId}`, {
          headers: { Authorization: `Bearer ${token || ''}` },
        });
        if (!r.ok) throw new Error('Unable to check download');
        const next = await r.json();
        if (cancelled) return;
        setJob(next);
        if (!['done', 'error', 'cancelled'].includes(next.status)) timer = setTimeout(tick, 1000);
      } catch (e) {
        if (!cancelled) setJobError(String(e.message || 'Unable to check download'));
      }
    };
    timer = setTimeout(tick, 800);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [job?.jobId, job?.status, token]);

  async function pick(f) {
    setPicked(f.key);
    setStarting(true);
    setJob(null);
    setJobError('');
    const isAudio = tab === 'audio';
    const payload = {
      videoId,
      kind: isAudio ? 'audio' : 'video',
      title: title || '',
      size: Number(f.size) || 0,
    };
    if (isAudio) {
      if (f.ext) payload.ext = f.ext;
    } else if (f.height) {
      payload.height = f.height;
    }
    try {
      const r = await fetch(`${API}/api/yt/downloads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token || ''}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Unable to start download');
      setJob(data);
    } catch (e) {
      setJobError(String(e.message || 'Unable to start download'));
      setStarting(false);
    }
  }

  async function cancel() {
    if (!job) return;
    try {
      const r = await fetch(`${API}/api/yt/downloads/${job.jobId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token || ''}` },
      });
      if (r.ok) setJob(await r.json());
    } catch (e) {
      setJobError(String(e.message || 'Unable to cancel download'));
    }
  }

  function save() {
    if (!job?.downloadUrl) return;
    const a = document.createElement('a');
    a.href = job.downloadUrl;
    a.target = '_self';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const options = tab === 'video' ? videoOptions : audioOptions;
  const active = job && !['done', 'error', 'cancelled'].includes(job.status);

  const tabBtn = (key, label, Icon) => {
    const isActive = tab === key;
    return (
      <button
        onClick={() => setTab(key)}
        disabled={!!job}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '9px 10px', border: 'none', cursor: job ? 'not-allowed' : 'pointer', borderRadius: 10,
          background: isActive ? theme.primary : 'transparent',
          color: isActive ? '#fff' : theme.textSecondary,
          opacity: job ? 0.6 : 1,
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
          {job ? (
            <div style={{ padding: '10px 2px 2px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: theme.text }}>{job.phase || job.status}</div>
              <div style={{ height: 8, borderRadius: 4, background: theme.border, overflow: 'hidden', marginTop: 10 }}>
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(3, Number(job.progress) || 0)}%`,
                    background: theme.primary,
                    transition: 'width 300ms ease',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8, color: theme.textSecondary, fontSize: 11.5 }}>
                <span>{Math.round(Number(job.progress) || 0)}%</span>
                <span>{fmtSize(job.bytesDone)}{job.bytesTotal ? ` / ${fmtSize(job.bytesTotal)}` : ''}</span>
              </div>
              {job.status === 'done' && (
                <button
                  onClick={save}
                  style={{
                    width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10,
                    border: 'none', cursor: 'pointer', background: theme.primary, color: '#fff', fontWeight: 800,
                  }}
                >
                  Save file
                </button>
              )}
              {active && (
                <button
                  onClick={cancel}
                  style={{
                    width: '100%', marginTop: 10, padding: '9px 12px', borderRadius: 10,
                    border: `1px solid ${theme.border}`, cursor: 'pointer', background: 'transparent', color: theme.textSecondary, fontWeight: 700,
                  }}
                >
                  Cancel
                </button>
              )}
              {job.error && (
                <div style={{ marginTop: 10, color: theme.danger, fontSize: 12 }}>{job.error}</div>
              )}
            </div>
          ) : (
            options.map((f) => {
              const isAudio = tab === 'audio';
              const isPicked = starting && picked === f.key;
              return (
                <button
                  key={`${tab}-${f.key}`}
                  onClick={() => pick(f)}
                  disabled={starting}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 10, padding: '11px 12px', marginTop: 6, borderRadius: 10, cursor: starting ? 'wait' : 'pointer',
                    background: isPicked ? (theme.primaryLight || 'rgba(124,58,237,0.18)') : (theme.panelBg || theme.primaryLight),
                    border: `1px solid ${isPicked ? theme.primary : theme.border}`,
                    textAlign: 'left', opacity: starting && !isPicked ? 0.6 : 1,
                  }}
                >
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ color: theme.text, fontSize: 14, fontWeight: 700 }}>{f.label}</span>
                    <span style={{ color: theme.textSecondary, fontSize: 11.5 }}>
                      {isPicked ? 'Preparing download…' : f.note}
                    </span>
                  </span>
                  {!isPicked && <Download size={17} color={theme.primary} />}
                </button>
              );
            })
          )}
          {jobError && <div style={{ marginTop: 12, color: theme.danger, fontSize: 12 }}>{jobError}</div>}
          {!job && (
            <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.5, color: theme.textSecondary }}>
              {exact
                ? 'Choose a quality. Progress, cancellation and the final save happen here.'
                : 'Showing standard qualities. The server picks the closest available and merges audio automatically.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
