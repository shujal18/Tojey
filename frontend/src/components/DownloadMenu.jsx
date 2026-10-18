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
  const [gated, setGated] = useState(false);
  const [videoOptions, setVideoOptions] = useState([]);
  const [audioOptions, setAudioOptions] = useState([]);
  const [reason, setReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setGated(false);
    setReason('');
    fetch(`${API}/api/yt/streams/${videoId}?probe=1`, {
      headers: { Authorization: `Bearer ${token || ''}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then((data) => {
        if (cancelled) return;
        // When the backend can remux, a video-only (HD) adaptive format is
        // downloaded with its audio track mixed back in, so it is offered as a
        // normal "with audio" quality (its size includes the audio track).
        const gatedVideo = data.gated === true;
        setGated(gatedVideo);
        // Remuxing into a single MP4 needs an AAC track; without one, HD
        // downloads are honestly offered as video-only instead.
        const canMux = data.canMux === true && !gatedVideo && !!data.defaultAudio;
        const audioSize = Number(data.defaultAudio && data.defaultAudio.contentLength) || 0;
        const progressive = (data.formats || [])
          .filter((f) => f.hasVideo && f.hasAudio)
          .map((f) => ({ ...f, withAudio: true, muxApi: false }));
        const videoOnly = (data.adaptiveFormats || [])
          .filter((f) => f.hasVideo && !f.hasAudio)
          .map((f) => ({
            ...f,
            withAudio: canMux,
            muxApi: canMux,
            contentLength: (Number(f.contentLength) || 0) + (canMux ? audioSize : 0),
          }));
        let vids;
        if (canMux) {
          // YouTube offers several codecs per resolution (H.264/VP9/AV1). All
          // remux fine server-side, so keep one entry per height and prefer
          // H.264 (most compatible for a downloaded file).
          const rank = (f) => (/avc1/.test(f.codecs || '') ? 0 : /av01/.test(f.codecs || '') ? 1 : 2);
          const byHeight = new Map();
          for (const f of videoOnly) {
            const h = f.height || 0;
            const cur = byHeight.get(h);
            if (!cur || rank(f) < rank(cur)) byHeight.set(h, f);
          }
          vids = [...byHeight.values()];
        }
        if (gatedVideo) vids = progressive;
        else if (!vids || !vids.length) vids = [...progressive, ...videoOnly];
        vids.sort((a, b) => {
          if (a.withAudio !== b.withAudio) return a.withAudio ? -1 : 1;
          return (b.height || 0) - (a.height || 0);
        });
        const auds = (data.adaptiveFormats || [])
          .filter((f) => f.hasAudio && !f.hasVideo)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        // Surface why a video has no formats instead of a bare "No format
        // available": the backend returns playability status/reason (private,
        // age-restricted, region-locked, bot-checked, deleted...).
        const st = String(data.status || '');
        const why = String(data.reason || '').trim();
        const unavailable = st && st !== 'OK';
        if (unavailable && !vids.length && !auds.length) {
          setError(why ? `This video can’t be downloaded — ${why}.` : 'This video can’t be downloaded right now.');
        }
        setVideoOptions(vids);
        setAudioOptions(auds);
        setReason(why);
        if (!vids.length && auds.length) setTab('audio');
        else if (!vids.length && !auds.length && !unavailable) setError('No downloadable formats for this video.');
      })
      .catch(() => {
        if (!cancelled) setError('Downloading isn’t available for this video right now.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [videoId, token]);

  const pick = (f) => {
    try { triggerDownload(videoId, token, f.itag, !!f.muxApi); } catch (e) {}
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

          {!loading && !error && gated && tab === 'video' && (
            <div style={{ margin: '6px 0 2px', padding: '9px 11px', borderRadius: 10, background: theme.primaryLight || 'rgba(124,58,237,0.12)', color: theme.textSecondary, fontSize: 12, lineHeight: 1.5 }}>
              YouTube restricts HD for this video, so it downloads in 360p with audio.
            </div>
          )}

          {!loading && !error && options.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: theme.textSecondary, fontSize: 13, lineHeight: 1.6 }}>
              {reason ? `YouTube returned: ${reason}.` : null}
              {reason ? <br /> : null}
              {tab === 'audio'
                ? (videoOptions.length
                  ? 'No audio-only track for this video — the Video download already includes audio.'
                  : 'No audio formats are available for this video.')
                : (audioOptions.length
                  ? 'No video track for this video — try the Audio tab.'
                  : 'No video formats are available for this video.')}
            </div>
          )}

          {!loading && !error && options.map((f) => {
            const isAudio = tab === 'audio';
            const label = isAudio
              ? (f.bitrate ? fmtKbps(f.bitrate) : 'Audio')
              : (f.qualityLabel || (f.height ? `${f.height}p` : 'Video'));
            const size = fmtSize(f.contentLength);
            const container = isAudio
              ? (/audio\/webm/.test(f.mimeType || '') ? 'WEBM' : 'M4A')
              : 'MP4';
            const bits = [container];
            if (!isAudio && f.withAudio) bits.push('with audio');
            if (!isAudio && !f.withAudio) bits.push('no audio');
            if (!isAudio && f.fps && f.fps >= 50) bits.push(`${f.fps}fps`);
            if (size) bits.push(size);
            return (
              <button
                key={`${tab}-${f.itag}`}
                onClick={() => pick(f)}
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
