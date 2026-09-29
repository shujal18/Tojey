// Local YouTube library (LibreTube/NewPipe pattern): watch history, channel
// subscriptions, saved videos and custom playlists backed by AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEYS = {
  history: 'yt_history_v1',
  subs: 'yt_subs_v1',
  bookmarks: 'yt_bookmarks_v1',
  playlists: 'yt_playlists_v1',
};

const HISTORY_CAP = 150;

async function load(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function save(key, value) {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (e) {}
}

function emit() {
  for (const fn of listeners.slice()) fn(storeSnapshot());
}

// --- subscribed state (mirrors file structure) ------------------------------

export function normalizeItem(v) {
  if (!v) return null;
  return {
    videoId: v.videoId,
    title: v.title || '',
    thumbnailUrl: v.thumbnailUrl || v.thumb || '',
    durationSeconds: v.durationSeconds || 0,
    channelTitle: v.channelTitle || v.channel || '',
    channelId: v.channelId || '',
    playlistId: v.playlistId || '',
  };
}

async function writeHistory() {
  await save(KEYS.history, history);
  emit();
}
async function writeSubs() {
  await save(KEYS.subs, subs);
  emit();
}
async function writeBookmarks() {
  await save(KEYS.bookmarks, bookmarks);
  emit();
}
async function writePlaylists() {
  await save(KEYS.playlists, playlists);
  emit();
}

let history = [];
let subs = [];
let bookmarks = [];
let playlists = {}; // name -> [normalized item]
const listeners = [];

export async function initLibrary() {
  history = await load(KEYS.history, []);
  subs = await load(KEYS.subs, []);
  bookmarks = await load(KEYS.bookmarks, []);
  playlists = await load(KEYS.playlists, {});
  emit();
}

export function subscribeLibrary(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function storeSnapshot() {
  return { history, subs, bookmarks, playlists };
}

// --- watch history ----------------------------------------------------------

export async function addHistory(item) {
  const n = normalizeItem(item);
  if (!n || !n.videoId) return;
  history = [n, ...history.filter((h) => h.videoId !== n.videoId)].slice(0, HISTORY_CAP);
  await writeHistory();
}

export async function clearHistory() {
  history = [];
  await writeHistory();
}

// --- subscriptions ----------------------------------------------------------

export function isSubscribed(channelId) {
  return !!channelId && subs.some((s) => s.channelId === channelId);
}

export async function toggleSubscribe(channel) {
  if (!channel || !channel.channelId) return false;
  if (isSubscribed(channel.channelId)) {
    subs = subs.filter((s) => s.channelId !== channel.channelId);
  } else {
    subs = [
      {
        channelId: channel.channelId,
        channelTitle: channel.channelTitle || channel.title || '',
        avatar: channel.avatar || channel.thumbnailUrl || '',
      },
      ...subs,
    ];
  }
  await writeSubs();
  return isSubscribed(channel.channelId);
}

// --- saved / bookmarks ------------------------------------------------------

export function isBookmarked(videoId) {
  return !!videoId && bookmarks.some((b) => b.videoId === videoId);
}

export async function toggleBookmark(item) {
  const n = normalizeItem(item);
  if (!n || !n.videoId) return false;
  if (isBookmarked(n.videoId)) {
    bookmarks = bookmarks.filter((b) => b.videoId !== n.videoId);
  } else {
    bookmarks = [n, ...bookmarks];
  }
  await writeBookmarks();
  return isBookmarked(n.videoId);
}

// --- playlists --------------------------------------------------------------

export function playlistNames() {
  return Object.keys(playlists);
}

export function playlistItems(name) {
  return playlists[name] || [];
}

export function itemInPlaylist(name, videoId) {
  return !!(playlists[name] || []).some((p) => p.videoId === videoId);
}

export async function createPlaylist(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return false;
  if (playlists[clean]) return true;
  playlists[clean] = [];
  await writePlaylists();
  return true;
}

export async function togglePlaylistItem(name, item) {
  const n = normalizeItem(item);
  if (!n || !n.videoId || !playlists[name]) return false;
  const list = playlists[name];
  const idx = list.findIndex((p) => p.videoId === n.videoId);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift(n);
  await writePlaylists();
  return itemInPlaylist(name, n.videoId);
}

export async function addToPlaylist(name, item) {
  const n = normalizeItem(item);
  if (!n || !n.videoId || !playlists[name]) return false;
  if (playlists[name].some((p) => p.videoId === n.videoId)) return true;
  playlists[name].unshift(n);
  await writePlaylists();
  return true;
}

export async function removeFromPlaylist(name, videoId) {
  if (!playlists[name]) return;
  playlists[name] = playlists[name].filter((p) => p.videoId !== videoId);
  await writePlaylists();
}

export async function deletePlaylist(name) {
  delete playlists[name];
  await writePlaylists();
}