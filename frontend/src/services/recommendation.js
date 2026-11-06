// Recommendation signals shared by the Home grid and the Shorts feed.
//
// History is intentionally device-local (the app has no server-side watch
// tracking), so we distil it into a small list of query seeds plus the ids the
// user has already watched. The backend turns the seeds into fresh innertube
// searches and filters out anything in the exclude list.

export const SEARCH_HISTORY_KEY = 'tojey_search_history_v1';
export const WATCH_HISTORY_KEY = 'tojey_watch_history_v1';

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function readJSON(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

export function getRecommendationSeeds(limit = 8) {
  const searches = readJSON(SEARCH_HISTORY_KEY).filter((s) => typeof s === 'string');
  const watched = readJSON(WATCH_HISTORY_KEY).filter((w) => w && typeof w === 'object');
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

  // Recent explicit searches are the strongest signal.
  searches.slice(0, 6).forEach(push);
  // Channels the user chose to watch come next...
  for (const w of watched.slice(0, 8)) if (w.channelTitle) push(w.channelTitle);
  // ...then a short phrase from watched titles.
  for (const w of watched.slice(0, 6)) {
    if (w.title) push(String(w.title).split(/\s+/).slice(0, 5).join(' '));
  }
  return out.slice(0, Math.max(1, limit));
}

export function getWatchedVideoIds(limit = 250) {
  const watched = readJSON(WATCH_HISTORY_KEY);
  const ids = watched.map((w) => w && w.videoId).filter((v) => typeof v === 'string' && VIDEO_ID_RE.test(v));
  return [...new Set(ids)].slice(0, limit);
}
