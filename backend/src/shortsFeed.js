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

const { randomUUID } = require('crypto');
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
const failedMemory = new Map(); // videoId -> { reason, expiresAt, categories }

function markFailed(category, videoId, reason) {
  if (!VIDEO_ID_RE.test(videoId)) return;
  const prev = failedMemory.get(videoId);
  const categories = new Set(prev && Array.isArray(prev.categories) ? prev.categories : []);
  if (category) categories.add(category);
  failedMemory.set(videoId, {
    reason: String(reason || 'playback failed').slice(0, 120),
    categories: [...categories].slice(-10),
    expiresAt: Date.now() + FAILED_TTL_MS,
  });
  if (failedMemory.size > 200) {
    const oldest = failedMemory.keys().next().value;
    if (oldest !== undefined) failedMemory.delete(oldest);
  }
}

function isFailed(category, videoId) {
  const e = failedMemory.get(videoId);
  if (!e) return false;
  if (e.expiresAt < Date.now()) {
    failedMemory.delete(videoId);
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

const sessions = new Map(); // `${category}|${user}` -> { seed, pos }

// Per-user served ids keep the For You stream from replaying the same clips.
// Bounded + TTL, process memory only (same as the rest of this feed).
const SERVED_TTL_MS = 30 * 60 * 1000;
const SERVED_MAX = 400;
const servedMemory = new Map(); // `${category}|${user}` -> { ids:Set, at }

function servedFor(key) {
  let e = servedMemory.get(key);
  if (!e || Date.now() - e.at > SERVED_TTL_MS) {
    e = { ids: new Set(), at: Date.now() };
    servedMemory.set(key, e);
  }
  return e;
}

function seedForCategory(category, refresh, opts = {}) {
  const base = CATEGORY_SEEDS[category] || CATEGORY_SEEDS.trending;
  const personal = Array.isArray(opts.seeds)
    ? opts.seeds.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  // For You mixes fresh history-derived searches in front of the generic seeds;
  // other categories keep their topical seeds.
  const seeds = category === 'trending' && personal.length ? [...personal, ...base] : base;
  const key = `${category}|${opts.key || ''}`;
  let s = sessions.get(key);
  if (refresh || !s) {
    const pos = s ? s.pos + 1 : 0;
    s = { seed: seeds[pos % seeds.length], pos };
    sessions.set(key, s);
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

// ---- 50-reel discovery cycle -------------------------------------------------

const CYCLE_SIZE = 50;
const CYCLE_MAX_CALLS = 14;
const CYCLE_MAX_PAGES_PER_SEED = 3;
const CYCLE_TTL_MS = 5 * 60 * 1000;
const cycleInflight = new Map();

function cleanSeeds(raw, limit) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const s = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalizedChannel(item) {
  return String(item.channelTitle || item.channelId || '').trim().toLowerCase();
}

function scoreCandidate(item, source, rank, nonce) {
  const base = source === 'personal' ? 45 : source === 'category' ? 30 : source === 'fresh' ? 22 : 16;
  const views = Math.min(12, Math.log10(Math.max(10, Number(item.views) || 0)) * 2);
  const published = Date.parse(item.publishedAt || '');
  const freshness = Number.isFinite(published) ? Math.max(0, 8 - (Date.now() - published) / (1000 * 60 * 60 * 24 * 30)) : 3;
  const jitter = ((hashString(`${item.videoId}:${nonce}`) % 1000) / 1000) * 9;
  return base + views + freshness + jitter - Math.min(8, rank * 0.35);
}

function seedsForCycle(cat, opts) {
  const base = CATEGORY_SEEDS[cat] || CATEGORY_SEEDS.trending;
  const personal = cleanSeeds(opts.seeds, 8);
  const rotation = Math.abs(hashString(String(opts.nonce || ''))) % Math.max(1, base.length);
  const rotatedBase = [...base.slice(rotation), ...base.slice(0, rotation)];
  if (cat === 'trending') {
    return [
      ...personal.map((s) => ({ seed: s, source: 'personal' })),
      ...rotatedBase.slice(0, 3).map((s) => ({ seed: s, source: 'category' })),
      ...rotatedBase.slice(3, 5).map((s) => ({ seed: s, source: 'fresh' })),
      { seed: 'new shorts discoveries', source: 'explore' },
      { seed: 'must watch shorts', source: 'explore' },
    ];
  }
  return [
    ...rotatedBase.slice(0, 5).map((s) => ({ seed: s, source: 'category' })),
    ...personal.slice(0, 2).map((s) => ({ seed: s, source: 'personal' })),
    ...rotatedBase.slice(5, 7).map((s) => ({ seed: s, source: 'fresh' })),
  ];
}

async function searchCycleSeed(entry, opts, state) {
  const out = [];
  let token = null;
  for (let page = 0; page < CYCLE_MAX_PAGES_PER_SEED; page += 1) {
    if (state.calls >= CYCLE_MAX_CALLS || out.length >= 20) break;
    state.calls += 1;
    let response;
    try {
      response = await yt.search(entry.seed, token, undefined, {
        skipCache: opts.skipCache === true,
        nonce: `${opts.nonce || ''}:${page}`,
      });
    } catch (e) {
      break;
    }
    const raw = Array.isArray(response.items) ? response.items : [];
    out.push(...raw);
    if (response.hasMore && response.nextToken && response.nextToken !== token) token = response.nextToken;
    else break;
  }
  return out.map((it, rank) => {
    const mapped = mapItem(it);
    if (!mapped) return null;
    return { ...mapped, source: entry.source, rank, score: scoreCandidate(mapped, entry.source, rank, opts.nonce || '') };
  }).filter(Boolean);
}

async function generateCycle(cat, opts) {
  const servedKey = `${cat}|${opts.key || ''}`;
  const served = servedFor(servedKey);
  const excluded = new Set(
    cleanIds(opts.exclude).concat([...served.ids])
  );
  const entries = seedsForCycle(cat, opts);
  const state = { calls: 0 };
  const groups = await Promise.all(entries.map((entry) => searchCycleSeed(entry, opts, state)));

  const byId = new Map();
  for (const group of groups) {
    for (const candidate of group) {
      if (excluded.has(candidate.videoId) || isFailed(cat, candidate.videoId)) continue;
      const prev = byId.get(candidate.videoId);
      if (!prev || candidate.score > prev.score) byId.set(candidate.videoId, candidate);
    }
  }

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  const selected = [];
  const deferred = [];
  const channels = new Map();
  for (const candidate of ranked) {
    if (selected.length >= CYCLE_SIZE) break;
    const channel = normalizedChannel(candidate);
    if (channel && (channels.get(channel) || 0) >= 4) {
      deferred.push(candidate);
      continue;
    }
    if (channel) channels.set(channel, (channels.get(channel) || 0) + 1);
    selected.push(candidate);
  }
  for (const candidate of deferred) {
    if (selected.length >= CYCLE_SIZE) break;
    selected.push(candidate);
  }

  const videos = selected.map(({ source: _s, rank: _r, score: _score, ...item }) => item);
  for (const v of videos) served.ids.add(v.videoId);
  served.at = Date.now();
  if (served.ids.size > SERVED_MAX) {
    served.ids = new Set([...served.ids].slice(-Math.floor(SERVED_MAX * 0.75)));
  }

  return {
    cycleId: randomUUID(),
    category: cat,
    videos,
    totalCount: videos.length,
    complete: videos.length >= CYCLE_SIZE,
    nextRefreshAvailable: true,
    createdAt: new Date().toISOString(),
    recommendationCategories: cleanSeeds(opts.seeds, 8),
    feedVersion: 'reels-cycle-v1',
    calls: state.calls,
    message: videos.length >= CYCLE_SIZE ? '' : 'No more distinct playable Shorts were found right now.',
  };
}

function cleanIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const id = String(v || '');
    if (VIDEO_ID_RE.test(id)) out.push(id);
    if (out.length >= 300) break;
  }
  return out;
}

function cycle(category, opts = {}) {
  const cat = isKnownCategory(category) ? category : 'trending';
  const explicit = opts.force === true || /^(refresh|tick)-/.test(String(opts.nonce || ''));
  // Normal opens share one dedupe key so repeated taps reuse the same cycle
  // instead of regenerating because each client supplied a unique nonce.
  const nonceKey = explicit ? String(opts.nonce || Date.now()) : 'open';
  const requestKey = `${cat}|${opts.key || ''}|${nonceKey}`;
  const existing = cycleInflight.get(requestKey);
  if (existing && Date.now() - existing.at < CYCLE_TTL_MS) return existing.promise;
  const promise = generateCycle(cat, opts).catch((e) => {
    const err = new Error(`reel cycle failed: ${e && e.message ? e.message : 'unknown'}`);
    err.code = e && e.code ? e.code : 'CYCLE_FAILED';
    throw err;
  });
  cycleInflight.set(requestKey, { at: Date.now(), promise });
  promise.finally(() => setTimeout(() => cycleInflight.delete(requestKey), CYCLE_TTL_MS));
  return promise;
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
async function feed(category, nextToken, refresh, opts = {}) {
  const cat = isKnownCategory(category) ? category : 'trending';
  const wantRefresh = refresh === true || refresh === 'true' || refresh === '1';
  const seed = seedForCategory(cat, wantRefresh, opts);
  const servedKey = `${cat}|${opts.key || ''}`;
  const served = servedFor(servedKey);
  const exclude = new Set(
    (Array.isArray(opts.exclude) ? opts.exclude : []).filter((v) => VIDEO_ID_RE.test(v))
  );

  const key = `${cat}:${seed}:${nextToken || ''}:${opts.key || ''}`;
  if (!wantRefresh && !nextToken && !exclude.size) {
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
  const suppressed = [];
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
    if (exclude.has(mapped.videoId) || served.ids.has(mapped.videoId)) {
      suppressed.push(mapped);
      continue;
    }
    items.push(mapped);
  }

  // Never hand back an empty For You page just because everything on it was
  // already seen. Re-show the least-recently served batch instead.
  if (!items.length && suppressed.length) {
    for (const m of suppressed) {
      if (items.length >= 12) break;
      items.push(m);
    }
  }

  for (const m of items) served.ids.add(m.videoId);
  served.at = Date.now();
  if (served.ids.size > SERVED_MAX) {
    served.ids = new Set([...served.ids].slice(-Math.floor(SERVED_MAX * 0.75)));
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
  // Record everything actually returned (including the fallback batch).
  for (const m of items) served.ids.add(m.videoId);
  served.at = Date.now();
  if (!nextToken) cacheSet(key, { items: out.items, nextToken: out.nextToken, hasMore: out.hasMore });
  return out;
}

module.exports = {
  categories,
  feed,
  cycle,
  CYCLE_SIZE,
  isKnownCategory,
  markFailed,
  isFailed,
  MAX_SHORT_SECONDS,
};
