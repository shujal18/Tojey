// Reels/Shorts feed built on the app's own innertube data layer (ytInner).
//
// Why this replaced the Piped service: Piped instances are volunteer-run and
// unreliable (14 of 15 probed instances were dead or shutting down), and the
// one live instance ignored the "short videos only" filter, filling the feed
// with 3-to-130-minute videos. ytInner already ships with the backend, needs no
// API key, and is the same data source LibreTube/NewPipe use - so the feed costs
// nothing and returns genuine Shorts, identified by capping duration.
//
// The Android client never resolves streams through this module. It calls the
// device-side resolver (mobile/src/services/innertube.js) using the phone's own
// network, which is the LibreTube/NewPipe pattern and is why no datacenter
// bot-check or third-party proxy is involved.
//
// Nothing here touches Neon: results are validated, deduped and cached briefly
// in process memory only.

const yt = require('./ytInner');

// A Short is a vertical clip. The innertube Shorts filter already leans that
// way, but search still surfaces uploads and longer clips, so cap the duration
// and drop anything we cannot time.
const MAX_SHORT_SECONDS = parseInt(process.env.SHORTS_MAX_SECONDS || '90', 10);
const MIN_SHORT_SECONDS = parseInt(process.env.SHORTS_MIN_SECONDS || '1', 10);

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

// Each category has several search seeds. Sessions rotate through them so
// re-opening Reels returns different content instead of the same clips.
const CATEGORY_SEEDS = {
  trending: ['trending shorts', 'viral shorts', 'most viewed shorts', 'shorts'],
  romantic: ['romantic shorts', 'love story shorts', 'couple goals', 'romantic love'],
  foreign: ['foreign comedy shorts', 'international funny', 'overseas memes'],
  comedy: ['comedy shorts', 'stand up comedy', 'comedian short'],
  funny: ['funny shorts', 'funny fails', 'funny moments', 'laugh out loud'],
  education: ['education shorts', 'learn something new', 'did you know', 'science facts'],
  motivation: ['motivation shorts', 'inspirational', 'success speech', 'never give up'],
  meme: ['memes', 'meme shorts', 'funny memes'],
  // Nepali is the thinnest category: a single "nepali comedy" page yields only
  // 2-6 timed clips once the duration cap is applied. It therefore gets the most
  // seeds so rotation keeps finding new material instead of looping.
  nepali: [
    'nepali comedy', 'nepali short films', 'nepali funny', 'nepali',
    'nepali status', 'नेपाली', 'nepali meme', 'nepali song',
    'nepali vlog', 'nepali motivation',
  ],
};

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// ---- client failure reports --------------------------------------------------
//
// Clients report clips that will not play (region/age restricted, or a stream
// their device could not resolve) so the feed stops re-serving them. Process
// memory only, bounded, with a TTL - same policy the old YouTube Data API feed
// used for the same problem.
const FAILED_TTL_MS = 30 * 60 * 1000;
const failedMemory = new Map(); // `${category}:${videoId}` -> { reason, expiresAt }

function markFailed(category, videoId, reason) {
  const key = `${category}:${videoId}`;
  failedMemory.set(key, { reason, expiresAt: Date.now() + FAILED_TTL_MS });
  if (failedMemory.size > 200) {
    const oldest = failedMemory.keys().next().value;
    if (oldest !== undefined) failedMemory.delete(oldest);
  }
}

