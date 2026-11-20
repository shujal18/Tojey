import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { Check, CheckCheck, Play, Pause, Mic } from 'lucide-react';
import { resolveUrl } from '../services/upload';

let activeAudio = null;
let switchedAudio = null;

export function StatusIcon({ status }) {
  if (status === 'READ') return <CheckCheck size={13} color="#53C3FF" />;
  if (status === 'DELIVERED') return <CheckCheck size={13} color="rgba(255,255,255,0.75)" />;
  return <Check size={13} color="rgba(255,255,255,0.75)" />;
}

function parseWaveform(raw) {
  const neutral = Array(28).fill(10);
  if (Array.isArray(raw)) return normalizeBars(raw, neutral);
  if (typeof raw !== 'string' || !raw.trim()) return neutral;
  try {
    if (raw.trim().startsWith('[')) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeBars(parsed, neutral);
    }
  } catch (e) {}
  const parts = raw.split(',').map(v => Number(v.trim())).filter(v => Number.isFinite(v));
  if (parts.length < 2) return neutral;
  return normalizeBars(parts, neutral);
}

function normalizeBars(values, neutral) {
  const bars = values.slice(0, 48).map(v => {
    if (!Number.isFinite(v)) return 10;
    return Math.max(4, Math.min(28, v <= 1 ? Math.round(v * 28) : Math.round(v)));
  }).filter(v => Number.isFinite(v));
  if (bars.length < 2) return neutral;
  return bars;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function VoiceBubble({ message, isSent, avatarUrl, senderName }) {
  const { theme } = useTheme();
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [mediaDuration, setMediaDuration] = useState(0);
  const audioRef = useRef(null);
  const aliveRef = useRef(true);
  const url = message.media_url ? resolveUrl(message.media_url) : '';
  const storedDuration = Number(message.duration) || 0;
  const duration = storedDuration > 0 ? storedDuration : mediaDuration;
  const bars = useMemo(() => parseWaveform(message.waveform), [message.waveform]);
  const playedFraction = duration > 0 ? Math.min(1, elapsed / duration) : 0;
  const label = (senderName || (isSent ? 'You' : '?')).trim();

  useEffect(() => {
    aliveRef.current = true;
    if (!url) return undefined;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    audioRef.current = audio;
    const onMeta = () => {
      if (!storedDuration && Number.isFinite(audio.duration) && audio.duration > 0) setMediaDuration(audio.duration);
    };
    const onTime = () => setElapsed(audio.currentTime || 0);
    const onEnd = () => {
      setPlaying(false);
      setElapsed(0);
      if (activeAudio === audio) activeAudio = null;
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      if (switchedAudio === audio) {
        switchedAudio = null;
        setElapsed(0);
        try { audio.currentTime = 0; } catch (e) {}
      }
    };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      aliveRef.current = false;
      audio.pause();
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeAttribute('src');
      audio.load();
      if (activeAudio === audio) activeAudio = null;
      audioRef.current = null;
    };
  }, [url, storedDuration]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || !url) return;
    if (activeAudio && activeAudio !== audio) {
      switchedAudio = activeAudio;
      activeAudio = null;
      switchedAudio.pause();
      try { switchedAudio.currentTime = 0; } catch (e) {}
    }
    if (audio.paused) {
      audio.playbackRate = speed;
      activeAudio = audio;
      audio.play().catch(() => {
        if (activeAudio === audio) activeAudio = null;
        if (aliveRef.current) setPlaying(false);
      });
      return;
    }
    audio.pause();
    if (activeAudio === audio) activeAudio = null;
  };

  const toggleSpeed = () => {
    const speeds = [1, 1.5, 2];
    setSpeed(speeds[(speeds.indexOf(speed) + 1) % speeds.length]);
  };

  return (
    <div style={{ minWidth: 224 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <button
          onClick={toggle}
          disabled={!url}
          aria-label={playing ? 'Pause voice message' : 'Play voice message'}
          style={{
            width: 36, height: 36, borderRadius: 18, flexShrink: 0,
            background: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight,
            color: isSent ? '#fff' : theme.primary,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: url ? 1 : 0.5,
          }}
        >
          {url ? (playing ? <Pause size={17} /> : <Play size={17} />) : <Mic size={16} />}
        </button>

        <div className="voice-waveform" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2, height: 26 }}>
          {bars.map((h, i) => {
            const active = (i + 0.5) / bars.length <= playedFraction;
            return (
              <span key={i} className="voice-wave-bar" style={{
                width: 3,
                height: `${h}px`,
                background: active
                  ? (isSent ? '#fff' : theme.primary)
                  : (isSent ? 'rgba(255,255,255,0.34)' : 'rgba(124,77,255,0.28)'),
              }} />
            );
          })}
        </div>

        <span style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary, flexShrink: 0 }}>
          {clock(elapsed)}/{clock(duration)}
        </span>

        <button onClick={toggleSpeed} style={{
          fontSize: 11, fontWeight: 700,
          color: isSent ? '#fff' : theme.primary,
          background: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight,
          padding: '3px 5px', borderRadius: 6, width: 36, textAlign: 'center', flexShrink: 0,
        }}>
          {speed}×
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
        <div style={{
          width: 20, height: 20, borderRadius: 10, overflow: 'hidden', flexShrink: 0,
          background: 'linear-gradient(135deg,#6C3CE9,#4E22B8)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700,
        }}>
          {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : label[0]}
        </div>
        <span style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.82)' : theme.textSecondary }}>
          {label}
        </span>
      </div>

      {message.transcript && (
        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 5, fontStyle: 'italic' }}>{message.transcript}</div>
      )}
    </div>
  );
}
