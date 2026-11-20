// Offline player layer for the Downloads screen.
//
// Plays a locally saved adaptive pair (video-only mp4 + audio-only m4a) back from
// file:// URLs. Same <video>+<audio> sync trick as the live player, plus a real
// custom controller (play/pause, scrub, skip and mute) rendered inside WebView.
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
    #tap { position: absolute; inset: 0; z-index: 2; }
    #spinner {
      position: absolute; top: 50%; left: 50%; width: 40px; height: 40px;
      margin: -20px 0 0 -20px; border: 3px solid rgba(255,255,255,0.22);
      border-top-color: #8B5CF6; border-radius: 50%;
      animation: spin .8s linear infinite; display: none; z-index: 4;
    }
    #spinner.show { display: block; }
    #bigplay {
      position: absolute; top: 50%; left: 50%; width: 72px; height: 72px;
      margin: -36px 0 0 -36px; border-radius: 50%;
      background: rgba(16, 11, 26, 0.65); border: 1px solid rgba(255,255,255,0.25);
      color: #fff; font-size: 32px; display: none; align-items: center; justify-content: center;
      z-index: 5;
    }
    #bigplay.show { display: flex; }
    #controls {
      position: absolute; left: 0; right: 0; bottom: 0; z-index: 6;
      padding: 26px 14px 12px; color: #fff; font-family: sans-serif;
      background: linear-gradient(transparent, rgba(10, 7, 16, 0.94));
    }
    #title { font-size: 13px; font-weight: 600; line-height: 1.35; margin-bottom: 8px; }
    #seek { width: 100%; height: 20px; accent-color: #8B5CF6; cursor: pointer; }
    #row { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
    #row button {
      background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.12);
      color: #fff; min-width: 34px; height: 34px; border-radius: 17px;
      font-size: 15px; font-weight: 700; cursor: pointer;
    }
    #playpause { min-width: 42px; height: 42px; border-radius: 21px; font-size: 19px; background: rgba(139,92,246,0.72); }
    #time { flex: 1; font-size: 11px; font-weight: 700; text-align: center; opacity: 0.92; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div id="stage"></div>
  <div id="tap"></div>
  <div id="spinner"></div>
  <div id="bigplay">▶</div>
  <div id="controls">
    <div id="title"></div>
    <input id="seek" type="range" min="0" max="1000" value="0" />
    <div id="row">
      <button id="back" aria-label="Back 10 seconds">↺</button>
      <button id="playpause" aria-label="Play or pause">▶</button>
      <button id="forward" aria-label="Forward 10 seconds">↻</button>
      <span id="time">0:00 / 0:00</span>
      <button id="mute" aria-label="Mute or unmute">🔊</button>
    </div>
  </div>
  <script>
    (function () {
      'use strict';
      var video = null, audio = null;
      var stopped = false;
      var wantedMuted = false;
      var syncTimer = null;
      var seeking = false;
      var titleEl = document.getElementById('title');
      var spinner = document.getElementById('spinner');
      var bigplay = document.getElementById('bigplay');
      var seek = document.getElementById('seek');
      var playpause = document.getElementById('playpause');
      var timeEl = document.getElementById('time');
      var muteBtn = document.getElementById('mute');

      function post(type, payload) {
        if (!window.ReactNativeWebView || !window.ReactNativeWebView.postMessage) return;
        var msg = { type: type };
        for (var k in (payload || {})) msg[k] = payload[k];
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
      function emit(event) { post('ytPlayerEvent', { event: event, videoId: location.hash.slice(1) || null }); }
      function fmt(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        var s = Math.floor(sec);
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var r = s % 60;
        return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
                 : m + ':' + String(r).padStart(2, '0');
      }
      function duration() { return video && isFinite(video.duration) ? video.duration : 0; }
      function isPlaying() { return !!video && !video.paused && !video.ended; }
      function syncControls() {
        playpause.textContent = isPlaying() ? '❚❚' : '▶';
        muteBtn.textContent = wantedMuted ? '🔇' : '🔊';
        var d = duration();
        var t = video && isFinite(video.currentTime) ? video.currentTime : 0;
        timeEl.textContent = fmt(t) + ' / ' + fmt(d);
        if (!seeking) seek.value = String(d > 0 ? Math.round((t / d) * 1000) : 0);
      }
      function applyVolume() {
        var v = wantedMuted ? 0 : 1;
        if (audio) { audio.volume = v; audio.muted = !!wantedMuted; }
        if (video && !audio) { video.volume = v; video.muted = !!wantedMuted; }
        syncControls();
      }
      function playPair() {
        if (stopped || !video) return;
        var vp = video.paused ? video.play() : Promise.resolve();
        var ap = audio && audio.paused ? audio.play() : Promise.resolve();
        Promise.all([vp, ap]).catch(function () {
          spinner.classList.remove('show');
          bigplay.classList.add('show');
        });
      }
      function pausePair() {
        if (video) video.pause();
        if (audio) audio.pause();
        syncControls();
      }
      function togglePlay() { if (isPlaying()) pausePair(); else playPair(); }
      function seekTo(sec) {
        if (!video) return;
        var d = duration();
        var t = Math.max(0, d ? Math.min(d, sec) : Math.max(0, sec));
        video.currentTime = t;
        if (audio) audio.currentTime = t;
        syncControls();
      }
      function onPlaying() {
        spinner.classList.remove('show');
        bigplay.classList.remove('show');
        syncControls();
        emit('playing');
      }
      function onWaiting() {
        spinner.classList.add('show');
        emit('buffering');
      }
      function onPause() { if (!stopped) { syncControls(); emit('paused'); } }
      function startSync() {
        stopSync();
        if (!video || !audio) return;
        syncTimer = setInterval(function () {
          if (!video || !audio || stopped || video.paused || audio.error) return;
          var vt = video.currentTime, at = audio.currentTime;
          if (isFinite(vt) && isFinite(at) && Math.abs(vt - at) > 0.45) audio.currentTime = vt;
        }, 3000);
      }
      function stopSync() { if (syncTimer) { clearInterval(syncTimer); syncTimer = null; } }

      seek.addEventListener('pointerdown', function () { seeking = true; });
      seek.addEventListener('pointerup', function () { seeking = false; });
      seek.addEventListener('input', function () {
        var d = duration();
        if (d > 0) seekTo((Number(seek.value) / 1000) * d);
      });
      playpause.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });
      document.getElementById('back').addEventListener('click', function (e) { e.stopPropagation(); seekTo((video ? video.currentTime : 0) - 10); });
      document.getElementById('forward').addEventListener('click', function (e) { e.stopPropagation(); seekTo((video ? video.currentTime : 0) + 10); });
      muteBtn.addEventListener('click', function (e) { e.stopPropagation(); wantedMuted = !wantedMuted; applyVolume(); });
      document.getElementById('tap').addEventListener('click', function () { if (!isPlaying()) playPair(); });
      document.getElementById('bigplay').addEventListener('click', function () { playPair(); });

      window.__load = function (videoUrl, audioUrl, label, muted) {
        var stage = document.getElementById('stage');
        stage.innerHTML = '';
        if (video) { try { video.pause(); } catch (e) {} }
        if (audio) { try { audio.pause(); } catch (e) {} }
        video = document.createElement('video');
        video.playsInline = true;
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
        titleEl.textContent = label || '';
        spinner.classList.add('show');
        bigplay.classList.remove('show');
        video.addEventListener('playing', onPlaying);
        video.addEventListener('waiting', onWaiting);
        video.addEventListener('pause', onPause);
        video.addEventListener('timeupdate', syncControls);
        video.addEventListener('loadedmetadata', syncControls);
        video.addEventListener('ended', function () { seekTo(0); playPair(); emit('ended'); });
        video.addEventListener('error', function () {
          if (!stopped) { spinner.classList.remove('show'); post('ytPlayerError', { errorCode: 'OFFLINE_ERROR' }); }
        });
        playPair();
        startSync();
        syncControls();
      };

      window.__play = playPair;
      window.__pause = pausePair;
      window.__seek = seekTo;
      window.__setMuted = function (m) { wantedMuted = !!m; applyVolume(); };
      window.__destroy = function () {
        stopped = true;
        stopSync();
        if (video) { video.removeAttribute('src'); video.pause(); }
        if (audio) { audio.removeAttribute('src'); audio.pause(); }
      };

      emit('ready');
    })();
  </script>
</body>
</html>
`;
