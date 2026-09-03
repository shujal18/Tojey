import React, { useState, useRef, useEffect } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { Check, CheckCheck, Mic, Play, Pause, Reply, Copy, Pencil, Trash, CircleX, FileText } from 'lucide-react';

export function TimeStamp({ time, isSent, edited }) {
  const { theme } = useTheme();
  const d = time ? new Date(time) : new Date();
  const txt = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const color = isSent ? 'rgba(255,255,255,0.75)' : theme.textSecondary;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color, marginLeft: 8 }}>
      {txt}
      {edited && <span style={{ fontSize: 10, opacity: 0.7 }}>edited</span>}
      {isSent && <StatusIcon status={statusOf(d)} />}
    </div>
  );
}

function statusOf(d) {
  return 'READ';
}

export function StatusIcon({ status }) {
  if (status === 'READ') return <CheckCheck size={13} color="#A5D6FF" />;
  if (status === 'DELIVERED') return <CheckCheck size={13} color="rgba(255,255,255,0.75)" />;
  return <Check size={13} color="rgba(255,255,255,0.75)" />;
}

export function VoiceBubble({ message, isSent }) {
  const { theme } = useTheme();
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [transcript, setTranscript] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (playing) {
      timer.current = setInterval(() => {
        setProgress(p => {
          if (p >= 100) { setPlaying(false); clearInterval(timer.current); return 0; }
          return p + 1;
        });
      }, 300);
    } else {
      clearInterval(timer.current);
    }
    return () => clearInterval(timer.current);
  }, [playing]);

  const duration = message.duration || 26;
  const bars = Array.from({ length: 28 }, (_, i) => 4 + Math.abs(Math.sin(i * 1.3)) * 14);

  const toggle = () => setPlaying(!playing);

  const toggleSpeed = () => {
    const speeds = [1, 1.5, 2];
    const idx = speeds.indexOf(speed);
    setSpeed(speeds[(idx + 1) % speeds.length]);
  };

  const currentSec = Math.round((progress / 100) * duration);

  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={toggle} style={{
          width: 34, height: 34, borderRadius: 17,
          background: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight,
          color: isSent ? '#fff' : theme.primary,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 2, height: 24 }}>
          {bars.map((h, i) => {
            const active = (i / bars.length) * 100 <= progress;
            return (
              <span key={i} className="wave-bar" style={{
                width: 3,
                height: `${(h * (i < progress / bars.length * bars.length ? 1 : 0.4) + 3)}px`,
                background: active
                  ? (isSent ? '#fff' : theme.primary)
                  : (isSent ? 'rgba(255,255,255,0.35)' : theme.border),
                animation: playing ? 'none' : 'none',
                transition: 'height 0.1s, background 0.2s',
              }} />
            );
          })}
        </div>

        <span style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary }}>
          {currentSec > 0 ? `0:${String(currentSec).padStart(2, '0')}` : `0:${String(duration).padStart(2, '0')}`}
        </span>

        <button onClick={toggleSpeed} style={{
          fontSize: 11, fontWeight: 700,
          color: isSent ? '#fff' : theme.primary,
          background: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight,
          padding: '3px 6px', borderRadius: 6,
          width: 40, textAlign: 'center',
        }}>
          {speed}×
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginTop: 6, gap: 8 }}>
        <button onClick={() => setTranscript('“This is how it sounds.” — auto transcription placeholder')}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            color: isSent ? 'rgba(255,255,255,0.9)' : theme.primary,
            fontSize: 11, fontWeight: 500,
          }}>
          <FileText size={12} /> Transcribe
        </button>
        {transcript && (
          <span style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary, fontStyle: 'italic' }}>
            {transcript}
          </span>
        )}
      </div>
    </div>
  );
}
