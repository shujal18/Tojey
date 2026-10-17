import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { Play, Pause, Volume2, VolumeX, Maximize } from 'lucide-react';

// Official YouTube IFrame Player API, loaded once and cached. Using the API
// (instead of a bare <iframe>) lets us hide YouTube's own control bar
// (`controls: 0`) and drive playback from our own themed overlay.
// Remembers the viewer's sound choice for the Shorts feed. Once they unmute one
// short, later shorts start with sound too (the gesture that unmuted also
// satisfies the browser's autoplay policy).
let shortsSoundOn = false;

let ytApiPromise = null;
function loadYouTubeApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') { try { prev(); } catch (e) {} }
        resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      document.head.appendChild(s);
    });
  }
  return ytApiPromise;
}

function fmtTime(s) {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Plays a YouTube video via the IFrame API with our own controls. `fill` makes
// it occupy the parent (16:9 otherwise). Falls back to muted autoplay when the
// browser blocks sound, matching the rest of the app.
export default function YouTubeEmbed({ videoId, autoPlay = true, onEnded, style, fill = false, poster, variant = 'full', loop = false }) {
  const { theme } = useTheme();
  const wrapRef = useRef(null);
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(variant === 'short');
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadedFrac, setLoadedFrac] = useState(0);
  const [pct, setPct] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [controlsOn, setControlsOn] = useState(true);

  const hideTimerRef = useRef(null);
  const scrubbingRef = useRef(false);
  const pctRef = useRef(0);

  const bumpControls = useCallback(() => {
    setControlsOn(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      // Keep controls pinned while paused or scrubbing.
      if (!scrubbingRef.current) setControlsOn((on) => on);
    }, 2600);
  }, []);

  // Auto-hide the overlay while playing; reveal on any pointer activity.
  useEffect(() => {
    if (!playing) { setControlsOn(true); return undefined; }
    const t = setTimeout(() => {
      if (!scrubbingRef.current) setControlsOn(false);
    }, 2600);
    return () => clearTimeout(t);
  }, [playing, current, controlsOn]);

  useEffect(() => {
    let cancelled = false;
    let poll = null;
    let readyTimeout = null;

    const host = mountRef.current;
    if (!host) return undefined;
    host.innerHTML = '';

    loadYouTubeApi().then((YT) => {
      if (cancelled || !mountRef.current) return;
      const holder = document.createElement('div');
      holder.style.width = '100%';
      holder.style.height = '100%';
      mountRef.current.appendChild(holder);

      playerRef.current = new YT.Player(holder, {
        videoId,
        playerVars: {
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          fs: 0,
          disablekb: 1,
          iv_load_policy: 3,
          origin: window.location.origin,
          ...(loop ? { loop: 1, playlist: videoId } : {}),
        },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            setReady(true);
            try { setDuration(e.target.getDuration() || 0); } catch (err) {}
            // Shorts start muted (autoplay) unless the viewer already turned
            // sound on for the feed. The watch screen keeps sound by default.
            const startMuted = variant === 'short' ? !shortsSoundOn : false;
            if (startMuted) { try { e.target.mute(); } catch (err) {} setMuted(true); }
            else { try { setMuted(e.target.isMuted()); } catch (err) {} }
            if (autoPlay) {
              try { e.target.playVideo(); } catch (err) {}
              // If autoplay was blocked by policy, retry muted so it plays.
              readyTimeout = setTimeout(() => {
                const p = playerRef.current;
                if (!p || cancelled) return;
                try {
                  if (p.getPlayerState() !== YT.PlayerState.PLAYING && !p.isMuted()) {
                    p.mute();
                    setMuted(true);
                    p.playVideo();
                  }
                } catch (err) {}
              }, 1800);
            }
          },
          onStateChange: (e) => {
            if (cancelled) return;
            const YTS = YT.PlayerState;
            if (e.data === YTS.PLAYING) {
              setPlaying(true);
              setStarted(true);
              try { setMuted(e.target.isMuted()); } catch (err) {}
            } else if (e.data === YTS.PAUSED) {
              setPlaying(false);
            } else if (e.data === YTS.BUFFERING) {
              setStarted(true);
            } else if (e.data === YTS.ENDED) {
              setPlaying(false);
              onEndedRef.current && onEndedRef.current();
            }
          },
        },
      });

      poll = setInterval(() => {
        const p = playerRef.current;
        if (!p || typeof p.getCurrentTime !== 'function') return;
        try {
          const d = p.getDuration() || 0;
          const t = p.getCurrentTime() || 0;
          setDuration(d);
          if (!scrubbingRef.current) {
            setCurrent(t);
            setPct(d > 0 ? (t / d) * 100 : 0);
          }
          const lf = typeof p.getVideoLoadedFraction === 'function' ? p.getVideoLoadedFraction() : 0;
          setLoadedFrac(lf * 100);
        } catch (err) {}
      }, 250);
    });

    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      if (readyTimeout) clearTimeout(readyTimeout);
      const p = playerRef.current;
      if (p && typeof p.destroy === 'function') { try { p.destroy(); } catch (err) {} }
      playerRef.current = null;
      if (mountRef.current) mountRef.current.innerHTML = '';
    };
  }, [videoId, autoPlay, variant, loop]);

  useEffect(() => () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); }, []);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p || typeof p.getPlayerState !== 'function') return;
    bumpControls();
    try {
      if (p.getPlayerState() === window.YT.PlayerState.PLAYING) p.pauseVideo();
      else p.playVideo();
    } catch (e) {}
  }, [bumpControls]);

  const toggleMute = useCallback((e) => {
    e.stopPropagation();
    const p = playerRef.current;
    if (!p) return;
    bumpControls();
    try {
      if (p.isMuted()) {
        p.unMute();
        setMuted(false);
        if (variant === 'short') shortsSoundOn = true;
      } else {
        p.mute();
        setMuted(true);
        if (variant === 'short') shortsSoundOn = false;
      }
    } catch (err) {}
  }, [bumpControls, variant]);

  const enterFullscreen = useCallback((e) => {
    e.stopPropagation();
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.requestFullscreen();
    } catch (err) {}
  }, []);

  const seek = useCallback((value) => {
    const v = Number(value) || 0;
    setCurrent(v);
    setPct(duration > 0 ? (v / duration) * 100 : 0);
    const p = playerRef.current;
    if (p && typeof p.seekTo === 'function') { try { p.seekTo(v, true); } catch (e) {} }
  }, [duration]);

  const onScrubDown = useCallback(() => { scrubbingRef.current = true; setScrubbing(true); setControlsOn(true); }, []);
  const onScrubUp = useCallback(() => { scrubbingRef.current = false; setScrubbing(false); bumpControls(); }, [bumpControls]);

  const showBigButton = !playing;

  // Compact player for the Shorts feed: no seek/time chrome, just the video and
  // a sound toggle. Everything else (swipe, captions) is handled by the feed, so
  // only the sound button opts back into pointer events (the wrapper is inert so
  // vertical swipes pass through).
  if (variant === 'short') {
    return (
      <div
        ref={wrapRef}
        style={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, background: '#000', overflow: 'hidden', userSelect: 'none', ...style }}
      >
        <div ref={mountRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        {!ready && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="spinner" style={{ width: 34, height: 34, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: theme.primary, borderRadius: '50%' }} />
          </div>
        )}
        <button
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
          style={{
            position: 'absolute', right: 12, bottom: 16, zIndex: 6, pointerEvents: 'auto',
            width: 42, height: 42, borderRadius: 21, border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)', color: '#fff', backdropFilter: 'blur(2px)',
          }}
        >
          {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      onMouseMove={bumpControls}
      onMouseLeave={() => { if (playing) setControlsOn(false); }}
      style={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, aspectRatio: fill ? undefined : '16/9', background: '#000', overflow: 'hidden', userSelect: 'none', ...style }}
    >
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />

      {!ready && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="spinner" style={{ width: 40, height: 40, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: theme.primary, borderRadius: '50%' }} />
        </div>
      )}

      {/* Click surface for play/pause */}
      <div
        onClick={togglePlay}
        style={{ position: 'absolute', inset: 0, cursor: 'pointer', background: showBigButton && started ? 'rgba(0,0,0,0.18)' : 'transparent', transition: 'background 0.2s' }}
      />

      {showBigButton && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{
            width: 66, height: 66, borderRadius: 33, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)',
          }}>
            <Play size={28} color="#fff" fill="#fff" style={{ marginLeft: 4 }} />
          </div>
        </div>
      )}

      {/* Bottom control bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, padding: '18px 12px 8px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0))',
          opacity: controlsOn ? 1 : 0, transition: 'opacity 0.25s', pointerEvents: controlsOn ? 'auto' : 'none',
        }}
      >
        <div
          onMouseDown={onScrubDown}
          onMouseUp={onScrubUp}
          onTouchStart={onScrubDown}
          onTouchEnd={onScrubUp}
          style={{ position: 'relative', height: 16, display: 'flex', alignItems: 'center', cursor: 'pointer', marginBottom: 4 }}
        >
          <div style={{ position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.28)' }} />
          <div style={{ position: 'absolute', left: 0, width: `${loadedFrac}%`, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.42)' }} />
          <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 4, borderRadius: 2, background: theme.primary }} />
          <div style={{ position: 'absolute', left: `calc(${pct}% - 7px)`, width: 14, height: 14, borderRadius: 7, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.5)', pointerEvents: 'none' }} />
          <input
            type="range"
            min={0}
            max={duration || 0}
            step="0.1"
            value={Math.min(current, duration || 0)}
            onChange={(e) => seek(e.target.value)}
            aria-label="Seek"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', margin: 0 }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#fff' }}>
          <button onClick={togglePlay} title={playing ? 'Pause' : 'Play'} style={btnStyle}>
            {playing ? <Pause size={18} fill="#fff" /> : <Play size={18} fill="#fff" />}
          </button>
          <button onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'} style={btnStyle}>
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', opacity: 0.95 }}>
            {fmtTime(current)} / {fmtTime(duration)}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={enterFullscreen} title="Fullscreen" style={btnStyle}>
            <Maximize size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}

const btnStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 32, height: 32, borderRadius: 8, border: 'none',
  background: 'transparent', color: '#fff', cursor: 'pointer', padding: 0,
};
