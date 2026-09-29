/**
 * yt-dlp-backed direct stream resolver for Reels.
 *
 * React Native plays each reel from DIRECT signed stream URLs (video-only mp4 +
 * m4a audio) instead of an anonymous YouTube <embed> session. Embeds get gated
 * when several devices behind one IP open Reels at the same time ("second device
 * just loads"); signed googlevideo URLs stream from any device/network, so
 * MULTIPLE devices can watch at once — like the YouTube app.
 *
 * The latest standalone yt-dlp binary is downloaded once into the OS tmp dir on
 * first use (Render has no system yt-dlp). Results are cached per videoId for a
 * few hours and extractions are single-flight and concurrency-capped, so a cold
 * feed only pays the extraction cost once per video.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, exec } = require('child_process');

const YTDLP_BIN = process.env.YT_DLP_BIN || path.join(os.tmpdir(), 'yt-dlp-tojey');
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;   // signed URLs live ~6h
const EXTRACT_TIMEOUT_MS = 25000;
const MAX_CONCURRENT = 2;

// Render's datacenter IP is flagged by YouTube, so the default (web-embedded)
// client answers "Sign in to confirm you're not a bot". Try progressively less
// bot-gated clients; each is a fresh yt-dlp process. JS runtime (node) lets
// yt-dlp solve YouTube's proof-of-origin token when the client needs it.
const CLIENT_LADDER = [
  'youtube:player_client=android_vr,ios,web_safari',
  'youtube:player_client=tv,web_safari',
  'youtube:player_client=default',
];

const formatCache = new Map();   // videoId -> { title, video, audio, fetchedAt }
const inflight = new Map();      // videoId -> Promise
let activeExtra = 0;
const waiters = [];

function onceAvailable(cb) {
  if (activeExtra < MAX_CONCURRENT) { cb(); return; }
  waiters.push(cb);
}

function release() {
  activeExtra -= 1;
  const next = waiters.shift();
  if (next) { activeExtra += 1; next(); }
}

async function ensureBinary() {
  if (fs.existsSync(YTDLP_BIN)) {
    const st = fs.statSync(YTDLP_BIN);
    if (Date.now() - st.mtimeMs < 30 * 24 * 60 * 60 * 1000) return YTDLP_BIN;
  }
  const tmp = `${YTDLP_BIN}.part`;
  await new Promise((resolve, reject) => {
    exec(
      `mkdir -p "$(dirname '${YTDLP_BIN}')" && curl -fsSL -o '${tmp}' https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && chmod +x '${tmp}' && mv -f '${tmp}' '${YTDLP_BIN}'`,
      { timeout: 60000 },
      (err) => (err ? reject(err) : resolve())
    );
  });
  return YTDLP_BIN;
}

function runExtract(videoId, bin, clientArgs) {
  return new Promise((resolve, reject) => {
    const args = ['-J', '--no-playlist', '--skip-download', '--no-warnings'];
    if (clientArgs) args.push('--extractor-args', clientArgs);
    args.push('--js-runtimes', 'node');
    args.push(`https://www.youtube.com/shorts/${videoId}`);
    execFile(
      bin,
      args,
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const e = new Error(String((err.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | ') || err.message).slice(0, 300));
          e.code = 'EXTRACT_FAIL';
          return reject(e);
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          const er = new Error('bad extract json');
          er.code = 'BAD_JSON';
          reject(er);
        }
      }
    );
  });
}

async function extractWithLadder(videoId, bin) {
  let lastErr = null;
  for (const clientArgs of CLIENT_LADDER) {
    try {
      return await runExtract(videoId, bin, clientArgs);
    } catch (e) {
      lastErr = e;
      if (String(e.message).toLowerCase().includes('not a bot') && clientArgs.includes('default')) {
        // default never recovers once flagged; ladder already covered better clients
      }
    }
  }
  lastErr.code = lastErr.code || 'EXTRACT_FAIL';
  throw lastErr;
}

const VIDEO_PREFERRED_IDS = ['298', '135', '134', '299', '302', '303', '243', '242'];
const AUDIO_PREFERRED_IDS = ['140', '139', '251', '250'];

function pickVideo(formats) {
  const vids = (formats || []).filter(
    (f) => f && f.url && f.protocol === 'https' && f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')
  );
  for (const id of VIDEO_PREFERRED_IDS) {
    const hit = vids.find((f) => String(f.format_id) === id && f.height && f.height >= 360);
    if (hit) return hit;
  }
  const portrait = vids.filter((f) => f.width && f.height && f.width < f.height && f.height >= 360);
  const h264 = portrait.filter((f) => String(f.vcodec).startsWith('avc1')).sort((a, b) => b.height - a.height);
  if (h264.length) return h264.find((f) => f.height <= 720) || h264[0];
  const vp9 = portrait.sort((a, b) => b.height - a.height);
  return vp9.find((f) => f.height <= 1080) || vp9[0];
}

function pickAudio(formats) {
  const aud = (formats || []).filter(
    (f) => f && f.url && f.protocol === 'https' && (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none'
  );
  for (const id of AUDIO_PREFERRED_IDS) {
    const hit = aud.find((f) => String(f.format_id) === id);
    if (hit) return hit;
  }
  const m4a = aud.filter((f) => f.ext === 'm4a').sort((a, b) => (b.abr || 0) - (a.abr || 0));
  if (m4a.length) return m4a[0];
  return aud.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;
}

async function resolveOnce(videoId) {
  const bin = await ensureBinary();
  const json = await extractWithLadder(videoId, bin);
  const video = pickVideo(json.formats);
  const audio = pickAudio(json.formats);
  if (!video || !video.url) {
    const e = new Error(
      `no playable video format (formats=${(json.formats || []).length}, ids=${(json.formats || []).slice(0, 12).map((f) => f.format_id).join(',')})`
    );
    e.code = 'NO_VIDEO_FORMAT';
    throw e;
  }
  return {
    title: json.title || '',
    duration: json.duration || 0,
    video: {
      url: video.url,
      ext: video.ext || 'mp4',
      width: video.width || 0,
      height: video.height || 0,
      fps: video.fps || 0,
    },
    audio: audio ? { url: audio.url, ext: audio.ext || '' } : { url: '' },
  };
}

async function getFormat(videoId) {
  const hit = formatCache.get(videoId);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return { cached: true, ...hit };
  }
  if (inflight.has(videoId)) return inflight.get(videoId);

  const p = new Promise((resolve, reject) => {
    onceAvailable(async () => {
      try {
        const data = await resolveOnce(videoId);
        const entry = { ...data, fetchedAt: Date.now() };
        formatCache.set(videoId, entry);
        resolve({ cached: false, ...data });
      } catch (err) {
        reject(err);
      } finally {
        release();
      }
    });
  });
  inflight.set(videoId, p);
  p.finally(() => inflight.delete(videoId)).catch(() => {});
  return p;
}

module.exports = { getFormat, YTDLP_BIN };