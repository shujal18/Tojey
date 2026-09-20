const { google } = require('googleapis');
const { pool } = require('./db');

const youtube = google.youtube('v3');

const CATEGORY_QUERIES = {
  trending: 'trending shorts',
  love: 'romantic shorts',
  comedy: 'comedy shorts',
  funny: 'funny shorts',
  education: 'educational shorts',
  motivation: 'motivation shorts',
  nepali: 'nepali shorts',
  hindi: 'hindi shorts',
  foreign: 'international shorts',
  music: 'music shorts',
  memes: 'meme shorts',
};

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const STALE_WHILE_REVALIDATE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 90;
const BATCH_SIZE = 25;

const QUOTA_DAILY_LIMIT = 10000;
const QUOTA_PER_SEARCH = 100;
const QUOTA_PER_VIDEOS_LIST = 1;

const quotaState = {
  exceeded: false,
  dailyUsed: 0,
  lastResetDate: null,
  cooldownUntil: 0,
};

const refreshPromises = new Map();

function getApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error('YOUTUBE_API_KEY not configured');
  }
  return key;
}

function getTodayDateString() {
  return new Date().toISOString().split('T')[0];
}

async function loadQuotaState() {
  try {
    const result = await pool.query(
      `SELECT key, value FROM app_config WHERE key IN ('quota_daily_used', 'quota_last_reset_date', 'quota_exceeded')`
    );
    const config = {};
    for (const row of result.rows) {
      config[row.key] = row.value;
    }
    
    const today = getTodayDateString();
    const lastReset = config.quota_last_reset_date;
    
    if (lastReset !== today) {
      quotaState.dailyUsed = 0;
      quotaState.lastResetDate = today;
      quotaState.exceeded = false;
      quotaState.cooldownUntil = 0;
      await saveQuotaState();
    } else {
      quotaState.dailyUsed = parseInt(config.quota_daily_used || '0', 10);
      quotaState.lastResetDate = lastReset;
      quotaState.exceeded = config.quota_exceeded === 'true';
      quotaState.cooldownUntil = parseInt(config.quota_cooldown_until || '0', 10);
    }
  } catch (e) {
    console.warn('[YouTube] Could not load quota state from DB, using defaults:', e.message);
    quotaState.lastResetDate = getTodayDateString();
  }
}

async function saveQuotaState() {
  try {
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES 
       ('quota_daily_used', $1),
       ('quota_last_reset_date', $2),
       ('quota_exceeded', $3),
       ('quota_cooldown_until', $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        String(quotaState.dailyUsed),
        quotaState.lastResetDate || getTodayDateString(),
        String(quotaState.exceeded),
        String(quotaState.cooldownUntil),
      ]
    );
  } catch (e) {
    console.error('[YouTube] Failed to save quota state:', e.message);
  }
}

function checkAndResetDailyQuota() {
  const today = getTodayDateString();
  if (quotaState.lastResetDate !== today) {
    quotaState.dailyUsed = 0;
    quotaState.lastResetDate = today;
    quotaState.exceeded = false;
    quotaState.cooldownUntil = 0;
    saveQuotaState();
    console.log('[YouTube] Daily quota reset for new day');
  }
}

function isQuotaExceededError(error) {
  if (!error) return false;
  const message = error.message || String(error);
  return message.includes('quotaExceeded') || 
         message.includes('Quota exceeded') ||
         (error.code === 403 && message.includes('quota')) ||
         (error.errors && error.errors.some(e => e.reason === 'quotaExceeded'));
}

function checkQuotaCircuitBreaker() {
  const now = Date.now();
  checkAndResetDailyQuota();
  
  if (quotaState.exceeded && now < quotaState.cooldownUntil) {
    return true;
  }
  
  if (quotaState.exceeded && now >= quotaState.cooldownUntil) {
    quotaState.exceeded = false;
    quotaState.cooldownUntil = 0;
    saveQuotaState();
    console.log('[YouTube] Quota circuit breaker cooldown expired - allowing requests again');
  }
  
  return false;
}

function markQuotaExceeded() {
  const now = Date.now();
  quotaState.exceeded = true;
  quotaState.cooldownUntil = now + 60 * 60 * 1000;
  saveQuotaState();
  console.warn('[YouTube] Quota exceeded - circuit breaker activated for 1 hour');
}

function recordQuotaUsage(units) {
  quotaState.dailyUsed += units;
  if (quotaState.dailyUsed >= QUOTA_DAILY_LIMIT * 0.95) {
    markQuotaExceeded();
  }
  saveQuotaState();
}

