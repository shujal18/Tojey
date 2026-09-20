## 🎬 Reels Section - Complete YouTube Quota Fix

### Root Cause
The Reels system was making **66 YouTube API calls per full refresh** (11 categories × 3 queries × 2 API calls each). With multiple users and frequent category switching, the daily quota (10,000 units) was exhausted within hours.

### Changes Made

#### Backend (youtube.js)
- **Reduced search queries**: 3→1 per category (66→22 API calls for full refresh)
- **Increased cache TTL**: 30 minutes → 4 hours
- **Added stale-while-revalidate**: 6 hours (serve stale cache while background refresh)
- **Quota circuit breaker**: Auto-detects `quotaExceeded`, stops YouTube calls for 1 hour
- **Single-flight locking**: Prevents duplicate concurrent refreshes for same category
- **Local fallback**: Serves videos from `stored_media` when YouTube unavailable
- **Better error responses**: Distinguishes quota errors from other failures

#### Backend (server.js)
- Enhanced `/api/reels/feed` response with:
  - `source`: youtube/cache/stale_cache/local_fallback/cache_quota_fallback/empty
  - `cacheAge`: age of cached data in ms
  - `stale`: boolean for stale-while-revalidate
  - `warning`: human-readable message for UI
  - `quota`: circuit breaker status
- Added `/api/reels/quota-status` endpoint for diagnostics
- Graceful degradation: returns 200 with cached/local data instead of 500 on quota errors

#### Database (db.js)
- Added `source` column to `reels_cache` table (youtube/local)

#### Mobile (ReelsScreen.jsx)
- Handles `warning` messages from backend (shows as toast)
- Displays quota status in empty state
- Supports local video playback via HTML5 video in WebView
- Improved empty state with retry button and descriptive messages
- Logs quota events for debugging

### API Call Reduction

| Scenario | Before | After |
|----------|--------|-------|
| Cold start (all categories) | 66 calls | 22 calls |
| Single category refresh | 6 calls | 2 calls |
| Category switch (cached) | 6 calls | 0 calls |
| Pull-to-refresh (cached) | 6 calls | 0 calls |
| Background refresh | 6 calls | 2 calls |

### Quota Protection
- Circuit breaker activates on `quotaExceeded` (403)
- 1-hour cooldown before retry
- Survives multiple simultaneous requests
- Structured logging: `[YouTube] Quota exceeded - circuit breaker activated for 1 hour`

### Fallback Chain
1. Fresh YouTube data (cache < 4h)
2. Stale YouTube data (4h < cache < 6h) + background refresh
3. Cached YouTube data (quota exceeded)
4. Local Tojey videos (stored_media)
5. Clean empty state with retry

### Testing Scenarios Covered
✅ TEST 1: YouTube working → Reels load  
✅ TEST 2: YouTube quotaExceeded → cached Reels load  
✅ TEST 3: YouTube quotaExceeded + no cache → local Tojey Reels load  
✅ TEST 4: YouTube unavailable + no local → clean empty state  
✅ TEST 5: 20 simultaneous requests → single YouTube refresh  
✅ TEST 6: Cache valid → zero YouTube Search calls  
✅ TEST 7: Cache expired → controlled single refresh  
✅ TEST 8: YouTube refresh fails → old cache remains  
✅ TEST 9: Repeated opens → no new YouTube searches  
✅ TEST 10: Server restart → cache/database consistent  

### Files Changed
- `backend/src/youtube.js` - Complete rewrite with quota protection
- `backend/src/server.js` - Enhanced Reels endpoints
- `backend/src/db.js` - Added source column migration
- `mobile/src/screens/ReelsScreen.jsx` - Local video support, quota warnings

### APK
- `tojey-v1.7.0-fixed.apk` (109 MB) - Release build with all fixes