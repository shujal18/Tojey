const { google } = require('googleapis');

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
const MAX_ITEMS_PER_CATEGORY = 100;

const QUOTA_DAILY_LIMIT = 10000;
const QUOTA_PER_SEARCH = 100;
const QUOTA_PER_VIDEOS_LIST = 1;

const quotaState = {
  exceeded: false,
  dailyUsed: 0,
  lastResetDate: null,
  cooldownUntil: 0,
};

const refreshLocks = new Map();

const reelsMemoryCache = new Map();

const failedVideoMemory = new Map();
const FAILED_VIDEO_TTL_MS = 30 * 60 * 1000;

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

function checkAndResetDailyQuota() {
  const today = getTodayDateString();
  if (quotaState.lastResetDate !== today) {
    quotaState.dailyUsed = 0;
    quotaState.lastResetDate = today;
    quotaState.exceeded = false;
    quotaState.cooldownUntil = 0;
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
    console.log('[YouTube] Quota circuit breaker cooldown expired - allowing requests again');
  }
  
  return false;
}

function markQuotaExceeded() {
  const now = Date.now();
  quotaState.exceeded = true;
  quotaState.cooldownUntil = now + 60 * 60 * 1000;
  console.warn('[YouTube] Quota exceeded - circuit breaker activated for 1 hour');
}

function recordQuotaUsage(units) {
  quotaState.dailyUsed += units;
  if (quotaState.dailyUsed >= QUOTA_DAILY_LIMIT * 0.95) {
    markQuotaExceeded();
  }
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

function getCacheEntry(category) {
  return reelsMemoryCache.get(category);
}

function setCacheEntry(category, videos) {
  const now = Date.now();
  reelsMemoryCache.set(category, {
    items: videos,
    fetchedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    staleAt: now + STALE_WHILE_REVALIDATE_MS,
  });
  
  if (reelsMemoryCache.size > 50) {
    const oldestKey = reelsMemoryCache.keys().next().value;
    if (oldestKey) reelsMemoryCache.delete(oldestKey);
  }
}

function getStaleCacheEntry(category) {
  const entry = reelsMemoryCache.get(category);
  if (!entry) return null;
  const now = Date.now();
  if (now > entry.staleAt) return null;
  return entry;
}

function isVideoFailed(category, videoId) {
  const key = `${category}:${videoId}`;
  const entry = failedVideoMemory.get(key);
  if (!entry) return false;
  const now = Date.now();
  if (now > entry.expiresAt) {
    failedVideoMemory.delete(key);
    return false;
  }
  return true;
}

function markVideoFailed(category, videoId, reason) {
  const key = `${category}:${videoId}`;
  const now = Date.now();
  failedVideoMemory.set(key, {
    reason,
    expiresAt: now + FAILED_VIDEO_TTL_MS,
  });
  
  if (failedVideoMemory.size > 200) {
    const oldestKey = failedVideoMemory.keys().next().value;
    if (oldestKey) failedVideoMemory.delete(oldestKey);
  }
  console.log(`[Reels] Marked video ${videoId} as failed in category ${category}: ${reason}`);
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
      if (!seenIds.has(video.id) && !isVideoFailed(category, video.id)) {
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

    const result = allVideos.slice(0, BATCH_SIZE);
    return {
      videos: result,
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

async function getFeed(category, forceRefresh = false) {
  const validCategories = Object.keys(CATEGORY_QUERIES);
  if (!validCategories.includes(category)) {
    throw new Error(`Invalid category: ${category}`);
  }

  const lockKey = `refresh:${category}`;
  
  if (!forceRefresh) {
    const existingPromise = refreshLocks.get(lockKey);
    if (existingPromise) {
      console.log(`[Reels] Refresh already in progress for ${category}, waiting for existing...`);
      return existingPromise;
    }
  }

  if (!forceRefresh) {
    const cached = getCacheEntry(category);
    if (cached) {
      const now = Date.now();
      const age = now - cached.fetchedAt;
      if (age < CACHE_TTL_MS) {
        console.log(`[Reels] Serving fresh cache for ${category} (age: ${Math.round(age/60000)}min, ${cached.items.length} videos)`);
        return { 
          videos: cached.items, 
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
          videos: cached.items, 
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
    console.warn(`[Reels] Quota circuit breaker active, serving cached data for ${category}`);
    const cached = getCacheEntry(category);
    if (cached) {
      return { 
        videos: cached.items, 
        cached: true, 
        nextPageToken: null, 
        hasMore: false,
        source: 'cache_quota_fallback',
        warning: 'YouTube quota exceeded - showing cached results',
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
      setCacheEntry(category, result.videos);
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
        const cached = getCacheEntry(category);
        if (cached) {
          return { 
            videos: cached.items, 
            cached: true, 
            nextPageToken: null, 
            hasMore: false,
            source: 'cache_quota_fallback',
            warning: 'YouTube quota exceeded - showing cached results',
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

  refreshLocks.set(lockKey, refreshPromise);
  
  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(lockKey);
  }
}

function refreshCategoryInBackground(category) {
  const lockKey = `refresh:${category}`;
  if (refreshLocks.has(lockKey)) return;
  if (checkQuotaCircuitBreaker()) return;
  
  const promise = (async () => {
    try {
      console.log(`[Reels] Background refresh for ${category}`);
      const result = await fetchCategoryVideos(category);
      if (result.videos.length > 0) {
        setCacheEntry(category, result.videos);
        console.log(`[Reels] Background refresh completed for ${category}: ${result.videos.length} videos`);
      }
    } catch (error) {
      if (!error.message.startsWith('QUOTA_')) {
        console.error(`[Reels] Background refresh failed for ${category}:`, error.message);
      }
    } finally {
      refreshLocks.delete(lockKey);
    }
  })();
  
  refreshLocks.set(lockKey, promise);
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

function clearMemoryCache() {
  reelsMemoryCache.clear();
  failedVideoMemory.clear();
  refreshLocks.clear();
  console.log('[Reels] Memory cache cleared');
}

module.exports = {
  getFeed,
  fetchCategoryVideos,
  getQuotaStatus,
  markVideoFailed,
  isVideoFailed,
  CATEGORY_QUERIES,
  CACHE_TTL_MS,
  STALE_WHILE_REVALIDATE_MS,
  DEFAULT_DURATION_MIN,
  DEFAULT_DURATION_MAX,
  BATCH_SIZE,
  clearMemoryCache,
};