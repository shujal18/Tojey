// Download manager for the Downloads tab.
//
// LibreTube-style: resolve the direct stream URLs on the device (innertube),
// then stream the video + audio bytes to app storage with rn-fetch-blob (native
// fetch, no CORS limits) while publishing progress. Metadata lives in a small
// AsyncStorage manifest so the list survives restarts; offline playback uses the
// saved file:// media pair.

import RNFetchBlob from 'rn-fetch-blob';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getProxyPlayback } from './ytPlayback';

// The downloader streams through the same backend byte proxy as playback, so it
// needs the signed auth token. App.jsx calls setAuthToken on login/boot.
let authToken = '';
export function setAuthToken(t) { authToken = t || ''; }

const MANIFEST_KEY = 'tojey_downloads_v1';
const DIR = `${RNFetchBlob.fs.dirs.DocumentDir}/tojey-downloads/`;
const CHUNK = 1024 * 1024;

let manifest = [];
let listeners = new Set();
let loaded = false;

async function fileSize(path) {
  if (!path) return 0;
  return RNFetchBlob.fs.stat(path).then((s) => s.size || 0).catch(() => 0);
}

async function validFile(path) {
  return (await fileSize(path)) > 0;
}

function header(headers, name) {
  if (!headers) return '';
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return '';
}

function extFromMime(url, mime, fallback) {
  let m = String(mime || '');
  if (!m) {
    const q = /[?&]mime=([^&]+)/i.exec(String(url || ''));
    if (q) {
      try {
        m = decodeURIComponent(q[1].replace(/\+/g, ' '));
      } catch (e) {
        m = '';
      }
    }
  }
  m = m.toLowerCase();
  if (/audio\/(mp4|m4a|aac|x-m4a)/.test(m)) return 'm4a';
  if (/audio\/(webm|ogg)/.test(m) || /opus/.test(m)) return 'webm';
  if (/video\/webm/.test(m)) return 'webm';
  if (/video\/(mp4|m4v|quicktime)/.test(m)) return 'mp4';
  return fallback;
}

async function streamToFile(url, path, headers, onProgress) {
  const task = RNFetchBlob.config({ path, timeout: 120000 }).fetch('GET', url, headers || {});
  if (onProgress) task.progress({ interval: 250 }, onProgress);
  const res = await task;
  const info = res.info();
  return { status: info.status, headers: info.headers || {}, path: res.path() };
}

async function downloadStream(baseUrl, path, label, onBytes, refresh) {
  await RNFetchBlob.fs.unlink(path).catch(() => {});
  let url = baseUrl;
  let start = 0;
  let total = 0;
  let refreshes = 0;

  try {
    const first = await streamToFile(url, path, {}, (received, len) => {
      if (onBytes) onBytes(received, len > 0 ? len : 0);
    });
    if (first.status === 200 || first.status === 206) {
      start = await fileSize(path);
      const cr = header(first.headers, 'content-range');
      const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
      total = m ? (Number(m[1]) || 0) : (Number(header(first.headers, 'content-length')) || 0);
      if (onBytes) onBytes(start, total || start);
      if (!total || start >= total) return start;
    } else {
      await RNFetchBlob.fs.unlink(path).catch(() => {});
    }
  } catch (e) {
    start = await fileSize(path);
    if (!start) await RNFetchBlob.fs.unlink(path).catch(() => {});
  }

  while (true) {
    if (total > 0 && start >= total) break;
    const end = start + CHUNK - 1;
    const want = end - start + 1;
    const chunkPath = `${path}.part`;
    await RNFetchBlob.fs.unlink(chunkPath).catch(() => {});
    let res = null;
    try {
      res = await streamToFile(url, chunkPath, { Range: `bytes=${start}-${end}` }, (received, len) => {
        if (onBytes) onBytes(start + received, total || start + len);
      });
    } catch (e) {
      await RNFetchBlob.fs.unlink(chunkPath).catch(() => {});
      if (refresh && refreshes < 4) {
        refreshes += 1;
        url = await refresh();
        continue;
      }
      throw e;
    }
    if (res.status === 200 || res.status === 206) {
      const size = await fileSize(chunkPath);
      const cr = header(res.headers, 'content-range');
      const m = cr ? /\/(\d+)\s*$/.exec(cr) : null;
      if (m) total = Number(m[1]) || total;
      if (res.status === 200 && start > 0) {
        await RNFetchBlob.fs.unlink(path).catch(() => {});
        start = 0;
      }
      if (size > 0) await RNFetchBlob.fs.appendFile(path, chunkPath, 'uri');
      await RNFetchBlob.fs.unlink(chunkPath).catch(() => {});
      start += size;
      refreshes = 0;
      if (onBytes) onBytes(start, total || start);
      if (size <= 0) break;
      if (total > 0 && start >= total) break;
      if (res.status === 200) break;
      if (!total && size < want) break;
      continue;
    }
    await RNFetchBlob.fs.unlink(chunkPath).catch(() => {});
    if (refresh && refreshes < 4) {
      refreshes += 1;
      url = await refresh();
      continue;
    }
    throw new Error(`${label} http ${res.status}`);
  }
  console.log(`[Download] ${label}: wrote ${start} bytes (total=${total})`);
  return start;
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(MANIFEST_KEY);
    manifest = raw ? JSON.parse(raw) : [];
  } catch (e) {
    manifest = [];
  }
  let healed = false;
  for (const d of manifest) {
    if (d.status === 'downloading' || d.status === 'resolving' || d.status === 'starting') {
      d.status = 'error';
      d.error = 'Interrupted';
      healed = true;
      continue;
    }
    if (d.status === 'done') {
      let ok;
      if (d.kind === 'audio') {
        ok = await validFile(d.audioPath);
      } else {
        ok = await validFile(d.videoPath);
        if (ok && d.audioPath) ok = await validFile(d.audioPath);
      }
      if (!ok) {
        d.status = 'error';
        d.error = 'Interrupted';
        healed = true;
      }
    }
  }
  if (healed) persist();
  loaded = true;
}

