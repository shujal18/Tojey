// Piped API data service for the Reels/Shorts feed.
//
// The Android client never talks to Piped directly. It calls tojey's backend,
// and this module resolves metadata + stream URLs from a Piped API instance.
// Instance(s) are configurable via the PIPED_API_URL env var (comma separated);
// when one instance fails, the next healthy instance is tried.
//
// Nothing here touches Neon: responses are validated, cached briefly in
// process memory, and streamed straight from Piped/CDN to the device.

const REQUEST_TIMEOUT_MS = parseInt(process.env.PIPED_TIMEOUT_MS || '12000', 10);
const MAX_ATTEMPTS = 3;
const INSTANCE_COOLDOWN_MS = 45 * 1000;
const MAX_INSTANCE_FAILURES = 3;

const DEFAULT_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.darkness.services',
  'https://pipedapi.ducks.party',
];

function configuredInstances() {
  const raw = process.env.PIPED_API_URL || '';
  const fromEnv = String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.startsWith('http'));
  return (fromEnv.length ? fromEnv : DEFAULT_INSTANCES).slice(0, 8);
}

// Each category maps to several search seeds. Sessions rotate through them so
// re-opening Reels returns fresh content instead of the same 25 videos.
const CATEGORY_SEEDS = {
  trending: ['trending shorts', 'viral shorts', 'most viewed', 'shorts'],
  romantic: ['romantic love', 'romantic shorts', 'love story shorts', 'couple goals'],
  foreign: ['foreign comedy', 'international comedy', 'overseas funny'],
  comedy: ['comedy shorts', 'comedian', 'stand up comedy'],
  funny: ['funny videos', 'funny fails', 'funny moments', 'laugh out loud'],
  education: ['education facts', 'learn something new', 'did you know', 'science'],
  motivation: ['motivation', 'inspirational', 'success speech', 'never give up'],
  meme: ['memes', 'meme compilation', 'funny memes'],
  nepali: ['nepali comedy', 'nepali short films', 'nepali'],
};

const CATEGORIES = [
  { id: 'trending', label: 'For You' },
  { id: 'romantic', label: 'Romantic/Love' },
  { id: 'foreign', label: 'Foreign' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'funny', label: 'Funny' },
  { id: 'education', label: 'Education' },
  { id: 'motivation', label: 'Motivation' },
  { id: 'meme', label: 'Meme' },
  { id: 'nepali', label: 'Nepali' },
];

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// ---- instance health ---------------------------------------------------------

const health = new Map(); // instance -> { failures, lastFailure }
let rotationIdx = 0;

function instanceList() {
  return configuredInstances();
}

function markFailure(instance) {
  const h = health.get(instance) || { failures: 0, lastFailure: 0 };
  h.failures += 1;
  h.lastFailure = Date.now();
  health.set(instance, h);
}

function markSuccess(instance) {
  health.set(instance, { failures: 0, lastFailure: 0 });
}

function isHealthy(instance) {
  const h = health.get(instance);
  if (!h || h.failures === 0) return true;
  if (h.failures >= MAX_INSTANCE_FAILURES) {
    return Date.now() - h.lastFailure > INSTANCE_COOLDOWN_MS;
  }
  return true;
}

function orderedInstances() {
  const all = instanceList();
  if (!all.length) return [];
  rotationIdx = (rotationIdx + 1) % all.length;
  const rotated = [...all.slice(rotationIdx), ...all.slice(0, rotationIdx)];
  return rotated.filter(isHealthy);
}

// ---- low-level fetch with failover ------------------------------------------

function fetchJson(instance, pathname, params, timeoutMs) {
  const url = `${instance}${pathname}`;
  const qs = params
    ? Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(qs ? `${url}?${qs}` : url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Android 10; Mobile) Tojey/1.19.2',
    },
    signal: controller.signal,
  })
    .then(async (r) => {
      if (!r.ok) {
        const err = new Error(`piped ${r.status} ${pathname}`);
        err.code = `HTTP_${r.status}`;
        err.status = r.status;
        throw err;
      }
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        const err2 = new Error(`bad json from ${instance}`);
        err2.code = 'BAD_JSON';
        throw err2;
      }
    })
    .finally(() => clearTimeout(timer));
}

async function pipedGet(pathname, params, opts = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, attempts = MAX_ATTEMPTS, notFoundOn404 = false } = opts;
  const list = orderedInstances();
  if (!list.length) {
    const err = new Error('no piped instances available');
    err.code = 'INSTANCES_UNAVAILABLE';
    throw err;
  }
  let lastErr;
  const budget = Math.min(attempts, list.length);
  for (let i = 0; i < budget; i++) {
    const instance = list[i];
    try {
      const j = await fetchJson(instance, pathname, params, timeoutMs);
      markSuccess(instance);
      return j;
    } catch (e) {
      markFailure(instance);
      lastErr = e;
      if (notFoundOn404 && e && e.status === 404) break;
    }
  }
  if (!lastErr) {
    lastErr = new Error('piped request failed');
    lastErr.code = 'REQUEST_FAILED';
  }
  throw lastErr;
}

