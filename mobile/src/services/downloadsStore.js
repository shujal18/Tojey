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

export async function enqueue(video) {
  await ensureLoaded();
  const existing = manifest.find((d) => d.videoId === video.videoId);
  if (existing && existing.status !== 'error' && existing.status !== 'removed') {
    return { entry: existing, already: true };
  }

  const entry = {
    id: `${Date.now()}-${video.videoId}`,
    videoId: video.videoId,
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
      await RNFetchBlob.fs.mkdir(DIR);
      update(entry, { status: 'resolving' });
      const streams = await getStreams(video.videoId, { maxHeight: 480 });
      if (!streams.videoUrl) throw new Error('no stream url');
      update(entry, { status: 'downloading', progress: 0, channel: streams.channel || entry.channel });

      const videoPath = `${DIR}${video.videoId}_v.mp4`;
      const audioPath = streams.audioUrl ? `${DIR}${video.videoId}_a.m4a` : null;

      const downloadOne = (url, path, weight) =>
        new Promise((resolve, reject) => {
          RNFetchBlob.config({ path, timeout: 0 })
            .fetch('GET', url)
            .progress((received, total) => {
              const p = total > 0 ? received / total : 0;
              update(entry, { progress: Math.round((p * 100 * weight + entry.progress0 || 0) * 10) / 10 });
            })
            .then((info) => resolve(info))
            .catch((e) => reject(e));
        });

      await downloadOne(streams.videoUrl, videoPath, 0.85);
      entry.progress0 = 85;
      if (audioPath) await downloadOne(streams.audioUrl, audioPath, 0.15);
      delete entry.progress0;

      const size = await RNFetchBlob.fs.stat(videoPath).then((s) => s.size).catch(() => 0);
      update(entry, {
        status: 'done',
        progress: 100,
        size,
        videoPath,
        audioPath,
        endTime: Date.now(),
      });
    } catch (e) {
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