async function searchYouTube(query, options = {}) {
  if (checkQuotaCircuitBreaker()) {
    throw new Error('QUOTA_CIRCUIT_OPEN: YouTube quota circuit breaker active');
  }

  const {
    maxResults = 50,
    videoDuration = 'short',
    videoEmbeddable = 'true',
    videoSyndicated = 'true',
    type = 'video',
    order = 'relevance',
    regionCode,
    relevanceLanguage,
    publishedAfter,
    pageToken,
  } = options;

  const params = {
    key: getApiKey(),
    part: 'snippet',
    q: query,
    maxResults,
    videoDuration,
    videoEmbeddable,
    videoSyndicated,
    type,
    order,
    fields: 'items(id/videoId,snippet(title,thumbnails,channelTitle,publishedAt)),nextPageToken',
  };

  if (regionCode) params.regionCode = regionCode;
  if (relevanceLanguage) params.relevanceLanguage = relevanceLanguage;
  if (publishedAfter) params.publishedAfter = publishedAfter;
  if (pageToken) params.pageToken = pageToken;

  try {
    const response = await youtube.search.list(params);
    recordQuotaUsage(QUOTA_PER_SEARCH);
    return response.data;
  } catch (error) {
    if (isQuotaExceededError(error)) {
      markQuotaExceeded();
      throw new Error('QUOTA_EXCEEDED: YouTube search quota exceeded');
    }
    throw error;
  }
}

async function getVideoDetails(videoIds) {
  if (!videoIds.length) return [];

  if (checkQuotaCircuitBreaker()) {
    throw new Error('QUOTA_CIRCUIT_OPEN: YouTube quota circuit breaker active');
  }

  try {
    const response = await youtube.videos.list({
      key: getApiKey(),
      part: 'contentDetails,snippet',
      id: videoIds.join(','),
      fields: 'items(id,contentDetails/duration,snippet(title,thumbnails,channelTitle,publishedAt))',
    });
    recordQuotaUsage(QUOTA_PER_VIDEOS_LIST * videoIds.length);
    return response.data.items || [];
  } catch (error) {
    if (isQuotaExceededError(error)) {
      markQuotaExceeded();
      throw new Error('QUOTA_EXCEEDED: YouTube video details quota exceeded');
    }
    throw error;
  }
}

function parseISO8601Duration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}

function filterByDuration(videos, minSec = DEFAULT_DURATION_MIN, maxSec = DEFAULT_DURATION_MAX) {
  return videos.filter(v => {
    const duration = parseISO8601Duration(v.contentDetails?.duration || 'PT0S');
    return duration >= minSec && duration <= maxSec;
  });
}

async function fetchCategoryVideos(category) {
  const query = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.trending;
  const allVideos = [];
  const seenIds = new Set();

  const regionCode = category === 'nepali' ? 'NP' : category === 'hindi' ? 'IN' : 'US';
  const relevanceLanguage = category === 'nepali' ? 'ne' : category === 'hindi' ? 'hi' : 'en';

  try {
    const data = await searchYouTube(query, {
      maxResults: 50,
      regionCode,
      relevanceLanguage,
    });

    if (!data.items?.length) {
      console.log(`[YouTube] No results for category=${category} query="${query}"`);
      return { videos: [], nextPageToken: null, hasMore: false };
    }

    const videoIds = data.items.map(i => i.id?.videoId).filter(Boolean);
    if (!videoIds.length) {
      return { videos: [], nextPageToken: null, hasMore: false };
    }

    const details = await getVideoDetails(videoIds);
    const filtered = filterByDuration(details);

    for (const video of filtered) {
      if (!seenIds.has(video.id)) {
        seenIds.add(video.id);
        allVideos.push({
          videoId: video.id,
          title: video.snippet?.title || '',
          thumbnailUrl: video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || '',
          durationSeconds: parseISO8601Duration(video.contentDetails?.duration || 'PT0S'),
          category,
          channelTitle: video.snippet?.channelTitle || '',
          publishedAt: video.snippet?.publishedAt || null,
          source: 'youtube',
        });
      }
    }

    return {
      videos: allVideos.slice(0, BATCH_SIZE),
      nextPageToken: allVideos.length >= BATCH_SIZE ? data.nextPageToken || 'continue' : null,
      hasMore: allVideos.length >= BATCH_SIZE,
    };
  } catch (error) {
    if (error.message.startsWith('QUOTA_')) {
      throw error;
    }
    console.error(`[YouTube] Error fetching category ${category}:`, error.message);
    throw error;
  }
}