// ---- validators --------------------------------------------------------------

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/watch?v=') && VIDEO_ID_RE.test(url.slice(9))) return url.slice(9);
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  if (url.startsWith('/shorts/') && VIDEO_ID_RE.test(url.slice(8))) return url.slice(8);
  return null;
}

function extractChannelId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
  return m ? m[1] : null;
}

// Piped search item -> flat tojey video item
function mapSearchItem(it) {
  if (!isObject(it)) return null;
  const videoId = extractVideoId(it.url);
  if (!videoId) return null;
  const title = it.title || it.name;
  if (typeof title !== 'string' || !title.trim()) return null;
  const thumbnail = it.thumbnail;
  if (typeof thumbnail !== 'string' || !thumbnail.startsWith('http')) return null;
  const duration = Number(it.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > 60 * 60) return null;
  const uploaderName = it.uploaderName || it.uploader || '';
  const item = {
    videoId,
    title: title.slice(0, 200),
    thumbnailUrl: thumbnail,
    durationSeconds: Math.round(duration),
    channelTitle: typeof uploaderName === 'string' ? uploaderName.slice(0, 100) : '',
    views: it.views != null && Number.isFinite(Number(it.views)) ? Number(it.views) : 0,
    publishedAt: typeof it.uploadedDate === 'string' ? it.uploadedDate.slice(0, 10) : '',
    isShort: it.isShort === true,
  };
  const channelId = extractChannelId(it.uploaderUrl);
  if (channelId) item.channelId = channelId;
  return item;
}

// ---- seed sessions (fresh content rotation) ----------------------------------

const sessions = new Map(); // category -> { seed, pos }

function seedForCategory(category, refresh) {
  const seeds = CATEGORY_SEEDS[category] || CATEGORY_SEEDS.trending;
  let s = sessions.get(category);
  if (refresh || !s) {
    const pos = s ? s.pos + 1 : 0;
    s = { seed: seeds[pos % seeds.length], pos };
    sessions.set(category, s);
  }
  return s.seed;
}

// ---- public service API ------------------------------------------------------

function categories() {
  return CATEGORIES.map((c) => ({ ...c }));
}

async function feed(category, nextpage, refresh) {
  const cat = Object.prototype.hasOwnProperty.call(CATEGORY_SEEDS, category) ? category : 'trending';
  const seed = seedForCategory(cat, refresh === true || refresh === 'true' || refresh === '1');
  const params = { q: seed, filter: 'videos', videoDuration: 'short', nextpage: nextpage || undefined };
  const j = await pipedGet('/search', params, { notFoundOn404: true });
  if (!isObject(j)) {
    const err = new Error('bad feed response');
    err.code = 'BAD_JSON';
    throw err;
  }
  const raw = Array.isArray(j.items) ? j.items : [];
  const items = raw.map(mapSearchItem).filter(Boolean);
  const nextpageOut = typeof j.nextpage === 'string' && j.nextpage ? j.nextpage : '';
  const hasMore = !!nextpageOut;
  return {
    category: cat,
    seed,
    items,
    nextpage: hasMore ? nextpageOut : '',
    hasMore,
    instance: j.instanceId ? j.instanceId : '',
  };
}

