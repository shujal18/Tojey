// Server-side muxing: YouTube serves high-quality streams as separate
// video-only and audio-only "adaptive" files. Only the muxed progressive format
// (itag 18) tops out at 360p, so to let HD downloads carry audio the backend
// fetches both adaptive files and remuxes them with ffmpeg (`-c copy`, no
// re-encode). ffmpeg ships with the app via @ffmpeg-installer/ffmpeg, which
// bundles a prebuilt Linux binary in the npm tarball (no runtime download).
//
// Two YouTube behaviours shape this module:
//  * A plain GET of an adaptive URL returns 403; only bounded `Range` requests
//    are served, so files are pulled in chunks.
//  * For some videos YouTube serves only a prefix of each adaptive file without
//    a PO token (~50-70%), after which every range 403s. That is a hard wall we
//    cannot cross here, so callers fall back to the progressive stream. We
//    surface it as `GatedError` so the fallback only triggers on the real case.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable, pipeline } = require('stream');
const { promisify } = require('util');
const { spawn } = require('child_process');

const pipe = promisify(pipeline);

let FFMPEG = null;
try {
  FFMPEG = require('@ffmpeg-installer/ffmpeg').path;
} catch (e) {
  FFMPEG = null;
}
if (FFMPEG && !fs.existsSync(FFMPEG)) FFMPEG = null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CHUNK = 8 * 1024 * 1024;
const MAX_FILE = 900 * 1024 * 1024;

class GatedError extends Error {
  constructor(message) {
    super(message || 'stream is gate-limited (PO token required)');
    this.name = 'GatedError';
    this.gated = true;
  }
}

function available() {
  return !!FFMPEG;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `tojey-mux-${crypto.randomBytes(10).toString('hex')}${ext || ''}`);
}

async function cleanup(...files) {
  await Promise.all(files.map((f) => (f ? fs.promises.unlink(f).catch(() => {}) : null)));
}

// Pull a whole file via bounded range requests. Throws GatedError the moment
// YouTube stops serving a range, so callers can fall back quickly.
async function downloadToFile(url, total, dest, opts = {}) {
  const total0 = Number(total) || 0;
  if (total0 <= 0) throw new Error('unknown content length');
  if (total0 > MAX_FILE) throw new Error('file too large to download');
  const chunk = opts.chunkSize || CHUNK;
  const out = fs.createWriteStream(dest);
  try {
    let pos = 0;
    let guard = 0;
    while (pos < total0) {
      if (++guard > 4000) throw new Error('too many range requests');
      const end = Math.min(total0 - 1, pos + chunk - 1);
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', Range: `bytes=${pos}-${end}` },
      });
      if (r.status === 206 || r.status === 200) {
        await pipe(Readable.fromWeb(r.body), out, { end: false });
        const got = Number(r.headers.get('content-length')) || 0;
        pos += got > 0 ? got : (end - pos + 1);
      } else {
        try { await r.arrayBuffer(); } catch (e) { /* drain */ }
        if (r.status === 403 || r.status === 410) throw new GatedError();
        throw new Error(`upstream ${r.status}`);
      }
    }
  } catch (e) {
    try { out.destroy(); } catch (err) { /* ignore */ }
    await cleanup(dest);
    throw e;
  }
  await new Promise((resolve) => out.end(resolve));
  return dest;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-600)}`))));
  });
}

// Download a video-only and an audio-only file, remux into one progressive MP4.
// Returns the output path; intermediate files are always removed.
async function muxToFile(video, audio) {
  if (!available()) throw new Error('ffmpeg unavailable');
  const vSize = Number(video && video.contentLength) || 0;
  const aSize = Number(audio && audio.contentLength) || 0;
  if (vSize + aSize > MAX_FILE) throw new Error('file too large to mux');
  const vFile = tmpFile('.mp4');
  const aFile = tmpFile('.m4a');
  const outFile = tmpFile('.mp4');
  try {
    await downloadToFile(video.url, vSize, vFile);
    await downloadToFile(audio.url, aSize, aFile);
    await runFfmpeg([
      '-y',
      '-i', vFile,
      '-i', aFile,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outFile,
    ]);
    return outFile;
  } catch (e) {
    await cleanup(outFile);
    throw e;
  } finally {
    await cleanup(vFile, aFile);
  }
}

// Extract the audio track of an already-downloaded progressive file (used when
// an audio-only adaptive download is gated but the muxed stream is readable).
async function extractAudioFile(input, outFile) {
  if (!available()) throw new Error('ffmpeg unavailable');
  await runFfmpeg(['-y', '-i', input, '-vn', '-c:a', 'copy', '-f', 'mp4', outFile]);
  return outFile;
}

module.exports = {
  available,
  GatedError,
  tmpFile,
  cleanup,
  downloadToFile,
  muxToFile,
  extractAudioFile,
};
