import React, { useCallback, useEffect, useRef, useState } from 'react';
import { VolumeX } from 'lucide-react';

// Official YouTube IFrame Player API, loaded once and cached.
//
// Shorts (`variant="short"`): the player runs with YouTube's own control chrome
// DISABLED (`controls: 0`). That chrome — the `.ytp-chrome-bottom` control bar
// and its `.ytp-gradient-bottom` dark band — is what painted the "horizontal
// black line" across the video whenever the controls appeared, and it also sat
// on top of the caption/duration. YouTube's own mobile Shorts player shows no
// such bar either, so we draw a single tap-to-play/pause layer instead and drive
// playback through the API. The iframe is non-interactive (`pointerEvents:
// none`) so vertical wheel/touch scrolling still chains to the feed.
//
// Watch (`variant="full"`): keep YouTube's native controls (seek, volume,
// captions, fullscreen) — that is a normal video, not an immersive feed.
//
// One YT.Player is created per mount and reused across videoId changes through
// loadVideoById(), so switching clips never tears down/rebuilds the iframe
// (which previously caused the long black/buffering gap between Shorts).
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

export default function YouTubeEmbed({
  videoId,
  autoPlay = true,
  onEnded,
  onError,
  onProgress,
  onController,
  style,
  fill = false,
  variant = 'full',
  loop = false,
  paused = false,
}) {
  const mountRef = useRef(null);
  const playerRef = useRef(null);
  const readyRef = useRef(false);

  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const onProgressRef = useRef(onProgress);
  const onControllerRef = useRef(onController);
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  onProgressRef.current = onProgress;
  onControllerRef.current = onController;

  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(variant === 'short' ? !shortsSoundOn : false);

  const desiredIdRef = useRef(videoId);
  const variantRef = useRef(variant);
  const autoPlayRef = useRef(autoPlay);
  const loopRef = useRef(loop);
  const pausedRef = useRef(paused);
  variantRef.current = variant;
  autoPlayRef.current = autoPlay;
  loopRef.current = loop;
  pausedRef.current = paused;

  const reportMute = useCallback((m) => { setMuted(m); }, []);

  const applySound = useCallback((p) => {
    try {
      if (variantRef.current === 'short') {
        if (shortsSoundOn) p.unMute(); else p.mute();
      }
      reportMute(p.isMuted());
    } catch (e) {}
  }, [reportMute]);

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

      const isShort = variantRef.current === 'short';
      const startId = desiredIdRef.current;
      playerRef.current = new YT.Player(holder, {
        videoId: startId,
        playerVars: isShort
          // No YouTube chrome at all for Shorts: this is what removes the black
          // control bar/gradient overlay.
          ? { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, origin: window.location.origin }
          : { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, origin: window.location.origin },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            readyRef.current = true;
            setReady(true);
            applySound(e.target);
            // A swipe may have happened before the API finished loading.
            if (desiredIdRef.current && desiredIdRef.current !== startId) {
              try { e.target.loadVideoById(desiredIdRef.current); applySound(e.target); } catch (err) {}
            }
            if (autoPlayRef.current && !pausedRef.current) {
              try { e.target.playVideo(); } catch (err) {}
              // Autoplay policies block unmuted playback: retry muted so the
              // feed still plays, and let a tap restore sound (see toggleMute).
              unblockTimer = setTimeout(() => {
                const p = playerRef.current;
                if (!p || cancelled) return;
                try {
                  if (p.getPlayerState() !== YT.PlayerState.PLAYING && variantRef.current === 'short' && !shortsSoundOn) {
                    p.mute();
                    reportMute(true);
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
              applySound(e.target);
            } else if (e.data === YTS.ENDED) {
              if (loopRef.current) {
                try { e.target.seekTo(0, true); e.target.playVideo(); } catch (err) {}
              } else if (onEndedRef.current) {
                onEndedRef.current();
              }
            }
          },
          onError: (e) => {
            if (cancelled) return;
            if (onErrorRef.current) onErrorRef.current(e && e.data);
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
  }, [applySound]);

  // Switch clips on the existing player (no iframe rebuild → no long buffer).
  useEffect(() => {
    desiredIdRef.current = videoId;
    const p = playerRef.current;
    if (!p || !readyRef.current || !videoId) return;
    try {
      if (autoPlayRef.current && !pausedRef.current) p.loadVideoById(videoId);
      else p.cueVideoById(videoId);
      applySound(p);
    } catch (e) {}
  }, [videoId, applySound]);

  // React to the parent's play/pause intent (Shorts tap-to-play/pause).
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    try {
      if (paused) {
        p.pauseVideo();
      } else {
        p.playVideo();
        if (variantRef.current === 'short' && shortsSoundOn) p.unMute();
      }
    } catch (e) {}
  }, [paused]);

  // Register an imperative controller when the YT iframe API is ready so
  // Watch Together can drive play/pause/seek even when native playback falls
  // back to the embed (e.g. Render egress blocked).
  useEffect(() => {
    const register = onControllerRef.current;
    if (!register) return undefined;
    if (variant !== 'full') return undefined;
    let cancelled = false;
    let ctrl = null;
    loadYouTubeApi().then(() => {
      if (cancelled) return;
      const p = playerRef.current;
      if (!p) return;
      ctrl = {
        isEmbed: true,
        isReady: () => readyRef.current,
        getTime: () => {
          try { return p.getCurrentTime ? p.getCurrentTime() || 0 : 0; } catch (e) { return 0; }
        },
        isPaused: () => {
          try {
            const YTS = window.YT && window.YT.PlayerState;
            const s = p.getPlayerState ? p.getPlayerState() : null;
            return s !== YTS.PLAYING && s !== YTS.BUFFERING;
          } catch (e) { return true; }
        },
        play: () => { try { p.playVideo(); } catch (e) {} },
        pause: () => { try { p.pauseVideo(); } catch (e) {} },
        seek: (t) => { try { p.seekTo(Math.max(0, t), true); } catch (e) {} },
        setRate: (r) => { try { if (p.setPlaybackRate) p.setPlaybackRate(r); } catch (e) {} },
      };
      try { register(ctrl); } catch (e) {}
    });
    return () => {
      cancelled = true;
      try { if (onControllerRef.current) onControllerRef.current(null); } catch (e) {}
    };
  }, [variant, videoId, ready]);

  // Progress poll: drives the Shorts progress bar and reports length upward.
  useEffect(() => {
    const t = setInterval(() => {
      const p = playerRef.current;
      if (!p || typeof p.getCurrentTime !== 'function') return;
      try {
        const current = p.getCurrentTime() || 0;
        const duration = p.getDuration() || 0;
        if (onProgressRef.current) onProgressRef.current(current, duration);
      } catch (e) {}
    }, 500);
    return () => clearInterval(t);
  }, []);

  const toggleMute = useCallback((e) => {
    e.stopPropagation();
    const p = playerRef.current;
    if (!p) return;
    try {
      if (p.isMuted()) {
        shortsSoundOn = true;
        p.unMute();
        reportMute(false);
        if (!pausedRef.current) p.playVideo();
      } else {
        shortsSoundOn = false;
        p.mute();
        reportMute(true);
      }
    } catch (e) {}
  }, [reportMute]);

  const isShort = variant === 'short';

  return (
    <div
      style={{ position: 'relative', width: '100%', height: fill ? '100%' : undefined, aspectRatio: (fill || isShort) ? undefined : '16/9', background: '#000', overflow: 'hidden', userSelect: 'none', ...style }}
    >
      <style>{'.ytp-chrome-bottom,.ytp-gradient-bottom,.ytp-show-cards-title,.ytp-pause-overlay{display:none!important;}'}</style>
      {/* Shorts: no pointer events on the iframe so taps hit the feed's own
          play/pause handler and vertical swipes still scroll. Watch: keep it
          interactive for YouTube's native controls. */}
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: isShort ? 'none' : 'auto' }} />

      {!ready && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="spinner" style={{ width: 36, height: 36, border: '3px solid rgba(255,255,255,0.25)', borderTopColor: '#a855f7', borderRadius: '50%' }} />
        </div>
      )}

      {/* Minimal sound affordance: only appears when the clip is muted, so it
          never clutters an otherwise clean Short. Tap to enable audio. */}
      {isShort && muted && (
        <button
          onClick={toggleMute}
          title="Unmute"
          style={{
            position: 'absolute', right: 14, bottom: 96, zIndex: 6, pointerEvents: 'auto',
            width: 42, height: 42, borderRadius: 21, border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.55)', color: '#fff', backdropFilter: 'blur(2px)',
          }}
        >
          <VolumeX size={19} />
        </button>
      )}
    </div>
  );
}