async function getCachedFeed(category, excludeUnavailable = true) {
  let query = `
    SELECT video_id, title, thumbnail_url, duration_seconds, category, channel_title, published_at, source, fetched_at, availability, failure_count
    FROM reels_cache
    WHERE category = $1
  `;
  
  if (excludeUnavailable) {
    query += ` AND (availability IS NULL OR availability != 'unavailable')`;
  }
  
  query += ` ORDER BY fetched_at DESC LIMIT 50`;
  
  const result = await pool.query(query, [category]);
  return result.rows.map(row => ({
    ...row,
    videoId: row.video_id,
    thumbnailUrl: row.thumbnail_url,
    durationSeconds: row.duration_seconds,
    channelTitle: row.channel_title,
    publishedAt: row.published_at,
    source: row.source || 'youtube',
    availability: row.availability,
    failureCount: row.failure_count,
  }));
}

async function getLocalReels(category) {
  try {
    const result = await pool.query(
      `SELECT sm.filename, sm.mimetype, sm.size, sm.created_at,
              COALESCE(NULLIF(sm.filename, ''), 'local-video') as video_id,
              'Local Video' as title,
              '' as thumbnail_url,
              30 as duration_seconds,
              'Tojey' as channel_title,
              sm.created_at as published_at,
              'local' as source
       FROM stored_media sm
       WHERE sm.mimetype LIKE 'video/%'
       ORDER BY sm.created_at DESC
       LIMIT 20`
    );
    return result.rows.map(row => ({
      videoId: `/uploads/${row.filename}`,
      title: row.title,
      thumbnailUrl: row.thumbnail_url,
      durationSeconds: row.duration_seconds,
      category: category,
      channelTitle: row.channel_title,
      publishedAt: row.published_at,
      source: 'local',
      localUrl: `/uploads/${row.filename}`,
    }));
  } catch (error) {
    console.error('[Reels] Error fetching local reels:', error.message);
    return [];
  }
}

