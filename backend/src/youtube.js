const { google } = require('googleapis');
const { pool } = require('./db');

const youtube = google.youtube('v3');

const CATEGORY_QUERIES = {
  trending: [
    'trending shorts',
    'viral shorts',
    'popular shorts',
  ],
  love: [
    'romantic shorts',
    'love story shorts',
    'couple shorts',
  ],
  comedy: [
    'comedy shorts',
    'funny shorts',
    'standup comedy shorts',
  ],
  funny: [
    'funny videos shorts',
    'hilarious shorts',
    'meme shorts',
  ],
  education: [
    'educational shorts',
    'learn shorts',
    'facts shorts',
  ],
  motivation: [
    'motivation shorts',
    'inspirational shorts',
    'success shorts',
  ],
  nepali: [
    'nepali shorts',
    'nepal shorts',
    'nepali comedy shorts',
  ],
  hindi: [
    'hindi shorts',
    'hindi comedy shorts',
    'bollywood shorts',
  ],
  foreign: [
    'international shorts',
    'foreign shorts',
    'world shorts',
  ],
  music: [
    'music shorts',
    'song shorts',
    'cover shorts',
  ],
  memes: [
    'meme shorts',
    'dank memes shorts',
    'funny memes shorts',
  ],
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 90;
const BATCH_SIZE = 25;

function getApiKey() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error('YOUTUBE_API_KEY not configured');
  }
  return key;
}

async function searchYouTube(query, options = {}) {
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

  const response = await youtube.search.list(params);
  return response.data;
}

async function getVideoDetails(videoIds) {
  if (!videoIds.length) return [];

  const response = await youtube.videos.list({
    key: getApiKey(),
    part: 'contentDetails,snippet',
    id: videoIds.join(','),
    fields: 'items(id,contentDetails/duration,snippet(title,thumbnails,channelTitle,publishedAt))',
  });

  return response.data.items || [];
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

async function fetchCategoryVideos(category, pageToken = null) {
  const queries = CATEGORY_QUERIES[category] || CATEGORY_QUERIES.trending;
  const allVideos = [];
  const seenIds = new Set();

  for (const query of queries) {
    try {
      const data = await searchYouTube(query, {
        maxResults: 50,
        pageToken,
        regionCode: category === 'nepali' ? 'NP' : category === 'hindi' ? 'IN' : 'US',
        relevanceLanguage: category === 'nepali' ? 'ne' : category === 'hindi' ? 'hi' : 'en',
      });

      if (!data.items?.length) continue;

      const videoIds = data.items.map(i => i.id?.videoId).filter(Boolean);
      if (!videoIds.length) continue;

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
          });
        }
      }

      if (allVideos.length >= BATCH_SIZE) break;
    } catch (e) {
      console.error(`YouTube search error for ${category}/${query}:`, e.message);
    }
  }

  return allVideos.slice(0, BATCH_SIZE);
}

async function getCachedFeed(category) {
  const result = await pool.query(
    `SELECT video_id, title, thumbnail_url, duration_seconds, category, channel_title, published_at
     FROM reels_cache
     WHERE category = $1
     ORDER BY fetched_at DESC
     LIMIT 50`,
    [category]
  );
  return result.rows;
}

async function cacheFeed(category, videos) {
  if (!videos.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of videos) {
      await client.query(
        `INSERT INTO reels_cache (category, video_id, title, thumbnail_url, duration_seconds, channel_title, published_at, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (category, video_id) DO UPDATE SET
           title = EXCLUDED.title,
           thumbnail_url = EXCLUDED.thumbnail_url,
           duration_seconds = EXCLUDED.duration_seconds,
           channel_title = EXCLUDED.channel_title,
           published_at = EXCLUDED.published_at,
           fetched_at = NOW()`,
        [category, v.videoId, v.title, v.thumbnailUrl, v.durationSeconds, v.channelTitle, v.publishedAt]
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

async function getFeed(category, forceRefresh = false) {
  const validCategories = Object.keys(CATEGORY_QUERIES);
  if (!validCategories.includes(category)) {
    throw new Error(`Invalid category: ${category}`);
  }

  if (!forceRefresh) {
    const cached = await getCachedFeed(category);
    if (cached.length) {
      const oldest = new Date(cached[cached.length - 1].fetched_at);
      const age = Date.now() - oldest.getTime();
      if (age < CACHE_TTL_MS) {
        return { videos: cached, cached: true };
      }
    }
  }

  const videos = await fetchCategoryVideos(category);
  await cacheFeed(category, videos);
  return { videos, cached: false };
}

function clearOldCache() {
  return pool.query(
    `DELETE FROM reels_cache WHERE fetched_at < NOW() - INTERVAL '7 days'`
  );
}

module.exports = {
  getFeed,
  fetchCategoryVideos,
  getCachedFeed,
  cacheFeed,
  clearOldCache,
  CATEGORY_QUERIES,
  CACHE_TTL_MS,
  DEFAULT_DURATION_MIN,
  DEFAULT_DURATION_MAX,
  BATCH_SIZE,
};