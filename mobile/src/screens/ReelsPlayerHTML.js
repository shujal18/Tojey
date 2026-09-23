/**
 * Single-active-player YouTube embed HTML for the Reels screen.
 *
 * One WebView hosts ONE YT IFrame player for the whole list. React Native tells
 * the page which video to load (>__loadVideo(id, thumbUrl)); the page swaps the
 * underlying player's video via loadVideoById() and reports state changes back
 * through window.ReactNativeWebView.postMessage — the ONLY bridge that works.
 *
 * Thumbnail-first: an <img> sits above the player and stays visible until the
 * new video reports PLAYING, so swipes never show a black/white flash.
 *
 * Race protection: every load gets a generation token; late-resolving loads
 * (API not ready, slow network) are dropped if a newer generation superseded it.
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
    #player-wrap {
      position: absolute;
      top: 0; left: 0;
      width: 100vw;
      height: 100vh;
      background: #000;
    }
    #preload-frame {
      position: absolute;
      top: 0; left: 0;
      width: 1px; height: 1px;
      overflow: hidden;
      visibility: hidden;
    }
    #player, #player-frame {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
    }
    #thumb {
      position: absolute;
      top: 0; left: 0;
      width: 100%;
      height: 100%;
      background: #000 center / cover no-repeat;
      z-index: 20;
      transition: opacity 160ms ease-out;
    }
    #thumb.hidden { display: none; }
    #spinner {
      position: absolute;
      top: 50%; left: 50%;
      width: 34px; height: 34px;
      margin: -17px 0 0 -17px;
      border: 3px solid rgba(255,255,255,0.25);
      border-top-color: #fff;
      border-radius: 50%;
      z-index: 30;
      animation: spin 0.8s linear infinite;
      display: none;
    }
    #spinner.show { display: block; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="player-wrap">
    <div id="player-frame"><div id="player"></div></div>
    <div id="thumb"></div>
    <div id="spinner"></div>
  </div>
  <div id="preload-frame"><div id="preload-host"></div></div>

  <script>
    (function () {
      'use strict';

      var gen = 0;                 // generation token: drops stale loads
      var currentVideoId = null;   // videoId currently loaded in the player
      var player = null;           // YT.Player instance (the visible reel)
      var playerReady = false;     // onReady fired
      var apiLoading = false;      // iframe_api script in flight
      var apiCallbacks = [];       // callbacks waiting for the IFrame API
      var preloadPlayer = null;    // hidden warm-up player for the NEXT reel
      var preloadVideoId = null;   // videoId currently cued in preloadPlayer

      var thumbEl = document.getElementById('thumb');
      var spinnerEl = document.getElementById('spinner');

      // ---- bridge ----------------------------------------------------------
      function post(type, payload) {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
        var msg = { type: type };
        for (var k in (payload || {})) msg[k] = payload[k];
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }

      function emit(event, extra) {
        var p = { event: event, videoId: currentVideoId };
        for (var k in (extra || {})) p[k] = extra[k];
        post('ytPlayerEvent', p);
      }

      // ---- thumbnail / spinner --------------------------------------------
      function showThumb(url) {
        if (url) thumbEl.style.backgroundImage = 'url("' + url.replace(/"/g, '') + '")';
        thumbEl.classList.remove('hidden');
      }

      function hideThumb() {
        thumbEl.classList.add('hidden');
      }

      // ---- player wiring ----------------------------------------------------
      // Autoplay must START muted (Android WebView blocks unmuted programmatic
      // autoplay), but Chrome/YouTube allow unmuting a muted-autoplay video once
      // playback has begun — so audio comes out normally on autoplay.
      function unmutePlayback() {
        if (!player) return;
        try { player.unMute(); } catch (e) {}
        try { player.setVolume(100); } catch (e) {}
      }

      // Muted start + retries: keep nudging until the player reports PLAYING.
      function forcePlay() {
        if (!player) return;
        try { player.mute(); } catch (e) {}
        try { player.playVideo(); } catch (e) {}
        var attempts = 0;
        var timer = setInterval(function () {
          attempts++;
          if (attempts >= 8) { clearInterval(timer); return; }
          try {
            var st = player.getPlayerState ? player.getPlayerState() : -1;
            if (st === 1) { clearInterval(timer); return; } // PLAYING
            player.mute();
            player.playVideo();
          } catch (e) { clearInterval(timer); }
        }, 700);
      }

      function onPlayerReady() {
        playerReady = true;
        emit('ready');
        forcePlay();
      }

      function onStateChange(event) {
        var st = event && event.data;
        if (st === 1) {           // PLAYING
          hideThumb();
          spinnerEl.classList.remove('show');
          unmutePlayback();       // audio on while autoplaying (user requested)
          emit('playing');
        } else if (st === 2) {    // PAUSED
          emit('paused');
        } else if (st === 3) {    // BUFFERING
          spinnerEl.classList.add('show');
          emit('buffering');
        } else if (st === 0) {    // ENDED -> loop
          if (player) {
            try { player.seekTo(0); player.playVideo(); } catch (e) {}
          }
        } else if (st === 5) {    // CUED
          emit('cued');
        }
      }

      function onError(event) {
        var code = event && event.data;
        console.log('[YoutubeEmbed] error ' + code + ' for ' + currentVideoId);
        spinnerEl.classList.remove('show');
        post('ytPlayerError', { errorCode: code, videoId: currentVideoId });
      }

      function buildPlayer(videoId) {
        // YT.Player replaces its host element with an iframe, so create a fresh
        // host each time to make re-creation after destroy safe.
        var frame = document.getElementById('player-frame');
        frame.innerHTML = '';
        var host = document.createElement('div');
        frame.appendChild(host);

        player = new YT.Player(host, {
          host: 'https://www.youtube-nocookie.com',
          videoId: videoId,
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
            onReady: onPlayerReady,
            onStateChange: onStateChange,
            onError: onError
          }
        });
      }

      // ---- IFrame API bootstrap --------------------------------------------
      function ensureAPI(cb) {
        if (window.YT && window.YT.Player) {
          cb();
          return;
        }
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

      // ---- public commands (called via injectJavaScript from RN) ------------
      window.__loadVideo = function (videoId, thumbUrl) {
        var myGen = ++gen;
        currentVideoId = videoId;
        spinnerEl.classList.remove('show');
        showThumb(thumbUrl);          // thumbnail-first; stays until PLAYING

        ensureAPI(function (err) {
          if (err) {
            post('ytPlayerError', { errorCode: 'API_LOAD_FAILED', videoId: videoId });
            return;
          }
          if (myGen !== gen || !currentVideoId) return; // superseded
          if (player && player.loadVideoById) {
            try {
              player.loadVideoById({ videoId: videoId, startSeconds: 0 });
              player.mute();
              player.playVideo();
            } catch (e) {}
            return;
          }
          buildPlayer(videoId);
        });
      };

      window.__retryPlay = function () {
        forcePlay();
      };

      // Preload the NEXT reel in the background so the swipe plays instantly.
      // A SEPARATE hidden player warms the next video via cueVideoById() — never
      // the visible one, because cueing stops whatever is currently playing.
      // The hidden player has no state-change listeners, so it can't disturb the
      // visible player's events or the RN-side current-video tracking.
      function ensurePreloadPlayer() {
        if (preloadPlayer) return;
        if (!window.YT || !window.YT.Player) return;
        var host = document.getElementById('preload-host');
        preloadPlayer = new YT.Player(host, {
          host: 'https://www.youtube-nocookie.com',
          width: 1,
          height: 1,
          playerVars: {
            autoplay: 0,
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
            onError: function () { preloadPlayer = null; preloadVideoId = null; }
          }
        });
      }

      window.__cueVideo = function (videoId) {
        var id = videoId ? String(videoId) : '';
        if (!id) return;
        if (preloadPlayer && preloadVideoId === id) return; // already warmed
        ensurePreloadPlayer();
        if (!preloadPlayer) return;
        try {
          preloadPlayer.cueVideoById({ videoId: id, startSeconds: 0 });
          preloadVideoId = id;
        } catch (e) {}
      };

      window.__play = function () {
        if (player && player.playVideo) { try { player.unMute(); player.playVideo(); } catch (e) {} }
      };

      window.__pause = function () {
        if (player && player.pauseVideo) { try { player.pauseVideo(); } catch (e) {} }
      };

      window.__destroy = function () {
        gen++;                       // invalidate anything in flight
        spinnerEl.classList.remove('show');
        try { if (player && player.destroy) player.destroy(); } catch (e) {}
        player = null;
        playerReady = false;
        currentVideoId = null;
        try { if (preloadPlayer && preloadPlayer.destroy) preloadPlayer.destroy(); } catch (e) {}
        preloadPlayer = null;
        preloadVideoId = null;
      };
    })();
  </script>
</body>
</html>
`;