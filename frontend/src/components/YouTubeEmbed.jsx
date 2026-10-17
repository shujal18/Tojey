import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react';

// Official YouTube IFrame Player API, loaded once and cached. We keep YouTube's
// own control bar (`controls: 1`) so captions, quality, seeking, fullscreen and
// the unmute button all behave exactly like youtube.com. The only chrome we add
// on top is a slim skip -10s/+10s pair (Shorts and the watch screen) and, in the
// Shorts feed, a sound toggle so the feed can remember the viewer's choice.
//
// A single YT.Player instance is created per mount and reused across videoId
// changes via loadVideoById(), so swiping the Shorts feed never tears down and
// rebuilds the iframe (which caused the long black/buffering gap between clips).
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

export default function YouTubeEmbed({ videoId, autoPlay = true, onEnded, style, fill = false, variant = 'full', loop = false }) {
  const wrapRef = useRef(null);
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const readyRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(variant === 'short' && !shortsSoundOn);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);

  // Keep the latest props/values available inside the one-time player callbacks.
  const desiredIdRef = useRef(videoId);
  const variantRef = useRef(variant);
  const loopRef = useRef(loop);
  const autoPlayRef = useRef(autoPlay);
  variantRef.current = variant;
  loopRef.current = loop;
  autoPlayRef.current = autoPlay;

  const applyShortsSound = useCallback((p) => {
    try {
      if (variantRef.current === 'short') {
        if (shortsSoundOn) p.unMute(); else p.mute();
        setMuted(p.isMuted());
      } else {
        setMuted(p.isMuted());
      }
    } catch (e) {}
  }, []);

  // Create exactly one player. videoId changes are handled below.
  useEffect(() => {
    let cancelled = false;
    let unblockTimer = null;
    const host = mountRef.current;
    if (!host) return undefined;
    host.innerHTML = '';

    loadYouTubeApi().then((YT) => {
      if (cancelled || !mountRef.current) return;
      const holder = document.createElement('div');
      holder.style.width = '100%';
      holder.style.height = '100%';
      mountRef.current.appendChild(holder);

      const startId = desiredIdRef.current;
      playerRef.current = new YT.Player(holder, {
        videoId: startId,
        playerVars: {
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          fs: 1,
          disablekb: 0,
          iv_load_policy: 3,
          origin: window.location.origin,
        },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            readyRef.current = true;
            setReady(true);
            applyShortsSound(e.target);
            // A swipe may have happened before the API finished loading.
            if (desiredIdRef.current && desiredIdRef.current !== startId) {
              try { e.target.loadVideoById(desiredIdRef.current); applyShortsSound(e.target); } catch (err) {}
            }
            if (autoPlayRef.current) {
              try { e.target.playVideo(); } catch (err) {}
              // If autoplay was blocked by policy, retry muted so it still plays.
              unblockTimer = setTimeout(() => {
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
              try { setMuted(e.target.isMuted()); } catch (err) {}
            } else if (e.data === YTS.ENDED) {
              if (loopRef.current) {
                try { e.target.seekTo(0, true); e.target.playVideo(); } catch (err) {}
              } else {
                onEndedRef.current && onEndedRef.current();
              }
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (unblockTimer) clearTimeout(unblockTimer);
      const p = playerRef.current;
      if (p && typeof p.destroy === 'function') { try { p.destroy(); } catch (err) {} }
      playerRef.current = null;
      readyRef.current = false;
      if (mountRef.current) mountRef.current.innerHTML = '';
    };
  }, [applyShortsSound]);

  // Switch clips on the existing player (no iframe rebuild → no long buffer).
  useEffect(() => {
    desiredIdRef.current = videoId;
    const p = playerRef.current;
    if (!p || !readyRef.current || !videoId) return;
    try {
      if (autoPlayRef.current) p.loadVideoById(videoId);
      else p.cueVideoById(videoId);
      applyShortsSound(p);
    } catch (e) {}
  }, [videoId, applyShortsSound]);

  // Lightweight progress poll for the skip buttons.
  useEffect(() => {
    const t = setInterval(() => {
      const p = playerRef.current;
      if (!p || typeof p.getCurrentTime !== 'function') return;
      try {
        setCurrent(p.getCurrentTime() || 0);
        const d = p.getDuration() || 0;
        if (d) setDuration(d);
      } catch (e) {}
    }, 400);
    return () => clearInterval(t);
  }, []);

  const skipBy = useCallback((delta) => {
    const p = playerRef.current;
    if (!p || typeof p.seekTo !== 'function') return;
    try {
      const d = p.getDuration() || 0;
      const t = p.getCurrentTime() || 0;
      let next = t + delta;
      if (next < 0) next = 0;
      if (d && next > d - 0.4) next = Math.max(0, d - 0.4);
      p.seekTo(next, true);
      setCurrent(next);
    } catch (e) {}
  }, []);

  const toggleMute = useCallback((e) => {
    e.stopPropagation();
    const p = playerRef.current;
    if (!p) return;
    try {
      if (p.isMuted()) {
        p.unMute();
        setMuted(false);
        if (variantRef.current === 'short') shortsSoundOn = true;
      } else {
        p.mute();
        setMuted(true);
        if (variantRef.current === 'short') shortsSoundOn = false;
      }
    } catch (e) {}
  }, []);

  const skipBtn = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    width: 46, height: 46, border: 'none', borderRadius: 23, cursor: 'pointer',
    background: 'rgba(0,0,0,0.5)', color: '#fff', backdropFilter: 'blur(2px)',
    pointerEvents: 'auto', gap: 0, padding: 0, fontSize: 9, fontWeight: 800,
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, aspectRatio: (fill || variant === 'short') ? undefined : '16/9', background: '#000', overflow: 'hidden', userSelect: 'none', ...style }}
    >
      {/* The iframe keeps pointer events so YouTube's native controls (captions,
          seek, fullscreen, unmute) stay fully usable. Vertical swipes still
          scroll the Shorts feed: Chrome chains wheel/touch scroll from the
          (non-scrollable) iframe up to the feed. */}
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'auto' }} />

      {!ready && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="spinner" style={{ width: 36, height: 36, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: '#a855f7', borderRadius: '50%' }} />
        </div>
      )}

      {/* Forward / backward skip. Sits above YouTube's bottom control bar. */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, bottom: variant === 'short' ? 76 : 58,
          display: 'flex', justifyContent: 'center', gap: 26, pointerEvents: 'none', zIndex: 5,
        }}
      >
        <button onClick={(e) => { e.stopPropagation(); skipBy(-10); }} title="Back 10 seconds" style={skipBtn}>
          <RotateCcw size={17} />
          <span>10</span>
        </button>
        <button onClick={(e) => { e.stopPropagation(); skipBy(10); }} title="Forward 10 seconds" style={skipBtn}>
          <RotateCw size={17} />
          <span>10</span>
        </button>
      </div>

      {/* Shorts sound toggle. Lets the feed remember the choice; YouTube's own
          bar has its own mute button too. */}
      {variant === 'short' && (
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
      )}
    </div>
  );
}
