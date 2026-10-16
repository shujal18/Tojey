// Device-side YouTube stream resolution (NewPipe/LibreTube pattern).
//
// Render's datacenter IP is bot-flagged by YouTube, so server-side extraction is
// unreliable. Instead we ask YouTube's own innertube API from the DEVICE using the
// ANDROID player client: residential IPs pass the gate and the response carries
// DIRECT signed stream URLs (no cipher/nsig). RN's native fetch has no browser CORS
// and sends no Origin header, which is exactly what innertube accepts.

const INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.12.37',
  clientScreen: 'WATCH',
  androidSdkVersion: 30,
  osName: 'Android',
  osVersion: '11',
  hl: 'en',
  gl: 'US',
  androidId: '2e544bd5a4c9a316',
};
const UA =
  'com.google.android.youtube/20.12.37 (Linux; U; Android 11; US)';

// Higher itags first, prefer portrait-capable h264 mp4 video-only.
const VIDEO_ITAG_ORDER = [298, 135, 134, 299, 302, 303, 396, 243, 242, 133];
// Prefer m4a, then webm; allow lower bitrate when the instance hides 140.
const AUDIO_ITAG_ORDER = [140, 139, 251, 250, 249];

function bestAudio(formats) {
  for (const itag of AUDIO_ITAG_ORDER) {
    const f = formats.find((x) => x.itag === itag && !!x.url);
    if (f) return f;
  }
  return formats.find((x) => x.mimeType && x.mimeType.includes('audio') && !!x.url) || null;
}

function bestVideo(formats, maxHeight) {
  const cands = formats.filter(
    (f) => f.url && (!f.height || f.height <= maxHeight) && f.mimeType && f.mimeType.includes('video/mp4')
  );
  for (const itag of VIDEO_ITAG_ORDER) {
    const f = cands.find((x) => x.itag === itag);
    if (f) return f;
  }
  return cands[0] || null;
}

export async function getStreams(videoId, opts = {}) {
  const maxHeight = opts.maxHeight || 720;
  const body = {
    context: { client: ANDROID_CLIENT },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`youtube player status ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'youtube player error');
    if (!j.streamingData) throw new Error('no streaming data for video');
    const af = j.streamingData.adaptiveFormats || [];
    const video = bestVideo(af, maxHeight);
    const audio = bestAudio(af);
    if (!video || !video.url) throw new Error('no playable video stream');
    const details = j.videoDetails || {};
    return {
      videoId,
      title: String(details.title || ''),
      channel: String(details.author || ''),
      videoUrl: video.url,
      audioUrl: audio ? audio.url : null,
      height: video.height || 0,
      fps: video.fps || 0,
      itag: video.itag || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Shorts/Reels source resolution.
//
// The Reels player takes ONE source URL per clip, so unlike the long-form
// player (which can pair a video-only and an audio-only track) this prefers a
// progressive muxed mp4 - itag 18, 360p - and returns a single playable URL with
// audio already muxed in. That keeps Media3 on a plain progressive source, which
// starts fastest and needs no audio-track stitching.
//
// Falls back to the adaptive video-only + audio-only pair when an instance hides
// itag 18, so a clip still plays (video first, then audio attached).
export async function getShortStream(videoId, opts = {}) {
  const maxHeight = opts.maxHeight || 720;
  // YouTube hands back a signed googlevideo URL that occasionally 403s or resets
  // the connection on first use even though the clip is perfectly playable, so a
  // second, freshly-signed URL is usually enough. Do not re-mux: a retry is just
  // another player call, which is the same request that produced the bad URL.
  const attempts = opts.attempts || 3;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 400 * (attempt - 1)));
    try {
      return await resolveShortStreamOnce(videoId, maxHeight);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('stream resolution failed');
}

async function resolveShortStreamOnce(videoId, maxHeight) {
  const body = {
    context: { client: ANDROID_CLIENT },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`youtube player status ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || 'youtube player error');
    if (!j.streamingData) throw new Error('no streaming data for clip');
    const sd = j.streamingData;

    // Preferred: a single muxed progressive mp4 (audio included).
    const progressive = (sd.formats || []).find(
      (f) => f && f.url && f.itag === 18 && /video\/mp4/.test(f.mimeType || '')
    ) || (sd.formats || []).find((f) => f && f.url && /video\/mp4/.test(f.mimeType || ''));
    if (progressive) {
      return {
        videoId,
        url: progressive.url,
        kind: 'progressive',
        height: progressive.height || 0,
        audioUrl: null,
      };
    }

    // Fallback: video-only + audio-only. The clip still plays.
    const af = sd.adaptiveFormats || [];
    const video = bestVideo(af, maxHeight);
    const audio = bestAudio(af);
    if (!video || !video.url) throw new Error('no playable clip source');
    return {
      videoId,
      url: video.url,
      kind: 'progressive',
      height: video.height || 0,
      audioUrl: audio ? audio.url : null,
    };
  } finally {
    clearTimeout(timer);
  }
}