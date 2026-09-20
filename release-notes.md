## 🎬 Reels Section - Complete YouTube Quota + Error 152 Fix

### Root Causes Identified

**Problem 1 - YouTube Quota Exhaustion:**
- 11 categories × (1 search.list + 1 videos.list) = 22 API calls per full refresh
- Circuit breaker auto-reset after 1 hour caused repeated quota failures
- No persistent quota state - lost on server restart
- loadMore() triggered new YouTube searches on scroll
- No single-flight locking - concurrent requests multiplied API calls

**Problem 2 - Error 152 -4:**
- YouTube IFrame API returns error as "152 -4" string format
- Original code only checked exact numeric match in PERMANENT_YT_ERRORS
- Error parsing failed, treated as transient, video got stuck

---

### Backend Changes (youtube.js)

**Quota Protection:**
- Persistent quota state in `app_config` table (survives restarts)
- Daily limit: 10,000 units (100/search, 1/video detail)
- Automatic daily reset at midnight UTC
- Circuit breaker with 1hr cooldown + daily limit protection
- Structured logging: `[YouTube] Quota exceeded - circuit breaker activated`

**Single-Flight Locking:**
- Promise-based `refreshPromises` Map per category
- 20 concurrent requests → 1 YouTube call, others await same Promise
- No recursive timeout retry pattern

**Cache Strategy:**
- Fresh cache: 4 hours (serve immediately, 0 YouTube calls)
- Stale cache: 6 hours (serve stale + background refresh)
- Quota fallback: serve cache/local/empty without YouTube calls
- Never overwrite good cache with empty API results

**Video Availability Tracking:**
- New columns: `availability`, `failure_count`, `last_failed_at`, `failure_reason`
- `markVideoUnavailable(category, videoId, reason)` for permanent failures
- Exclude unavailable videos from cached feed by default

---

### Database Changes (db.js)

**New Columns in `reels_cache`:**
```sql
availability VARCHAR(20) DEFAULT 'unknown'
failure_count INTEGER DEFAULT 0
last_failed_at TIMESTAMPTZ
failure_reason TEXT
```

**New Table `app_config`:**
```sql
key VARCHAR(100) PRIMARY KEY,  -- quota_daily_used, quota_last_reset_date, quota_exceeded, quota_cooldown_until
value TEXT NOT NULL
```

**New Index:**
```sql
CREATE INDEX idx_reels_cache_availability ON reels_cache(availability);
```

---

### Frontend Changes (ReelsScreen.jsx)

**Error 152 -4 Handling:**
```javascript
function parseYTErrorCode(errorCode) {
  if (typeof errorCode === 'number') return errorCode;
  if (typeof errorCode === 'string') {
    const parts = errorCode.trim().split(/[\s,-]+/);
    const code = parseInt(parts[0], 10);
    if (!isNaN(code)) return code;
  }
  return null;
}
```

**Expanded Permanent Error Codes:**
```javascript
const PERMANENT_YT_ERRORS = new Set([
  2, 5, 100, 101, 102, 103, 104, 105, 150, 152, 153, 154, 155
]);
```

**WebView Error Handling:**
- `onError`, `onHttpError`, `onLoadStart`, `onLoad`, `onLoadEnd`
- HTTP 400+ errors trigger player error handling
- Structured logging: `[Reels WebView] Error: {...}`

**loadMore Fix:**
- `loadMoreFromCache()` only fetches from backend cache
- NO YouTube API calls on scroll
- Pagination from existing cached data

**Proper Embed Headers:**
```javascript
const YOUTUBE_EMBED_HEADERS = {
  'Referer': 'https://www.youtube.com/',
  'Origin': 'https://www.youtube.com',
};
```

**Immediate Skip:**
- Permanent errors skip immediately (no 300ms delay)
- Failed video IDs tracked in `failedVideoIdsRef`

---

### API Response Enhancements

**GET `/api/reels/feed` now returns:**
```json
{
  "videos": [...],
  "source": "youtube|cache|stale_cache|local_fallback|cache_quota_fallback|empty",
  "cacheAge": 123456,
  "stale": true/false,
  "warning": "Human readable message",
  "quota": { "exceeded": false, "dailyUsed": 1234, "dailyLimit": 10000, ... }
}
```

**New Endpoint:** `GET /api/reels/quota-status`

---

### Testing Verification

| Scenario | Before | After |
|----------|--------|-------|
| Cold start (cached) | 22 YouTube calls | 0 YouTube calls |
| Category switch (cached) | 6 YouTube calls | 0 YouTube calls |
| Scroll loadMore | 6 YouTube calls | 0 YouTube calls |
| 20 concurrent users | 440 YouTube calls | 22 YouTube calls |
| Quota exceeded | 500 errors + retries | Cached data served |
| Error 152 -4 | Stuck video | Auto-skip to next |
| Server restart | Quota state lost | State persisted |

---

### Files Changed

1. `backend/src/youtube.js` - Complete quota architecture rewrite
2. `backend/src/db.js` - Schema migrations + app_config table
3. `backend/src/server.js` - Enhanced error handling for QUOTA_ errors
4. `mobile/src/screens/ReelsScreen.jsx` - Error 152 fix, WebView handlers, loadMore cache-only

---

### APK

- `tojey-v1.7.2-fixed.apk` (109 MB) - Release build
- Android 6.0+ (API 23) compatible
- All existing features preserved (Chat, FCM, Auth, Media)