async function cacheFeed(category, videos) {
  if (!videos.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of videos) {
      await client.query(
        `INSERT INTO reels_cache (category, video_id, title, thumbnail_url, duration_seconds, channel_title, published_at, source, fetched_at, availability, failure_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), COALESCE($9, 'unknown'), 0)
         ON CONFLICT (category, video_id) DO UPDATE SET
           title = EXCLUDED.title,
           thumbnail_url = EXCLUDED.thumbnail_url,
           duration_seconds = EXCLUDED.duration_seconds,
           channel_title = EXCLUDED.channel_title,
           published_at = EXCLUDED.published_at,
           source = EXCLUDED.source,
           fetched_at = NOW(),
           availability = COALESCE(reels_cache.availability, 'unknown'),
           failure_count = COALESCE(reels_cache.failure_count, 0)`,
        [category, v.videoId, v.title, v.thumbnailUrl, v.durationSeconds, v.channelTitle, v.publishedAt, v.source || 'youtube', v.availability || 'unknown']
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Cache feed error:', e.message);
  } finally {
    client.release();
  }
}

async function markVideoUnavailable(category, videoId, reason) {
  try {
    await pool.query(
      `UPDATE reels_cache 
       SET availability = 'unavailable', 
           failure_count = failure_count + 1,
           last_failed_at = NOW(),
           failure_reason = $3
       WHERE category = $1 AND video_id = $2`,
      [category, videoId, reason]
    );
    console.log(`[Reels] Marked video ${videoId} as unavailable in category ${category}: ${reason}`);
  } catch (e) {
    console.error('[Reels] Failed to mark video unavailable:', e.message);
  }
}

async function getFeed(category, forceRefresh = false) {
  const validCategories = Object.keys(CATEGORY_QUERIES);
  if (!validCategories.includes(category)) {
    throw new Error(`Invalid category: ${category}`);
  }

  const lockKey = `refresh:${category}`;
  
  if (!forceRefresh) {
    const existingPromise = refreshPromises.get(lockKey);
    if (existingPromise) {
      console.log(`[Reels] Refresh already in progress for ${category}, waiting for existing...`);
      return existingPromise;
    }
  }

  if (!forceRefresh) {
    const cached = await getCachedFeed(category);
    if (cached.length) {
      const oldest = new Date(cached[cached.length - 1].fetched_at);
      const age = Date.now() - oldest.getTime();
      if (age < CACHE_TTL_MS) {
        console.log(`[Reels] Serving fresh cache for ${category} (age: ${Math.round(age/60000)}min, ${cached.length} videos)`);
        return { 
          videos: cached, 
          cached: true, 
          nextPageToken: null, 
          hasMore: false,
          source: 'cache',
          cacheAge: age,
        };
      }
      if (age < STALE_WHILE_REVALIDATE_MS) {
        console.log(`[Reels] Serving stale cache for ${category} (age: ${Math.round(age/60000)}min), triggering background refresh`);
        refreshCategoryInBackground(category);
        return { 
          videos: cached, 
          cached: true, 
          nextPageToken: null, 
          hasMore: false,
          source: 'stale_cache',
          cacheAge: age,
          stale: true,
        };
      }
    }
  }

  if (checkQuotaCircuitBreaker()) {
    console.warn(`[Reels] Quota circuit breaker active, serving cached/stale data for ${category}`);
    const cached = await getCachedFeed(category, false);
    if (cached.length) {
      return { 
        videos: cached, 
        cached: true, 
        nextPageToken: null, 
        hasMore: false,
        source: 'cache_quota_fallback',
        warning: 'YouTube quota exceeded - showing cached results',
      };
    }
    const local = await getLocalReels(category);
    if (local.length) {
      return { 
        videos: local, 
        cached: true, 
        nextPageToken: null, 
        hasMore: false,
        source: 'local_fallback',
        warning: 'YouTube quota exceeded - showing local videos',
      };
    }
    return { 
      videos: [], 
      cached: false, 
      nextPageToken: null, 
      hasMore: false,
      source: 'empty',
      warning: 'No videos available - YouTube quota exceeded and no cached content',
    };
  }

  const refreshPromise = (async () => {
    try {
      console.log(`[Reels] Fetching fresh YouTube data for ${category} (forceRefresh=${forceRefresh})`);
      const result = await fetchCategoryVideos(category);
      await cacheFeed(category, result.videos);
      return { 
        videos: result.videos, 
        cached: false,
        nextPageToken: result.nextPageToken,
        hasMore: result.hasMore,
        source: 'youtube',
      };
    } catch (error) {
      if (error.message.startsWith('QUOTA_')) {
        console.warn(`[Reels] YouTube quota error for ${category}: ${error.message}`);
        const cached = await getCachedFeed(category, false);
        if (cached.length) {
          return { 
            videos: cached, 
            cached: true, 
            nextPageToken: null, 
            hasMore: false,
            source: 'cache_quota_fallback',
            warning: 'YouTube quota exceeded - showing cached results',
          };
        }
        const local = await getLocalReels(category);
        if (local.length) {
          return { 
            videos: local, 
            cached: true, 
            nextPageToken: null, 
            hasMore: false,
            source: 'local_fallback',
            warning: 'YouTube quota exceeded - showing local videos',
          };
        }
        return { 
          videos: [], 
          cached: false, 
          nextPageToken: null, 
          hasMore: false,
          source: 'empty',
          warning: 'YouTube quota exceeded - no cached content available',
        };
      }
      throw error;
    }
  })();

  refreshPromises.set(lockKey, refreshPromise);
  
  try {
    return await refreshPromise;
  } finally {
    refreshPromises.delete(lockKey);
  }
}

function refreshCategoryInBackground(category) {
  const lockKey = `refresh:${category}`;
  if (refreshPromises.has(lockKey)) return;
  if (checkQuotaCircuitBreaker()) return;
  
  const promise = (async () => {
    try {
      console.log(`[Reels] Background refresh for ${category}`);
      const result = await fetchCategoryVideos(category);
      if (result.videos.length > 0) {
        await cacheFeed(category, result.videos);
        console.log(`[Reels] Background refresh completed for ${category}: ${result.videos.length} videos`);
      }
    } catch (error) {
      if (!error.message.startsWith('QUOTA_')) {
        console.error(`[Reels] Background refresh failed for ${category}:`, error.message);
      }
    } finally {
      refreshPromises.delete(lockKey);
    }
  })();
  
  refreshPromises.set(lockKey, promise);
}

function clearOldCache() {
  return pool.query(
    `DELETE FROM reels_cache WHERE fetched_at < NOW() - INTERVAL '7 days'`
  );
}

function getQuotaStatus() {
  const now = Date.now();
  checkAndResetDailyQuota();
  return {
    exceeded: quotaState.exceeded,
    dailyUsed: quotaState.dailyUsed,
    dailyLimit: QUOTA_DAILY_LIMIT,
    lastResetDate: quotaState.lastResetDate,
    cooldownUntil: quotaState.cooldownUntil || null,
    cooldownRemainingMs: quotaState.exceeded && quotaState.cooldownUntil > now 
      ? quotaState.cooldownUntil - now 
      : 0,
  };
}

loadQuotaState();

module.exports = {
  getFeed,
  fetchCategoryVideos,
  getCachedFeed,
  cacheFeed,
  clearOldCache,
  getLocalReels,
  getQuotaStatus,
  markVideoUnavailable,
  CATEGORY_QUERIES,
  CACHE_TTL_MS,
  STALE_WHILE_REVALIDATE_MS,
  DEFAULT_DURATION_MIN,
  DEFAULT_DURATION_MAX,
  BATCH_SIZE,
};