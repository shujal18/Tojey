// Offline player layer for the Downloads screen.
//
// Plays a locally saved adaptive pair (video-only mp4 + audio-only m4a) back from
// file:// URLs. Same <video>+<audio> sync trick as the (parked) live stream player,
// plus a small overlay with the title, a spinner and a "tap to play" affordance.
// RN drives it with:
//   window.__load(videoUrl, audioUrl, title, muted)
//   window.__play() / __pause()
// Events bubble over postMessage as { type:'ytPlayerEvent', event, videoId }.

export const OFFLINE_PLAYER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #100B1A; overflow: hidden; }
    #stage { position: absolute; inset: 0; background: #000; }
    video {
      position: absolute; inset: 0; width: 100%; height: 100%;
      object-fit: contain; background: #000;
    }
    audio { display: none; }
    #overlay {
      position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 14px;
      background: linear-gradient(transparent, rgba(16, 11, 26, 0.92));
      color: #fff; font-family: sans-serif;
      display: none;
    }
    #overlay.show { display: block; }
    #title { font-size: 15px; font-weight: 600; line-height: 1.35; }
    #spinner {
      position: absolute; top: 50%; left: 50%; width: 40px; height: 40px;
      margin: -20px 0 0 -20px; border: 3px solid rgba(255,255,255,0.22);
      border-top-color: #8B5CF6; border-radius: 50%;
      animation: spin .8s linear infinite; display: none;
    }
    #spinner.show { display: block; }
    #bigplay {
      position: absolute; top: 50%; left: 50%; width: 72px; height: 72px;
      margin: -36px 0 0 -36px; border-radius: 50%;
      background: rgba(16, 11, 26, 0.65); border: 1px solid rgba(255,255,255,0.25);
      color: #fff; display: none; align-items: center; justify-content: center;
    }
    #bigplay.show { display: flex; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="spinner"></div>
  <div id="bigplay">▶</div>
  <div id="overlay"><div id="title"></div></div>
  <script>
    (function () {
      'use strict';
      var video = null, audio = null;
      var stopped = false;
      var titleEl = document.getElementById('title');
      var spinner = document.getElementById('spinner');
      var bigplay = document.getElementById('bigplay');
      var overlay = document.getElementById('overlay');
      var wantedMuted = false;
      var syncTimer = null;

      function post(type, payload) {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
        var msg = { type: type };
        for (var k in (payload || {})) msg[k] = payload[k];
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
      function emit(event) { post('ytPlayerEvent', { event: event, videoId: location.hash.slice(1) || null }); }

      function applyVolume() {
        if (audio) audio.volume = wantedMuted ? 0 : 1;
      }
      function playPair() {
        if (stopped) return;
        if (video && video.paused) video.play().catch(function () {});
        if (audio && audio.paused) audio.play().catch(function () {});
      }
      function onPlaying() {
        spinner.classList.remove('show');
        bigplay.classList.remove('show');
        emit('playing');
      }
      function onWaiting() {
        spinner.classList.add('show');
        emit('buffering');
      }
      function onStalled() { if (video && video.paused) spinner.classList.add('show'); }

      function startSync() {
        stopSync();
        if (!video || !audio) return;
        syncTimer = setInterval(function () {
          if (!video || !audio || stopped || video.paused || audio.error) return;
          var vt = video.currentTime, at = audio.currentTime;
          if (isFinite(vt) && isFinite(at) && Math.abs(vt - at) > 0.45) {
            audio.currentTime = vt;
          }
        }, 8000);
      }
      function stopSync() { if (syncTimer) { clearInterval(syncTimer); syncTimer = null; } }

      window.__load = function (videoUrl, audioUrl, title, muted) {
        var stage = document.getElementById('stage');
        stage.innerHTML = '';
        video = document.createElement('video');
        video.muted = true; video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.preload = 'auto';
        video.src = videoUrl;
        stage.appendChild(video);
        audio = null;
        if (audioUrl) {
          audio = document.createElement('audio');
          audio.preload = 'auto';
          audio.src = audioUrl;
          stage.appendChild(audio);
        }
        stopped = false;
        wantedMuted = !!muted;
        applyVolume();
        if (title) { titleEl.textContent = title; overlay.classList.add('show'); } else { overlay.classList.remove('show'); }
        spinner.classList.add('show');
        video.addEventListener('playing', onPlaying);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('stalled', onStalled);
        video.addEventListener('ended', function () { video.currentTime = 0; if (audio) audio.currentTime = 0; playPair(); });
        video.addEventListener('error', function () { if (!stopped) { spinner.classList.remove('show'); post('ytPlayerError', { errorCode: 'OFFLINE_ERROR' }); } });
        playPair();
        startSync();
      };

      window.__play = function () { playPair(); };
      window.__pause = function () { if (video) video.pause(); if (audio) audio.pause(); };
      window.__setMuted = function (m) { wantedMuted = !!m; applyVolume(); };
      window.__destroy = function () {
        stopped = true;
        stopSync();
        if (video) { video.removeAttribute('src'); video.pause(); }
        if (audio) { audio.removeAttribute('src'); audio.pause(); }
      };

      document.addEventListener('click', playPair);
      emit('ready');
    })();
  </script>
</body>
</html>
`;