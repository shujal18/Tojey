/**
 * Double-buffered YouTube embed player for the Reels screen.
 *
 * One WebView hosts TWO full-screen layers (A / B). While reel N plays in the
 * visible layer, the other layer sits one viewport off-screen and has ALREADY
 * loadVideoById'd + started muted playback of reel N+1 (or N-1 on up-swipes),
 * so the media is actually buffered. Swiping to the next cell just promotes
 * the already-playing layer -> near-zero-delay transitions with no
 * thumbnail/black flash between reels.
 *
 * React Native drives it through injectJavaScript:
 *   window.__prime(id0, thumb0, id1, thumb1)  first reel visible + next warming
 *   window.__activate(idx, id, thumb)         settle on a cell (promotes buffer)
 *   window.__preload(idx, id, thumb)          warm the off-screen layer
 *   window.__play / __pause / __destroy
 *
 * Layer positioning: a layer holding video k is translated to
 * (k - activeIndex) * 100vh inside the WebView, so it always maps exactly onto
 * physical cell k regardless of where the WebView overlay currently sits.
 *
 * Events bridge via window.ReactNativeWebView.postMessage — the only reliable
 * RN->WebView->RN channel. The ACTIVE layer reports state (playing/paused/
 * buffering) + errors; the off-screen buffer reports errors as ytBufferError.
 *
 * Race protection: every load carries a per-slot generation token; late
 * resolves (slow API bootstrap/network) drop if a newer target superseded them.
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

      var gen = 0;                 // global generation-ish; bumped on destroy
      var apiLoading = false;
      var apiCallbacks = [];

      function createSlot(name, layerEl) {
        return {
          name: name,
          layerEl: layerEl,
          hostEl: layerEl.querySelector('.host'),
          thumbEl: layerEl.querySelector('.thumb'),
          spinnerEl: layerEl.querySelector('.spinner'),
          player: null,
          index: -1,
          videoId: null,
          token: 0,
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

      // ---- layer positioning ------------------------------------------------
      // Layer holding index k maps onto physical cell k: offset (k - activeIndex)*100vh.
      function offsetVh(slot) {
        if (slot.index < 0 || activeIndex < 0) return -9999;
        return (slot.index - activeIndex) * 100;
      }
      function applyPositions() {
        SLOT_A.layerEl.style.transform = 'translateY(' + offsetVh(SLOT_A) + 'vh)';
        SLOT_B.layerEl.style.transform = 'translateY(' + offsetVh(SLOT_B) + 'vh)';
      }

      // ---- player wiring ----------------------------------------------------
      function onStateChange(slot, st) {
        if (slot !== activeSlot) {
          // Buffer: just keep it buffering; hide its own thumbnail when it plays
          // (no events to RN — RN tracks only the active layer).
          if (st === 1) hideThumb(slot);
          return;
        }
        if (st === 1) {                 // PLAYING
          hideThumb(slot);
          spinnerOff(slot);
          unmuteIfAutoplayed(slot);
          emit('playing');
        } else if (st === 2) {          // PAUSED
          emit('paused');
        } else if (st === 3) {          // BUFFERING
          spinnerOn(slot);
          emit('buffering');
        } else if (st === 0) {          // ENDED -> loop
          if (slot.player) { try { slot.player.seekTo(0); slot.player.playVideo(); } catch (e) {} }
        } else if (st === 5) {          // CUED
          emit('cued');
        }
      }

      function onError(slot, code) {
        spinnerOff(slot);
        if (slot === activeSlot) {
          post('ytPlayerError', { errorCode: code, videoId: slot.videoId });
        } else {
          post('ytBufferError', { errorCode: code, videoId: slot.videoId });
        }
      }

      // Autoplay must START muted (Android WebView blocks unmuted programmatic
      // autoplay), but Chrome/YouTube allow unmuting once playback has begun.
      function unmuteIfAutoplayed(slot) {
        if (!slot.player) return;
        try { slot.player.unMute(); } catch (e) {}
        try { slot.player.setVolume(100); } catch (e) {}
      }

      function forcePlay(slot) {
        if (!slot.player) return;
        try { slot.player.mute(); } catch (e) {}
        try { slot.player.playVideo(); } catch (e) {}
      }

      function buildPlayer(slot) {
        slot.hostEl.innerHTML = '';
        var host = document.createElement('div');
        slot.hostEl.appendChild(host);
        slot.player = new YT.Player(host, {
          host: 'https://www.youtube-nocookie.com',
          width: window.innerWidth,
          height: window.innerHeight,
          playerVars: {
            autoplay: 1,
            mute: 1,
            playsinline: 1,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            iv_load_policy: 3,
            disablekb: 1,
            fs: 0,
            enablejsapi: 1,
            widget_referrer: 'https://tojey.app/'
          },
          events: {
            onReady: function () { forcePlay(slot); },
            onStateChange: function (e) { onStateChange(slot, e && e.data); },
            onError: function (e) { onError(slot, e && e.data); }
          }
        });
      }

      // ---- IFrame API bootstrap --------------------------------------------
      function ensureAPI(cb) {
        if (window.YT && window.YT.Player) { cb(null); return; }
        apiCallbacks.push(cb);
        if (apiLoading) return;
        apiLoading = true;
        var tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.onerror = function () {
          apiLoading = false;
          var list = apiCallbacks.splice(0);
          list.forEach(function (c) { c(new Error('youtube_iframe_api_load_failed')); });
        };
        document.head.appendChild(tag);
        window.onYouTubeIframeAPIReady = function () {
          apiLoading = false;
          var list = apiCallbacks.splice(0);
          list.forEach(function (c) { c(null); });
        };
      }

      // ---- load a video into a slot (thumbnail-first, muted warm start) -----
      function loadIntoSlot(slot, videoId, thumbUrl) {
        if (!videoId) {                 // nothing to load: clear the slot
          slot.index = -1;
          slot.videoId = null;
          hideThumb(slot);
          spinnerOff(slot);
          return;
        }
        var token = (slot.token = ++gen);
        slot.videoId = videoId;
        spinnerOff(slot);
        showThumb(slot, thumbUrl);

        ensureAPI(function (err) {
          if (err) {
            if (slot === activeSlot) {
              post('ytPlayerError', { errorCode: 'API_LOAD_FAILED', videoId: videoId });
            } else {
              post('ytBufferError', { errorCode: 'API_LOAD_FAILED', videoId: videoId });
            }
            return;
          }
          if (slot.token !== token) return;   // superseded
          if (slot.player && slot.player.loadVideoById) {
            try {
              slot.player.loadVideoById({ videoId: videoId, startSeconds: 0 });
              slot.player.mute();
              slot.player.playVideo();        // warm: fetch + buffer media now
            } catch (e) {}
            return;
          }
          buildPlayer(slot);                  // onReady -> forcePlay (muted)
        });
      }

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
          // Missed warm (fast reverse scroll / buffer error) -> load here with qs spinner.
          target = (activeSlot === SLOT_A) ? SLOT_B : SLOT_A;
          target.index = idx;
          loadIntoSlot(target, videoId, thumbUrl);
        }
        target.videoId = videoId;
        activeIndex = idx;
        activeSlot = target;
        applyPositions();

        var p = activeSlot.player;
        var st = -1;
        if (p) {
          try { p.unMute(); p.setVolume(100); } catch (e) {}
          try { p.playVideo(); } catch (e) {}
          try { st = p.getPlayerState(); } catch (e) {}
        }
        if (st === 1) {           // already buffered/playing -> report instantly
          hideThumb(activeSlot);
          spinnerOff(activeSlot);
          emit('playing');
        } else if (st === 3) {
          spinnerOn(activeSlot);
          emit('buffering');
        } else {
          // Not started yet: retry a few times so a slow first load still plays.
          var attempts = 0;
          var timer = setInterval(function () {
            attempts++;
            if (activeSlot !== target || attempts >= 8) { clearInterval(timer); return; }
            try {
              var s = target.player.getPlayerState();
              if (s === 1) { clearInterval(timer); return; }
              target.player.mute();
              target.player.playVideo();
            } catch (e) { clearInterval(timer); }
          }, 600);
        }
      }

      // ---- RN commands -------------------------------------------------------
      window.__prime = function (id0, thumb0, id1, thumb1) {
        gen++;                       // cancel in-flight targets
        activeIndex = 0;
        SLOT_A.token = ++gen; SLOT_A.videoId = id0; SLOT_A.index = 0;
        SLOT_B.token = ++gen; SLOT_B.videoId = id1; SLOT_B.index = 1;
        activeSlot = SLOT_A;
        loadIntoSlot(SLOT_A, id0, thumb0);
        loadIntoSlot(SLOT_B, id1, thumb1);
        applyPositions();
        var p = SLOT_A.player;
        if (p) { try { p.playVideo(); } catch (e) {} }
      };

      window.__activate = function (idx, videoId, thumbUrl) {
        activateAt(idx, videoId, thumbUrl);
      };

      window.__preload = function (idx, videoId, thumbUrl) {
        preloadAt(idx, videoId, thumbUrl);
      };

      window.__retryPlay = function () {
        if (activeSlot && activeSlot.player) {
          try { activeSlot.player.unMute(); activeSlot.player.playVideo(); } catch (e) {}
        }
      };

      window.__play = function () {
        if (activeSlot && activeSlot.player) {
          try { activeSlot.player.unMute(); activeSlot.player.playVideo(); } catch (e) {}
        }
      };

      window.__pause = function () {
        [SLOT_A, SLOT_B].forEach(function (slot) {
          if (slot && slot.player) { try { slot.player.pauseVideo(); } catch (e) {} }
        });
      };

      window.__destroy = function () {
        gen++;
        [SLOT_A, SLOT_B].forEach(function (slot) {
          try { if (slot.player && slot.player.destroy) slot.player.destroy(); } catch (e) {}
          slot.player = null;
          slot.index = -1;
          slot.videoId = null;
          slot.token = ++gen;
          spinnerOff(slot);
        });
        activeSlot = SLOT_A;
        activeIndex = -1;
      };
    })();
  </script>
</body>
</html>
`;