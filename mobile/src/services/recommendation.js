import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';

export const SEARCH_HISTORY_KEY = 'tojey_search_history_v1';
export const WATCH_HISTORY_KEY = 'tojey_watch_history_v1';
export const RECOMMENDATION_CHANGED_EVENT = 'tojey_recommendation_changed';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const SEARCH_HISTORY_MAX = 12;

async function readJSON(key) {
  const values = [];
  for (const k of [key, `@${key}`]) {
    try {
      const raw = await AsyncStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) values.push(...parsed);
    } catch (e) {}
  }
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
  emitChanged();
  return next;
}

export async function clearRecentSearches() {
  try {
    await AsyncStorage.removeItem(SEARCH_HISTORY_KEY);
    await AsyncStorage.removeItem(`@${SEARCH_HISTORY_KEY}`);
  } catch (e) {}
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
  const next = [{ ...entry, watchedAt: Date.now() }, ...existing.filter((w) => w.videoId !== entry.videoId)].slice(0, 250);
  try {
    await AsyncStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(next));
  } catch (e) {}
  emitChanged();
}