function persist() {
  AsyncStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest)).catch(() => {});
}

function emit() {
  listeners.forEach((l) => {
    try {
      l(manifest);
    } catch (e) {}
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  ensureLoaded().then(() => fn(manifest));
  return () => listeners.delete(fn);
}

export async function getDownloads() {
  await ensureLoaded();
  return manifest;
}

export function thumbUrl(video) {
  return (
    video.thumbnailUrl ||
    video.thumb ||
    `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`
  );
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function update(entry, patch) {
  Object.assign(entry, patch);
  persist();
  emit();
}

export async function enqueue(video, opts = {}) {
  await ensureLoaded();
  const kind = opts.mode === 'audio' ? 'audio' : 'video';
  let existing = manifest.find((d) => d.videoId === video.videoId && d.kind === kind);
  if (existing && existing.status === 'done') {
    let ok;
    if (kind === 'audio') {
      ok = await validFile(existing.audioPath);
    } else {
      ok = await validFile(existing.videoPath);
      if (ok && existing.audioPath) ok = await validFile(existing.audioPath);
    }
    if (ok) return { entry: existing, already: true };
    manifest = manifest.filter((d) => d !== existing);
    existing = null;
  }
  if (existing && existing.status !== 'error' && existing.status !== 'removed') {
    return { entry: existing, already: true };
  }

  const entry = {
    id: `${Date.now()}-${video.videoId}-${kind}`,
    videoId: video.videoId,
    kind,
    title: video.title || video.videoId,
    channel: video.channelTitle || '',
    thumb: thumbUrl(video),
    videoPath: null,
    audioPath: null,
    size: 0,
    status: 'starting',
    progress: 0,
    error: '',
    addedAt: Date.now(),
  };
  if (existing) {
    const i = manifest.indexOf(existing);
    manifest[i] = entry;
  } else {
    manifest.push(entry);
  }
  persist();
  emit();

  (async () => {
    try {
      await RNFetchBlob.fs.mkdir(DIR).catch(() => {});
      update(entry, { status: 'resolving' });
      const streams = await getProxyPlayback(video.videoId, authToken, { maxHeight: 480 });
      const audioSource = streams.audioUrl || (kind === 'audio' ? streams.videoUrl : null);
      if (kind === 'audio' && !audioSource) throw new Error('no audio stream url');
      if (kind === 'video' && !streams.videoUrl) throw new Error('no stream url');
      console.log('[Download] resolved', video.videoId, kind, 'audio', !!streams.audioUrl);
      update(entry, { status: 'downloading', progress: 0, channel: streams.channel || entry.channel });

      const videoExt = extFromMime(streams.videoUrl, streams.videoMime, 'mp4');
      const audioExt = extFromMime(audioSource, streams.audioUrl ? streams.audioMime : streams.videoMime, streams.audioUrl ? 'm4a' : videoExt);
      const videoPath = kind === 'video' ? `${DIR}${video.videoId}_v.${videoExt}` : null;
      const companion = kind === 'video' && !!streams.audioUrl && streams.videoHasAudio === false;
      const audioPath = kind === 'audio'
        ? `${DIR}${video.videoId}_a_audio.${audioExt}`
        : (companion ? `${DIR}${video.videoId}_a_audio.${audioExt}` : null);

      const bytesVel = { done: 0, total: 0 };
      const bytesAud = { done: 0, total: 0 };
      const vWeight = 0.85;
      const audioShare = audioPath ? 0.15 : 0;
      const pct = () => {
        let p = 0;
        if (kind === 'audio') {
          if (bytesAud.total > 0) p = (bytesAud.done / bytesAud.total) * 100;
        } else if (!audioPath) {
          if (bytesVel.total > 0) p = (bytesVel.done / bytesVel.total) * 100;
        } else {
          if (bytesVel.total > 0) p = (bytesVel.done / bytesVel.total) * vWeight;
          if (bytesAud.total > 0) p += (bytesAud.done / bytesAud.total) * audioShare;
        }
        return Math.min(100, Math.round(p * 10) / 10);
      };
      const report = () => {
        const done = bytesVel.done + bytesAud.done;
        const total = bytesVel.total + (audioPath ? bytesAud.total : 0);
        update(entry, { progress: pct(), bytesDone: done, bytesTotal: total });
      };

      if (kind === 'video') {
        console.log('[Download] video start ...');
        const refreshVideo = async () => {
          const s = await getProxyPlayback(video.videoId, authToken, { maxHeight: 480 });
          if (!s.videoUrl) throw new Error('no stream url');
          return s.videoUrl;
        };
        await downloadStream(streams.videoUrl, videoPath, 'video', (done, total) => {
          bytesVel.done = done; bytesVel.total = total || bytesVel.total;
          report();
        }, refreshVideo);
        console.log('[Download] video written');
      }

      if (audioPath) {
        console.log('[Download] audio start ...');
        const refreshAudio = async () => {
          const s = await getProxyPlayback(video.videoId, authToken, { maxHeight: 480 });
          const next = kind === 'audio' ? (s.audioUrl || s.videoUrl) : s.audioUrl;
          if (!next) throw new Error('no audio url');
          return next;
        };
        await downloadStream(audioSource, audioPath, 'audio', (done, total) => {
          bytesAud.done = done; bytesAud.total = total || bytesAud.total;
          report();
        }, refreshAudio);
        console.log('[Download] audio written');
      }

      const size = (await fileSize(videoPath)) + (await fileSize(audioPath));
      console.log('[Download] stat size', size);
      update(entry, {
        status: 'done',
        progress: 100,
        size,
        bytesDone: size,
        bytesTotal: bytesVel.total + bytesAud.total || size,
        videoPath,
        audioPath,
        endTime: Date.now(),
      });
      console.log('[Download] complete', video.videoId, kind, size);
    } catch (e) {
      console.log('[Download] FAILED', video.videoId, String((e && e.message) || e));
      update(entry, { status: 'error', error: String((e && e.message) || e).slice(0, 120) });
    }
  })();

  return { entry, already: false };
}

export async function removeDownload(id) {
  await ensureLoaded();
  const idx = manifest.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const [entry] = manifest.splice(idx, 1);
  persist();
  emit();
  if (entry.videoPath) RNFetchBlob.fs.unlink(entry.videoPath).catch(() => {});
  if (entry.audioPath) RNFetchBlob.fs.unlink(entry.audioPath).catch(() => {});
}

export async function clearAllDownloads() {
  await ensureLoaded();
  manifest = [];
  persist();
  emit();
  try {
    await RNFetchBlob.fs.unlink(DIR);
  } catch (e) {}
}