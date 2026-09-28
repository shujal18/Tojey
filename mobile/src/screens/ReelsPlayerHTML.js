/**
 * Double-buffered direct-stream player for the Reels screen.
 *
 * YouTube web embeds get throttled/gated when several devices behind one IP open
 * the same app at once ("second device just loads"). Instead of `youtube.com/embed`
 * iframe sessions, each reel is played from DIRECT signed stream URLs resolved by
 * our backend (yt-dlp) and pushed in by React Native via window.__setStream:
 * the layer holds a silent full-screen <video> (video-only mp4) plus a matched
 * <audio> (m4a) element, synced every few seconds. No anonymous embed session
 * exists, so multiple devices can stream at the same time and every device plays.
 *
 * The RN <-> WebView contract is otherwise identical to the old embed engine:
 *   window.__prime(id0, t0, id1, t1)      first reel visible + next warming
 *   window.__setStream(idx, id, v, a)     attach direct video/audio URLs to a slot
 *   window.__activate(idx, id, thumb)     settle on a cell (promote buffered layer)
 *   window.__preload(idx, id, thumb)      warm the off-screen layer
 *   window.__play / __pause / __destroy / __setMuted
 *
 * State events (playing/paused/buffering/ready/cued) and errors travel over
 * window.ReactNativeWebView.postMessage exactly as before; the RN watchdog needs
 * no changes.
 */

