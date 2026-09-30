// Download manager for the Downloads tab.
//
// LibreTube-style: resolve the direct stream URLs on the device (innertube),
// then stream the video + audio bytes to app storage with rn-fetch-blob (native
// fetch, no CORS limits) while publishing progress. Metadata lives in a small
// AsyncStorage manifest so the list survives restarts; offline playback uses the
// saved file:// media pair.

import RNFetchBlob from 'rn-fetch-blob';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getStreams } from './innertube';

const MANIFEST_KEY = 'tojey_downloads_v1';
const DIR = `${RNFetchBlob.fs.dirs.DocumentDir}/tojey-downloads/`;

let manifest = [];
let listeners = new Set();
let loaded = false;

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
    if (d.status === 'done' && d.videoPath) {
      const ok = await RNFetchBlob.fs.stat(d.videoPath).then((s) => s.size > 0).catch(() => false);
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
  if (existing && existing.status === 'done' && existing.videoPath) {
    const ok = await RNFetchBlob.fs.stat(existing.videoPath).then((s) => s.size > 0).catch(() => false);
    if (ok && kind === 'audio') return { entry: existing, already: true };
    if (!ok) {
      manifest = manifest.filter((d) => d !== existing);
      existing = null;
    }
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
      const streams = await getStreams(video.videoId, { maxHeight: 480 });
      if (kind === 'audio' && !streams.audioUrl) throw new Error('no audio stream url');
      if (kind === 'video' && !streams.videoUrl) throw new Error('no stream url');
      console.log('[Download] resolved', video.videoId, kind, 'audio', !!streams.audioUrl);
      update(entry, { status: 'downloading', progress: 0, channel: streams.channel || entry.channel });

      const videoPath = kind === 'video' ? `${DIR}${video.videoId}_v.mp4` : null;
      const audioPath = kind === 'audio' ? `${DIR}${video.videoId}_a_audio.m4a` : (streams.audioUrl ? `${DIR}${video.videoId}_a.m4a` : null);

// googlevideo rejects open-ended Range (bytes=0-) with a 403, and each
      // signed ticket serves only a limited number of bytes (here ~3MiB) before
      // returning 403 on further requests. So: probe bytes=0-0 for the total,
      // fetch contiguous 1MiB ranges, and when a range 403s, re-resolve a fresh
      // ticket and resume from the same offset.
      const probeSize = async (url) => {
        const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        if (probe.status === 200) {
          const full = await probe.arrayBuffer();
          return full.byteLength;
        }
        if (probe.status !== 206) throw new Error(`probe http ${probe.status}`);
        const cr = probe.headers.get('Content-Range') || '';
        const total = parseInt(cr.replace(/.*\//, ''), 10);
        await probe.arrayBuffer().catch(() => {});
        return Number.isFinite(total) ? total : 0;
      };

      const downloadOne = async (baseUrl, path, label, onBytes, refresh) => {
        let url = baseUrl;
        let total = await probeSize(url).catch(() => 0);
        const CHUNK = 1024 * 1024;
        let start = 0;
        let first = true;
        let refreshes = 0;
        while (total > 0 && start < total) {
          const end = Math.min(start + CHUNK - 1, total - 1);
          const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const bytes = Array.from(new Uint8Array(buf));
            if (first) {
              await RNFetchBlob.fs.writeFile(path, bytes, 'ascii');
              first = false;
            } else {
              await RNFetchBlob.fs.appendFile(path, bytes, 'ascii');
            }
            start += bytes.length;
            refreshes = 0;
            if (onBytes) onBytes(start, total);
            continue;
          }
          if (res.status === 403 && refresh && refreshes < 4) {
            refreshes += 1;
            url = await refresh();
            const newTotal = await probeSize(url).catch(() => 0);
            if (newTotal > 0) total = newTotal;
            console.log(`[Download] ${label}: refresh ticket at ${start}`);
            continue;
          }
          const txt = await res.text().catch(() => '');
          console.log(`[Download] ${label} http ${res.status} range=${start}-${end} body=${txt.slice(0, 200)}`);
          throw new Error(`${label} http ${res.status}`);
        }
        if (total <= 0) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`${label} http ${res.status}`);
          const buf = await res.arrayBuffer();
          const bytes = Array.from(new Uint8Array(buf));
          await RNFetchBlob.fs.writeFile(path, bytes, 'ascii');
          start = bytes.length;
        }
        console.log(`[Download] ${label}: wrote ${start} bytes (total=${total})`);
        return start;
      };

      const bytesVel = { done: 0, total: 0 };
      const bytesAud = { done: 0, total: 0 };
      const vWeight = 0.85;
      const audioShare = audioPath ? 0.15 : 0;
      const pct = () => {
        let p = 0;
        if (kind === 'audio' && bytesAud.total > 0) p = (bytesAud.done / bytesAud.total) * 100;
        else if (!audioPath && bytesVel.total > 0) p = (bytesVel.done / bytesVel.total) * 100;
        else if (bytesVel.total > 0) p = (bytesVel.done / bytesVel.total) * vWeight;
        if (audioPath && bytesAud.total > 0) p += (bytesAud.done / bytesAud.total) * audioShare;
        return Math.min(100, Math.round(p * 10) / 10);
      };
      const report = () => {
        const done = bytesVel.done + bytesAud.done;
        const total = (bytesVel.total || bytesAud.total) + (audioPath ? bytesAud.total : 0);
        update(entry, { progress: pct(), bytesDone: done, bytesTotal: total });
      };

      if (kind === 'video') {
        console.log('[Download] video start ...');
        const refreshVideo = async () => {
          const s = await getStreams(video.videoId, { maxHeight: 480 });
          if (!s.videoUrl) throw new Error('no stream url');
          return s.videoUrl;
        };
        await downloadOne(streams.videoUrl, videoPath, 'video', (done, total) => {
          bytesVel.done = done; bytesVel.total = total;
          report();
        }, refreshVideo);
        console.log('[Download] video written');
      }

      if (audioPath) {
        console.log('[Download] audio start ...');
        const refreshAudio = async () => {
          const s = await getStreams(video.videoId, { maxHeight: 480 });
          if (!s.audioUrl) throw new Error('no audio url');
          return s.audioUrl;
        };
        await downloadOne(streams.audioUrl, audioPath, 'audio', (done, total) => {
          bytesAud.done = done; bytesAud.total = total;
          report();
        }, refreshAudio);
        console.log('[Download] audio written');
      }

      const statSize = async (p) => (p ? RNFetchBlob.fs.stat(p).then((s) => s.size).catch(() => 0) : 0);
      const size = (await statSize(videoPath)) + (await statSize(audioPath));
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