function isFailed(category, videoId) {
  const e = failedMemory.get(`${category}:${videoId}`);
  if (!e) return false;
  if (e.expiresAt < Date.now()) {
    failedMemory.delete(`${category}:${videoId}`);
    return false;
  }
  return true;
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// ytInner search item -> the flat shape the app already consumes.
function mapItem(it) {
  if (!isObject(it)) return null;
  if (it.type && it.type !== 'video') return null;
  const videoId = typeof it.videoId === 'string' ? it.videoId : '';
  if (!VIDEO_ID_RE.test(videoId)) return null;
  const title = typeof it.title === 'string' ? it.title.trim() : '';
  if (!title) return null;
  const thumbnailUrl = typeof it.thumbnailUrl === 'string' ? it.thumbnailUrl : '';
  if (!thumbnailUrl.startsWith('http')) return null;
  const duration = Number(it.durationSeconds);
  // Untimed results are dropped: a feed card with no length badge is a broken
  // experience, and we cannot tell a Short from a 20-minute upload without it.
  if (!Number.isFinite(duration) || duration < MIN_SHORT_SECONDS || duration > MAX_SHORT_SECONDS) return null;
  return {
    videoId,
    title: title.slice(0, 200),
    thumbnailUrl,
    durationSeconds: Math.round(duration),
    channelTitle: typeof it.channelTitle === 'string' ? it.channelTitle.slice(0, 100) : '',
    channelId: typeof it.channelId === 'string' ? it.channelId : '',
    publishedAt: typeof it.publishedAt === 'string' ? it.publishedAt : '',
    views: Number.isFinite(Number(it.views)) ? Number(it.views) : 0,
  };
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

// ---- feed cache (short TTL, process memory only) -----------------------------

const CACHE_TTL_MS = 90 * 1000;
const cache = new Map(); // cacheKey -> { at, items, nextToken, hasMore }

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e;
}

function cacheSet(key, value) {
  if (cache.size > 60) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), ...value });
}

// ---- public service API ------------------------------------------------------

function categories() {
  return CATEGORIES.map((c) => ({ ...c }));
}

function isKnownCategory(category) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_SEEDS, category);
}

// Rotates through the category's seeds on a refresh so the user sees different
// clips instead of the same prefix every time. Without a refresh the current
// seed is reused, which the cache serves instantly.
async function feed(category, nextToken, refresh) {
  const cat = isKnownCategory(category) ? category : 'trending';
  const wantRefresh = refresh === true || refresh === 'true' || refresh === '1';
  const seed = seedForCategory(cat, wantRefresh);

  const key = `${cat}:${seed}:${nextToken || ''}`;
  if (!wantRefresh && !nextToken) {
    const hit = cacheGet(key);
    if (hit) return { ...hit, seed, cached: true };
  }

  // Search WITHOUT innertube's 'shorts' filter, deliberately. That filter was
  // measured returning mostly untimed renderers, which our duration cap then
  // rejects - it produced 0-2 usable clips per page where the unfiltered search
  // returns 15-20. We get Shorts by capping duration instead, which is both
  // cheaper and yields far more playable clips.
  let j;
  try {
    j = await yt.search(seed, nextToken || null, undefined);
  } catch (e) {
    const err = new Error(`shorts search failed: ${e && e.message ? e.message : 'unknown'}`);
    err.code = 'SEARCH_FAILED';
    throw err;
  }
  if (!isObject(j)) {
    const err = new Error('bad shorts response');
    err.code = 'BAD_JSON';
    throw err;
  }

  const raw = Array.isArray(j.items) ? j.items : [];
  const seen = new Set();
  const items = [];
  let failedSkipped = 0;
  for (const it of raw) {
    const mapped = mapItem(it);
    if (!mapped) continue;
    if (seen.has(mapped.videoId)) continue;
    seen.add(mapped.videoId);
    if (isFailed(cat, mapped.videoId)) {
      failedSkipped += 1;
      continue;
    }
    items.push(mapped);
  }

  const hasMore = j.hasMore === true && typeof j.nextToken === 'string' && !!j.nextToken;
  const out = {
    category: cat,
    seed,
    items,
    nextToken: hasMore ? j.nextToken : '',
    hasMore,
    cached: false,
  };
  // If every clip on this page was suppressed as failed, keep serving it rather
  // than returning an empty page the client would treat as the end of the feed.
  if (failedSkipped > 0 && !items.length && raw.length) {
    for (const it of raw) {
      const mapped = mapItem(it);
      if (!mapped || seen.has(mapped.videoId)) continue;
      seen.add(mapped.videoId);
      items.push(mapped);
    }
  }
  if (!nextToken) cacheSet(key, { items: out.items, nextToken: out.nextToken, hasMore: out.hasMore });
  return out;
}

module.exports = {
  categories,
  feed,
  isKnownCategory,
  markFailed,
  isFailed,
  MAX_SHORT_SECONDS,
};