export const REELS_PLAYER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      background: #000;
      overflow: hidden;
      -webkit-user-select: none;
      user-select: none;
    }
    #wrap {
      position: absolute;
      top: 0; left: 0;
      width: 100vw;
      height: 100vh;
      background: #000;
    }
    .layer {
      position: absolute;
      top: 0; left: 0;
      width: 100vw;
      height: 100vh;
      background: #000;
      will-change: transform;
    }
    .layer .host {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
    }
    video, audio {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      -webkit-user-select: none;
      user-select: none;
      pointer-events: none;
    }
    audio { width: 0; height: 0; }
    .layer .thumb {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      background: #000 center / cover no-repeat;
      z-index: 10;
      transition: opacity 160ms ease-out;
    }
    .layer .thumb.hidden { display: none; }
    .spinner {
      position: absolute;
      top: 50%; left: 50%;
      width: 34px; height: 34px;
      margin: -17px 0 0 -17px;
      border: 3px solid rgba(255,255,255,0.25);
      border-top-color: #fff;
      border-radius: 50%;
      z-index: 20;
      animation: spin 0.8s linear infinite;
      display: none;
    }
    .spinner.show { display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="wrap">
    <div id="slotA" class="layer">
      <div class="host"></div><div class="thumb hidden"></div><div class="spinner"></div>
    </div>
    <div id="slotB" class="layer">
      <div class="host"></div><div class="thumb hidden"></div><div class="spinner"></div>
    </div>
  </div>

  <script>
    (function () {
      'use strict';

      var gen = 0;                 // generation token bumped on every (re)load
      var wantedMuted = false;     // user choice; warm start is always silent

      function createSlot(name, layerEl) {
        return {
          name: name,
          layerEl: layerEl,
          hostEl: layerEl.querySelector('.host'),
          thumbEl: layerEl.querySelector('.thumb'),
          spinnerEl: layerEl.querySelector('.spinner'),
          videoEl: null,
          audioEl: null,
          index: -1,
          videoId: null,
          token: 0,
          streamSet: false,
          watchdog: null,
          streamWatch: null,
          syncTimer: null,
          loopPending: false,
        };
      }

      var SLOT_A = createSlot('A', document.getElementById('slotA'));
      var SLOT_B = createSlot('B', document.getElementById('slotB'));
      var activeSlot = SLOT_A;
      var activeIndex = -1;

      // ---- bridge ----------------------------------------------------------
      function post(type, payload) {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
        var msg = { type: type };
        for (var k in (payload || {})) msg[k] = payload[k];
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }

      function activeVideoId() {
        return activeSlot && activeSlot.videoId;
      }

      function emit(event, extra) {
        var p = { event: event, videoId: activeVideoId() };
        for (var k in (extra || {})) p[k] = extra[k];
        post('ytPlayerEvent', p);
      }

      // ---- thumbnail / spinner --------------------------------------------
      function showThumb(slot, url) {
        if (url) slot.thumbEl.style.backgroundImage = 'url("' + String(url).replace(/"/g, '') + '")';
        slot.thumbEl.classList.remove('hidden');
      }
      function hideThumb(slot) { slot.thumbEl.classList.add('hidden'); }
      function spinnerOn(slot) { slot.spinnerEl.classList.add('show'); }
      function spinnerOff(slot) { slot.spinnerEl.classList.remove('show'); }

      // ---- volume ------------------------------------------------------------
      function applyVolume(slot) {
        if (slot.audioEl) {
          try { slot.audioEl.volume = wantedMuted ? 0 : 1; } catch (e) {}
        }
      }

      // ---- dead-load watchdog ----------------------------------------------
      // Fires only once a stream is attached (or the stream-waiting window is up),
      // and reports a BUFFER_TIMEOUT so RN jumps PAST a video that never plays
      // instead of parking on a static thumbnail.
      var WATCH_TICK = 1500;   // ms
      var WATCH_MAX = 6;       // buffering ticks -> ~9s worst case
      var STREAM_WAIT_MAX = 26; // ticks (~39s) waiting for __setStream before failing

      function slotDeadByWatch(slot) {
        var v = slot.videoEl;
        if (!slot.streamSet || !v) return false; // still waiting for a URL
        if (v.error) return false;               // error path handles directly
        if (v.paused) return false;              // intentionally paused by user
        // Playing = alive; stalled-forever-with-process = dead.
        if (v.readyState >= 3 && v.currentTime > 0) return false;
        return true;
      }

      function stopWatchdog(slot) {
        if (slot.watchdog) { clearInterval(slot.watchdog); slot.watchdog = null; }
        if (slot.streamWatch) { clearInterval(slot.streamWatch); slot.streamWatch = null; }
      }

      function startBehaviorWatch(slot) {
        if (!slot.watchdog && slot.streamSet && slot.videoEl) {
          var ticks = 0;
          slot.watchdog = setInterval(function () {
            ticks++;
            if (!slotDeadByWatch(slot)) { stopWatchdog(slot); return; }
            if (ticks < WATCH_MAX) return;
            stopWatchdog(slot);
            if (slot === activeSlot) {
              post('ytPlayerError', { errorCode: 'BUFFER_TIMEOUT', videoId: slot.videoId });
            } else {
              post('ytBufferError', { errorCode: 'BUFFER_TIMEOUT', videoId: slot.videoId });
            }
          }, WATCH_TICK);
        }
      }

      function startStreamWaitWatch(slot) {
        if (slot.streamWatch || slot.streamSet) return;
        var ticks = 0;
        slot.streamWatch = setInterval(function () {
          ticks++;
          if (slot.streamSet || slot.token !== slot.genRef) { stopWatchdog(slot); return; }
          if (ticks < STREAM_WAIT_MAX) return;
          stopWatchdog(slot);
          if (slot === activeSlot) {
            post('ytPlayerError', { errorCode: 'BUFFER_TIMEOUT', videoId: slot.videoId });
          } else {
            post('ytBufferError', { errorCode: 'BUFFER_TIMEOUT', videoId: slot.videoId });
          }
        }, WATCH_TICK);
      }

      // Sync the audio element to the video once drift grows past a sub-second
      // bound (audio-only + video-only files start on slightly different clocks).
      function startSync(slot) {
        stopSync(slot);
        if (!slot.videoEl || !slot.audioEl) return;
        slot.syncTimer = setInterval(function () {
          if (slot !== activeSlot) return;
          var v = slot.videoEl, a = slot.audioEl;
          if (!v || !a || v.paused || a.paused || v.error || a.error) return;
          try {
            var vt = v.audioElement ? v.currentTime : v.currentTime;
            var at = a.currentTime;
            if (isFinite(vt) && isFinite(at) && Math.abs(vt - at) > 0.45) {
              a.currentTime = vt;
            }
          } catch (e) {}
        }, 8000);
      }
      function stopSync(slot) {
        if (slot.syncTimer) { clearInterval(slot.syncTimer); slot.syncTimer = null; }
      }

      // ---- layer positioning ------------------------------------------------
      function offsetVh(slot) {
        if (slot.index < 0 || activeIndex < 0) return -9999;
        return (slot.index - activeIndex) * 100;
      }
      function applyPositions() {
        SLOT_A.layerEl.style.transform = 'translateY(' + offsetVh(SLOT_A) + 'vh)';
        SLOT_B.layerEl.style.transform = 'translateY(' + offsetVh(SLOT_B) + 'vh)';
      }

      // ---- element players ----------------------------------------------------
      function playPair(slot) {
        if (!slot.videoEl) return;
        try { var vp = slot.videoEl.play(); if (vp && vp.catch) vp.catch(function () {}); } catch (e) {}
        if (slot.audioEl) {
          try { var ap = slot.audioEl.play(); if (ap && ap.catch) ap.catch(function () {}); } catch (e) {}
        }
      }

      function pausePair(slot) {
        if (slot.videoEl) { try { slot.videoEl.pause(); } catch (e) {} }
        if (slot.audioEl) { try { slot.audioEl.pause(); } catch (e) {} }
      }

      function onPlaying(slot) {
        hideThumb(slot);
        spinnerOff(slot);
        stopWatchdog(slot);
        applyVolume(slot);
        startSync(slot);
        if (slot === activeSlot) emit('playing');
      }

      function onBuffering(slot) {
        if (slot !== activeSlot) return;
        hideThumb(slot);
        spinnerOn(slot);
        startBehaviorWatch(slot);
        emit('buffering');
      }

      function onLooped(slot) {
        if (slot.loopPending) return;
        slot.loopPending = true;
        var endOT = setTimeout(function () { slot.loopPending = false; }, 1500);
        if (slot.videoEl) { try { slot.videoEl.currentTime = 0; } catch (e) {} }
        if (slot.audioEl) { try { slot.audioEl.currentTime = 0; } catch (e) {} }
        playPair(slot);
        endOT; // keep loop from stacking
      }

      function onMediaError(slot, fromAudio) {
        stopWatchdog(slot);
        stopSync(slot);
        spinnerOff(slot);
        if (fromAudio && slot.videoEl) {
          // Audio failed: keep playing the silent video rather than killing it.
          try { slot.videoEl.play(); } catch (e) {}
          return;
        }
        if (slot === activeSlot) {
          post('ytPlayerError', { errorCode: 'STREAM_ERROR', videoId: slot.videoId });
        } else {
          post('ytBufferError', { errorCode: 'STREAM_ERROR', videoId: slot.videoId });
        }
      }

      function buildMedia(slot, videoUrl, audioUrl) {
        slot.hostEl.innerHTML = '';
        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'auto';
        video.src = videoUrl;
        slot.hostEl.appendChild(video);
        slot.videoEl = video;

        var audio = null;
        if (audioUrl) {
          audio = document.createElement('audio');
          audio.volume = 0;
          audio.preload = 'auto';
          audio.src = audioUrl;
          slot.hostEl.appendChild(audio);
          slot.audioEl = audio;
        } else {
          slot.audioEl = null;
        }

        video.addEventListener('playing', function () { onPlaying(slot); });
        video.addEventListener('waiting', function () { onBuffering(slot); });
        video.addEventListener('canplay', function () { if (slot === activeSlot) { spinnerOff(slot); } });
        video.addEventListener('ended', function () { onLooped(slot); });
        video.addEventListener('error', function () { onMediaError(slot, false); });
        video.addEventListener('stalled', function () { startBehaviorWatch(slot); });
        if (audio) {
          audio.addEventListener('error', function () { onMediaError(slot, true); });
        }
      }

      // ---- load a video into a slot (thumbnail-first, stream attached later) --
      function loadIntoSlot(slot, videoId, thumbUrl) {
        if (!videoId) {
          slot.index = -1;
          slot.videoId = null;
          slot.streamSet = false;
          hideThumb(slot);
          spinnerOff(slot);
          stopWatchdog(slot);
          stopSync(slot);
          slot.hostEl.innerHTML = '';
          slot.videoEl = null;
          slot.audioEl = null;
          return;
        }
        var token = (slot.token = ++gen);
        slot.genRef = token;
        slot.videoId = videoId;
        slot.streamSet = false;
        slot.loopPending = false;
        spinnerOff(slot);
        stopWatchdog(slot);
        stopSync(slot);
        slot.hostEl.innerHTML = '';
        slot.videoEl = null;
        slot.audioEl = null;
        showThumb(slot, thumbUrl);
        startStreamWaitWatch(slot);
      }

      // ---- attach direct stream URLs (called by RN when format resolves) ------
      window.__setStream = function (idx, videoId, videoUrl, audioUrl) {
        var slot = (SLOT_A.index === idx) ? SLOT_A : (SLOT_B.index === idx ? SLOT_B : null);
        if (!slot || slot.videoId !== videoId || !videoUrl) return;
        var token = slot.token;
        if (slot.streamSet) return;               // already attached
        slot.streamSet = true;
        buildMedia(slot, videoUrl, audioUrl || '');
        stopWatchdog(slot);
        stopSync(slot);
        hideThumb(slot);
        spinnerOff(slot);
        if (slot === activeSlot) emit('buffering');
        playPair(slot);
        // Accept our own generation after buildMedia bumped nothing - watchdog
        // still valid.
        if (slot.token !== token) return;
        startBehaviorWatch(slot);
        startSync(slot);
      };

      // ---- warm the off-screen layer with a neighbor ------------------------
      function preloadAt(idx, videoId, thumbUrl) {
        if (SLOT_A.index === idx && SLOT_B.index === idx) return; // weird; skip
        var target = (activeSlot === SLOT_A) ? SLOT_B : SLOT_A;
        if (target.index === idx && target.videoId === videoId) return; // already warmed
        target.index = idx;
        loadIntoSlot(target, videoId, thumbUrl);
        applyPositions();
      }

      // ---- promote / activate a cell ----------------------------------------
      function activateAt(idx, videoId, thumbUrl) {
        var target = (SLOT_A.index === idx) ? SLOT_A : (SLOT_B.index === idx ? SLOT_B : null);
        if (!target) {
          // Missed warm (fast reverse scroll / buffer error) -> load here fresh.
          target = (activeSlot === SLOT_A) ? SLOT_B : SLOT_A;
          target.index = idx;
          loadIntoSlot(target, videoId, thumbUrl);
        }
        target.videoId = videoId;
        activeIndex = idx;
        activeSlot = target;
        applyPositions();

        var v = target.videoEl;
        var st = -1;
        if (v) {
          try { st = v.readyState; } catch (e) { st = -1; }
          playPair(target);
          applyVolume(target);
          hideThumb(target);
        }
        if (st >= 3 && !v.paused && isFinite(v.currentTime) && v.currentTime > 0) {
          // Already buffered/playing -> report instantly.
          spinnerOff(target);
          stopWatchdog(target);
          startSync(target);
          emit('playing');
        } else if (target.streamSet) {
          spinnerOn(target);
          startBehaviorWatch(target);
          emit('buffering');
        } else {
          // No stream yet (format still resolving): retry until it lands.
          hideThumb(target);
          var attempts = 0;
          var timer = setInterval(function () {
            attempts++;
            if (activeSlot !== target || attempts >= 12) { clearInterval(timer); return; }
            var el = target.videoEl;
            if (el && !el.paused && el.currentTime > 0) {
              clearInterval(timer);
              onPlaying(target);
              return;
            }
            playPair(target);
          }, 600);
        }
      }

      // ---- RN commands -------------------------------------------------------
      window.__prime = function (id0, thumb0, id1, thumb1) {
        gen++;                       // cancel in-flight targets
        activeIndex = 0;
        SLOT_A.token = ++gen; SLOT_A.genRef = gen; SLOT_A.videoId = id0; SLOT_A.index = 0;
        SLOT_B.token = ++gen; SLOT_B.genRef = gen; SLOT_B.videoId = id1; SLOT_B.index = 1;
        activeSlot = SLOT_A;
        loadIntoSlot(SLOT_A, id0, thumb0);
        loadIntoSlot(SLOT_B, id1, thumb1);
        applyPositions();
      };

      window.__activate = function (idx, videoId, thumbUrl) {
        activateAt(idx, videoId, thumbUrl);
      };

      window.__preload = function (idx, videoId, thumbUrl) {
        preloadAt(idx, videoId, thumbUrl);
      };

      window.__retryPlay = function () {
        if (activeSlot) {
          playPair(activeSlot);
          applyVolume(activeSlot);
        }
      };

      window.__play = function () {
        if (activeSlot) {
          playPair(activeSlot);
          applyVolume(activeSlot);
        }
      };

      window.__pause = function () {
        [SLOT_A, SLOT_B].forEach(function (slot) { pausePair(slot); });
      };

      window.__setMuted = function (m) {
        wantedMuted = !!m;
        [SLOT_A, SLOT_B].forEach(function (slot) { applyVolume(slot); });
      };

      window.__destroy = function () {
        gen++;
        [SLOT_A, SLOT_B].forEach(function (slot) {
          stopWatchdog(slot);
          stopSync(slot);
          slot.videoEl = null;
          slot.audioEl = null;
          slot.hostEl.innerHTML = '';
          slot.index = -1;
          slot.videoId = null;
          slot.streamSet = false;
          slot.token = ++gen;
          slot.genRef = slot.token;
          spinnerOff(slot);
        });
        activeSlot = SLOT_A;
        activeIndex = -1;
      };

      emit('ready');
    })();
  </script>
</body>
</html>
`;