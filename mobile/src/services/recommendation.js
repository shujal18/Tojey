import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DeviceEventEmitter } from 'react-native';

export const SEARCH_HISTORY_KEY = 'tojey_search_history_v1';
export const WATCH_HISTORY_KEY = 'tojey_watch_history_v1';
export const RECOMMENDATION_CHANGED_EVENT = 'tojey_recommendation_changed';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const SEARCH_HISTORY_MAX = 12;
const READ_CACHE_TTL = 3 * 1000;
const WATCH_WRITE_DEBOUNCE = 1000;
const WATCH_HISTORY_MAX = 250;

const readCache = new Map(); // key -> { at, value }
let watchWriteTimer = null;
let pendingWatch = null;

function invalidateReadCache(key) {
  readCache.delete(key);
  readCache.delete(`@${key}`);
}

async function readJSON(key) {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < READ_CACHE_TTL) return hit.value;
  const values = [];
  for (const k of [key, `@${key}`]) {
    try {
      const raw = await AsyncStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) values.push(...parsed);
    } catch (e) {}
  }
  readCache.set(key, { at: Date.now(), value: values });
  return values;
}

function emitChanged() {
  DeviceEventEmitter.emit(RECOMMENDATION_CHANGED_EVENT);
}

export function subscribeRecommendationChanged(handler) {
  if (typeof handler !== 'function') return () => {};
  const subscription = DeviceEventEmitter.addListener(RECOMMENDATION_CHANGED_EVENT, handler);
  return () => subscription.remove();
}

// Watch-history writes are batched so scrolling through a feed does not hammer
// AsyncStorage. Pending entries are visible to reads immediately via the cache,
// and are flushed on background or when the feed unmounts.
export function flushWatchWrites() {
  if (watchWriteTimer) {
    clearTimeout(watchWriteTimer);
    watchWriteTimer = null;
  }
  if (!pendingWatch) return;
  const value = pendingWatch;
  pendingWatch = null;
  AsyncStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(value)).catch(() => {});
  readCache.set(WATCH_HISTORY_KEY, { at: Date.now(), value });
  emitChanged();
}

AppState.addEventListener('change', (state) => {
  if (state === 'background' || state === 'inactive') flushWatchWrites();
});

export async function getRecentSearches(limit = SEARCH_HISTORY_MAX) {
  const searches = (await readJSON(SEARCH_HISTORY_KEY)).filter((s) => typeof s === 'string');
  const seen = new Set();
  const out = [];
  for (const raw of searches) {
    const s = String(raw || '').trim();
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

export async function addRecentSearch(query) {
  const value = String(query || '').trim();
  if (!value) return getRecentSearches();
  const existing = await getRecentSearches(SEARCH_HISTORY_MAX);
  const next = [value, ...existing.filter((s) => s.toLowerCase() !== value.toLowerCase())].slice(0, SEARCH_HISTORY_MAX);
  try {
    await AsyncStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  } catch (e) {}
  invalidateReadCache(SEARCH_HISTORY_KEY);
  readCache.set(SEARCH_HISTORY_KEY, { at: Date.now(), value: next });
  emitChanged();
  return next;
}

export async function clearRecentSearches() {
  try {
    await AsyncStorage.removeItem(SEARCH_HISTORY_KEY);
    await AsyncStorage.removeItem(`@${SEARCH_HISTORY_KEY}`);
  } catch (e) {}
  invalidateReadCache(SEARCH_HISTORY_KEY);
  emitChanged();
}

export async function getRecommendationSeeds(limit = 8) {
  const searches = await getRecentSearches(6);
  const watched = (await readJSON(WATCH_HISTORY_KEY)).filter((w) => w && typeof w === 'object');
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const s = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  searches.forEach(push);
  for (const w of watched.slice(0, 8)) if (w.channelTitle) push(w.channelTitle);
  for (const w of watched.slice(0, 6)) {
    if (w.title) push(String(w.title).split(/\s+/).slice(0, 5).join(' '));
  }
  return out.slice(0, Math.max(1, limit));
}

export async function getWatchedVideoIds(limit = 250) {
  const watched = await readJSON(WATCH_HISTORY_KEY);
  const ids = watched
    .map((w) => w && w.videoId)
    .filter((v) => typeof v === 'string' && VIDEO_ID_RE.test(v));
  return [...new Set(ids)].slice(0, limit);
}

export async function recordWatched(entry) {
  if (!entry || !VIDEO_ID_RE.test(String(entry.videoId || ''))) return;
  const existing = (await readJSON(WATCH_HISTORY_KEY)).filter((w) => w && typeof w === 'object');
  if (pendingWatch && pendingWatch[0] && pendingWatch[0].videoId === entry.videoId) return;
  const next = [
    { ...entry, watchedAt: Date.now() },
    ...existing.filter((w) => w.videoId !== entry.videoId),
  ].slice(0, WATCH_HISTORY_MAX);
  pendingWatch = next;
  readCache.set(WATCH_HISTORY_KEY, { at: Date.now(), value: next });
  if (!watchWriteTimer) {
    watchWriteTimer = setTimeout(() => {
      watchWriteTimer = null;
      flushWatchWrites();
    }, WATCH_WRITE_DEBOUNCE);
  }
}