async function streams(videoId) {
  if (!VIDEO_ID_RE.test(videoId)) {
    const err = new Error('Invalid video id');
    err.code = 'INVALID_ID';
    throw err;
  }
  let resolvedBy = 'piped';
  // Operators may prefer direct YouTube stream URLs (via yt-dlp) over Piped's
  // proxied/CDN sources, e.g. when a Piped instance serves 4xx/5xx stream URLs.
  // PIPED_PREFER_YTDLP=1 tries the direct path first and falls back to Piped.
  if (process.env.PIPED_PREFER_YTDLP === '1') {
    const preferred = await ytDlpFallback(videoId);
    if (preferred) {
      preferred.resolvedBy = 'ytdlp';
      return preferred;
    }
  }
  let j;
  try {
    j = await pipedGet(`/streams/${videoId}`, {}, { notFoundOn404: true });
  } catch (e) {
    // All Piped instances failed for this video. Last-resort fallback: resolve
    // a direct signed stream via yt-dlp (existing ytFormat service). Returns
    // CDN URLs that the device plays itself - Render neither downloads nor
    // proxies the video bytes, so bandwidth and Neon stay untouched.
    const fallback = await ytDlpFallback(videoId);
    if (fallback) {
      fallback.resolvedBy = 'ytdlp';
      return fallback;
    }
    throw e;
  }
  const hasVideo = Array.isArray(j && j.videoStreams) ? j.videoStreams.length : 0;
  if (!isObject(j) || (!j.title && !hasVideo && !(j && j.hls) && !(j && j.dash))) {
    const err = new Error('video unavailable');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const videoStreams = Array.isArray(j.videoStreams) ? j.videoStreams : [];
  const audioStreams = Array.isArray(j.audioStreams) ? j.audioStreams : [];
  const pickUrl = (s) => (isObject(s) && typeof s.url === 'string' ? s.url : '');

  // Prefer a muxed (progressive) stream so ExoPlayer gets one source. Piped
  // marks them with videoOnly=false; video-only/audio-only pairs are provided
  // as a fallback only if the instance also exposes an m3u8/mpd manifest.
  const muxed = videoStreams
    .filter((s) => isObject(s) && s.videoOnly === false && pickUrl(s))
    .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));

  const result = {
    resolvedBy,
    videoId,
    title: typeof j.title === 'string' ? j.title.slice(0, 200) : '',
    thumbnailUrl: typeof j.thumbnailUrl === 'string' && j.thumbnailUrl.startsWith('http') ? j.thumbnailUrl : '',
    duration: Number.isFinite(Number(j.duration)) ? Number(j.duration) : 0,
    uploader: typeof j.uploader === 'string' ? j.uploader.slice(0, 100) : '',
    uploaderAvatar: typeof j.uploaderAvatar === 'string' && j.uploaderAvatar.startsWith('http') ? j.uploaderAvatar : '',
    hls: typeof j.hls === 'string' && j.hls.startsWith('http') ? j.hls : '',
    dash: typeof j.dash === 'string' && j.dash.startsWith('http') ? j.dash : '',
    livestream: j.livestream === true,
    hlsStreams: (Array.isArray(j.hlsStreams) ? j.hlsStreams : []).filter((s) => isObject(s) && pickUrl(s)),
    videoStreams: videoStreams.filter((s) => isObject(s) && pickUrl(s)).map((s) => ({
      url: s.url,
      quality: typeof s.quality === 'string' ? s.quality.slice(0, 20) : '',
      mimeType: typeof s.mimeType === 'string' ? s.mimeType.slice(0, 60) : '',
      codec: typeof s.codec === 'string' ? s.codec.slice(0, 40) : '',
      width: Number(s.width) || 0,
      height: Number(s.height) || 0,
      bitrate: Number(s.bitrate) || 0,
      videoOnly: s.videoOnly === true,
    })),
    audioStreams: audioStreams.filter((s) => isObject(s) && pickUrl(s)).map((s) => ({
      url: s.url,
      quality: typeof s.quality === 'string' ? s.quality.slice(0, 20) : '',
      mimeType: typeof s.mimeType === 'string' ? s.mimeType.slice(0, 60) : '',
      codec: typeof s.codec === 'string' ? s.codec.slice(0, 40) : '',
      bitrate: Number(s.bitrate) || 0,
    })),
  };

  // Choose the single best playable source for Media3, in order:
  // 1. HLS manifest (Piped serves these through its own proxy -> works from
  //    any client IP, and adaptive streams start fastest),
  // 2. DASH manifest (same rationale),
  // 3. any muxed progressive mp4 (highest width wins),
  // 4. a video-only + audio-only pair.
  let chosen = null;
  let audioOnlySource = null;
  const proto = (u) => (u.startsWith('https') ? 'https' : u.startsWith('http') ? 'http' : '');

  if (result.hls && proto(result.hls)) {
    chosen = { url: result.hls, kind: 'hls' };
  } else if (result.dash && proto(result.dash)) {
    chosen = { url: result.dash, kind: 'dash' };
  } else if (muxed.length) {
    chosen = { url: pickUrl(muxed[0]), kind: 'progressive', height: Number(muxed[0].height) || 0 };
  } else if (videoStreams.length && audioStreams.length) {
    chosen = { url: pickUrl(videoStreams[0]), kind: 'progressive', height: Number(videoStreams[0].height) || 0, videoOnly: true };
    audioOnlySource = pickUrl(audioStreams[0]);
  }
  if (chosen && !proto(chosen.url)) chosen = null;

  result.source = chosen;
  result.audioSource = audioOnlySource;
  return result;
}

function ytDlpFallback(videoId) {
  try {
    const { getFormat } = require('./ytFormat');
    if (typeof getFormat !== 'function') return null;
    return getFormat(videoId).then((f) => {
      if (!f || !f.video || !f.video.url) return null;
      const result = {
        videoId,
        title: typeof f.title === 'string' ? f.title.slice(0, 200) : '',
        thumbnailUrl: '',
        duration: Number(f.duration) || 0,
        uploader: '',
        uploaderAvatar: '',
        hls: '',
        dash: '',
        livestream: false,
        hlsStreams: [],
        videoStreams: [],
        audioStreams: [],
        source: {
          url: f.video.url,
          kind: 'progressive',
          height: Number(f.video.height) || 0,
          videoOnly: false,
        },
        audioSource: f.audio && f.audio.url ? f.audio.url : null,
      };
      return result;
    }).catch(() => null);
  } catch (e) {
    return null;
  }
}

module.exports = { categories, feed, streams };