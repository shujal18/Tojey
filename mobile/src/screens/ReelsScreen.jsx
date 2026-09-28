import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Image,
  Animated,
  AppState,
  Alert,
  Share as RNShare,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { fs } from '../utils/size';
import { SERVER_URL } from '../config';
import Toast from '../components/Toast';
import { REELS_PLAYER_HTML } from './ReelsPlayerHTML';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

const STORAGE_KEY_FEED_CACHE = '@tojey_reels_feed_cache';
const STORAGE_KEY_FEED_CACHE_TIMESTAMP = '@tojey_reels_feed_cache_timestamp';
const FEED_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes local cache
const STORAGE_KEY_SEEN = '@tojey_reels_seen_v1';
const STORAGE_KEY_CURSOR = '@tojey_reels_cursor_v1';
const SEEN_MAX_IDS = 500;
const AUTO_ADVANCE_MAX_PAGES = 4;
const MIN_FRESH_BATCH = 8;
const LIKES_STORAGE_KEY = '@tojey_reels_likes';

const ITEM_HEIGHT = SCREEN_H;

// ---- small helpers ----------------------------------------------------------

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function parseYTErrorCode(errorCode) {
  if (typeof errorCode === 'number') return errorCode;
  if (typeof errorCode === 'string') {
    const parts = errorCode.trim().split(/[\s,-]+/);
    const code = parseInt(parts[0], 10);
    if (!isNaN(code)) return code;
  }
  return null;
}

function isPlayableError(errorCode) {
  const code = parseYTErrorCode(errorCode);
  if (code === null) return false;
  return [2, 5, 100, 101, 102, 103, 104, 105, 150, 152, 153, 154, 155].includes(code);
}

function validateVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return false;
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId.trim());
}

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== 'string') return null;
  const trimmed = videoId.trim();
  if (validateVideoId(trimmed)) return trimmed;
  return null;
}

function thumbnailUrlFor(item) {
  if (item && typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim()) {
    return item.thumbnailUrl.trim();
  }
  const vid = item && sanitizeVideoId(item.videoId);
  return vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
}

// ---- persistent seen / cursor / feed cache ----------------------------------

async function loadSeen(userId) {
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_KEY_SEEN}/${userId}`);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    console.warn('[Reels] Failed to load seen set:', e);
  }
  return new Set();
}

async function saveSeen(userId, set) {
  try {
    const arr = Array.from(set);
    await AsyncStorage.setItem(`${STORAGE_KEY_SEEN}/${userId}`, JSON.stringify(arr));
  } catch (e) {
    console.warn('[Reels] Failed to save seen set:', e);
  }
}

async function loadCursor(userId, category) {
  try {
    return (await AsyncStorage.getItem(`${STORAGE_KEY_CURSOR}/${userId}/${category}`)) || null;
  } catch (e) {
    return null;
  }
}

async function saveCursor(userId, category, token) {
  try {
    if (token) await AsyncStorage.setItem(`${STORAGE_KEY_CURSOR}/${userId}/${category}`, token);
  } catch (e) {
    console.warn('[Reels] Failed to save cursor:', e);
  }
}

async function loadFeedCache(category) {
  try {
    const [storedData, storedTimestamp] = await Promise.all([
      AsyncStorage.getItem(`${STORAGE_KEY_FEED_CACHE}_${category}`),
      AsyncStorage.getItem(`${STORAGE_KEY_FEED_CACHE_TIMESTAMP}_${category}`),
    ]);
    if (storedData && storedTimestamp) {
      const timestamp = parseInt(storedTimestamp, 10);
      if (nowWithin(timestamp)) {
        const parsed = JSON.parse(storedData);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('[Reels] Loaded feed from cache for category:', category);
          return parsed;
        }
      }
    }
  } catch (e) {
    console.warn('[Reels] Failed to load feed cache:', e);
  }
  return null;
}

function nowWithin(timestamp) {
  return Date.now() - timestamp < FEED_CACHE_MAX_AGE_MS;
}

async function saveFeedCache(category, videos) {
  try {
    await Promise.all([
      AsyncStorage.setItem(`${STORAGE_KEY_FEED_CACHE}_${category}`, JSON.stringify(videos)),
      AsyncStorage.setItem(`${STORAGE_KEY_FEED_CACHE_TIMESTAMP}_${category}`, String(Date.now())),
    ]);
  } catch (e) {
    console.warn('[Reels] Failed to save feed cache:', e);
  }
}

// ---- component ---------------------------------------------------------------

export default function ReelsScreen({ token, user, refreshTick = 0, onBack }) {
  const { theme } = useTheme();
  const [category] = useState('trending');
  const [activeIdx, setActiveIdx] = useState(0);
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState('');
  const [webviewFailed, setWebviewFailed] = useState(false);
  const [likedIds, setLikedIds] = useState(() => new Set());
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);

  const flatListRef = useRef(null);
  const webViewRef = useRef(null);
  const overlayTranslateY = useRef(new Animated.Value(0)).current;
  const scrollOffsetYRef = useRef(0);
  const activeIndexRef = useRef(0);
  const currentVideoIdRef = useRef(null);
  const playerStateRef = useRef('idle'); // idle, loading, ready, playing, paused, buffering, error
  const readyRef = useRef(false);
  const webviewReloadsRef = useRef(0);
  const deadRunRef = useRef(0);
  const staleReportRef = useRef(new Set());
  const lastPlayingVideoIdRef = useRef(null);
  const playWatchRef = useRef(null);
  const isMountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const loadingPageRef = useRef(false);
  const appVisibleRef = useRef(true);
  const touchStartYRef = useRef(0);
  const touchStartXRef = useRef(0);
  const touchStartTimeRef = useRef(0);
  const failedVideoIdsRef = useRef(new Set());
  const pendingSkipRef = useRef(false);
  const categoryRef = useRef(category);

  // Persistent (device-wide) history: videos the user already saw + pagination cursor.
  const seenSetRef = useRef(new Set());
  const seenLoadedRef = useRef(false);

  const nextPageTokenRef = useRef(null);
  const hasMoreRef = useRef(true);
  const isLoadingMoreRef = useRef(false);
  const preloadTargetRef = useRef(null); // {idx,id} of the reel now warming
  const noPlayCountRef = useRef(0);

  // Latest values for stable callbacks.
  const videosRef = useRef([]);
  const fetchFeedRef = useRef(null);
  const loadMoreRef = useRef(null);
  const primeFeedRef = useRef(null);
  const onActivateRef = useRef(null);
  const skipToIndexRef = useRef(null);
  const settleToIndexRef = useRef(null);
  const markSeenRef = useRef(null);

  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);
  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  const authHeaders = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token || ''}`,
  }), [token]);

  // ---- direct-stream resolution (yt-dlp via /api/reels/format) ----------------
  // YouTube gated embeds another device behind the same IP stalls on ("second
  // device just loads"). Playing signed direct URLs from our resolver instead of
  // an anonymous <embed> session is what lets MULTIPLE devices all stream at once.
  const streamCacheRef = useRef(new Map());      // videoId -> {videoUrl,audioUrl}|null
  const streamInflightRef = useRef(new Map());   // videoId -> Promise

  const fetchStreamFormat = useCallback((id) => {
    if (streamCacheRef.current.has(id)) return Promise.resolve(streamCacheRef.current.get(id));
    if (streamInflightRef.current.has(id)) return streamInflightRef.current.get(id);
    const p = (async () => {
      try {
        const res = await fetch(`${SERVER_URL}/api/reels/format/${encodeURIComponent(id)}`, { headers: authHeaders });
        if (!res.ok) throw new Error(`format ${res.status}`);
        const j = await res.json();
        if (!j || !j.video || !j.video.url) throw new Error('no url');
        const entry = { videoUrl: j.video.url, audioUrl: (j.audio && j.audio.url) || '' };
        streamCacheRef.current.set(id, entry);
        return entry;
      } catch (e) {
        streamCacheRef.current.set(id, null);
        return null;
      } finally {
        streamInflightRef.current.delete(id);
      }
    })();
    streamInflightRef.current.set(id, p);
    return p;
  }, [authHeaders]);

  const ensureStream = useCallback((item, idx) => {
    const id = sanitizeVideoId(item && item.videoId);
    if (!id) return;
    const wv = webViewRef.current;
    if (!wv || !readyRef.current) return;
    fetchStreamFormat(id).then((entry) => {
      if (!isMountedRef.current) return;
      if (!entry) {
        // Unresolvable on this deployment (yt-dlp failed) -> treat like a broken
        // reel; if it is the one on screen, leave skating to the next Rx.
        failedVideoIdsRef.current.add(id);
        markSeenIds([id]);
        staleReportRef.current.add(id);
        console.log('[Reels] stream resolve failed, excluding:', id);
        if (currentVideoIdRef.current === id && skipToIndexRef.current) {
          skipToIndexRef.current(activeIndexRef.current);
        }
        return;
      }
      wv.injectJavaScript(
        `window.__setStream(${idx},'${id}','${esc(entry.videoUrl)}','${esc(entry.audioUrl)}'); true;`
      );
    }).catch(() => {});
  }, [fetchStreamFormat, markSeenIds]);

  // ---- YT-style action rail (like / share / sound / more) ---------------------

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(LIKES_STORAGE_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) setLikedIds(new Set(arr.filter((x) => typeof x === 'string')));
        }
      } catch (e) {}
    })();
  }, []);

  const toggleLike = useCallback((id) => {
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        AsyncStorage.setItem(LIKES_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch (e) {}
      return next;
    });
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (webViewRef.current && readyRef.current) {
      webViewRef.current.injectJavaScript(`window.__setMuted(${next ? 'true' : 'false'}); true;`);
    }
  }, []);

  const shareVideo = useCallback((item) => {
    if (!item || !item.videoId) return;
    const url = `https://youtube.com/shorts/${item.videoId}`;
    RNShare.share({ message: `${item.title || 'Check this out'}\n${url}` }).catch(() => {});
  }, []);

  const reportVideo = useCallback((item) => {
    if (!item || !item.videoId) return;
    Alert.alert('Report video', 'Report this reel as unavailable or inappropriate?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: async () => {
          try {
            await fetch(`${SERVER_URL}/api/reels/report`, {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({ videoIds: [item.videoId] }),
            });
            setToast('Reported');
          } catch (e) {}
        },
      },
    ]);
  }, [authHeaders]);

  const webViewSource = useMemo(() => ({
    html: REELS_PLAYER_HTML,
    baseUrl: 'https://tojey.app/',
  }), []);

  // ---- seen-set helpers ------------------------------------------------------

  const markSeen = useCallback((list) => {
    if (!list || !list.length) return;
    const set = seenSetRef.current;
    list.forEach((v) => { if (v && v.videoId) set.add(v.videoId); });
    if (set.size > SEEN_MAX_IDS) {
      const arr = Array.from(set);
      seenSetRef.current = new Set(arr.slice(arr.length - SEEN_MAX_IDS));
    }
    saveSeen(user.id, seenSetRef.current);
  }, [user.id]);

  // Broken reels are never playable, so treat them as seen: they will be skipped
  // on every future visit instead of re-shown at the top of the feed.
  const markSeenIds = useCallback((ids) => {
    if (!ids || !ids.length) return;
    const set = seenSetRef.current;
    ids.forEach((id) => { if (id) set.add(id); });
    if (set.size > SEEN_MAX_IDS) {
      const arr = Array.from(set);
      seenSetRef.current = new Set(arr.slice(arr.length - SEEN_MAX_IDS));
    }
    saveSeen(user.id, seenSetRef.current);
  }, [user.id]);

  // ---- playback wiring (double-buffered HTML engine) -------------------------

  const ensureStreamRef = useRef(null);

  const primeFeed = useCallback((list) => {
    const wv = webViewRef.current;
    if (!wv || !readyRef.current) return;
    if (!list || !list.length) return;
    const v0 = list[0];
    const id0 = sanitizeVideoId(v0 && v0.videoId);
    if (!id0) return;
    const v1 = list[1];
    const id1 = v1 ? sanitizeVideoId(v1.videoId) : null;
    currentVideoIdRef.current = id0;
    playerStateRef.current = 'loading';
    lastPlayingVideoIdRef.current = null;
    const t0 = esc(thumbnailUrlFor(v0));
    const t1 = v1 ? esc(thumbnailUrlFor(v1)) : 'null';
    console.log('[Reels] prime:', id0, id1);
    wv.injectJavaScript(
      `window.__prime('${id0}','${t0}','${id1 || 'null'}','${t1}'); true;`
    );
    if (ensureStreamRef.current) ensureStreamRef.current(v0, 0);
    if (v1 && ensureStreamRef.current) ensureStreamRef.current(v1, 1);
  }, []);

  const schedulePlayWatch = useCallback(() => {
    const target = currentVideoIdRef.current;
    if (playWatchRef.current) clearTimeout(playWatchRef.current);
    playWatchRef.current = setTimeout(() => {
      playWatchRef.current = null;
      if (!isMountedRef.current || !webViewRef.current || !readyRef.current) return;
      if (
        target &&
        lastPlayingVideoIdRef.current !== target &&
        playerStateRef.current !== 'paused'
      ) {
        noPlayCountRef.current += 1;
        if (noPlayCountRef.current >= 2) {
          // Never park on a silent reel: after two nudges that failed to play,
          // force-advance past it.
          console.log('[Reels] No play after retries, advancing:', target);
          noPlayCountRef.current = 0;
          deadRunRef.current += 1;
          if (target) staleReportRef.current.add(target);
          if (skipToIndexRef.current) skipToIndexRef.current(activeIndexRef.current);
        } else {
          console.log('[Reels] No PLAYING yet, nudging:', target);
          webViewRef.current.injectJavaScript('window.__retryPlay && window.__retryPlay(); true;');
          schedulePlayWatch();
        }
      }
    }, 2500);
  }, []);

  const preloadAt = useCallback((preIdx) => {
    const list = videosRef.current;
    const wv = webViewRef.current;
    if (!list || !list[preIdx] || !wv || !readyRef.current) return;
    const nid = sanitizeVideoId(list[preIdx].videoId);
    if (!nid) return;
    preloadTargetRef.current = { idx: preIdx, id: nid };
    wv.injectJavaScript(
      `window.__preload(${preIdx},'${nid}','${esc(thumbnailUrlFor(list[preIdx]))}'); true;`
    );
    if (ensureStreamRef.current) ensureStreamRef.current(list[preIdx], preIdx);
  }, []);

  const preloadNeighbor = useCallback((index) => {
    const list = videosRef.current;
    if (!list || !list.length) return;
    const failed = failedVideoIdsRef.current;
    let preIdx = -1;
    for (let off = 1; off <= 6; off++) {
      const idx = index + off;
      if (idx >= list.length) break;
      if (!failed.has(list[idx].videoId)) { preIdx = idx; break; }
    }
    if (preIdx < 0) return;
    preloadAt(preIdx);
  }, [preloadAt]);

  const onActivate = useCallback((index) => {
    const list = videosRef.current;
    const item = list && list[index];
    const wv = webViewRef.current;
    if (!item || !wv || !readyRef.current) return;

    const id = sanitizeVideoId(item.videoId);
    if (!id) {
      console.warn('[Reels] Invalid videoId, skipping:', item.videoId);
      failedVideoIdsRef.current.add(item.videoId);
      if (skipToIndexRef.current) skipToIndexRef.current(index);
      return;
    }

    currentVideoIdRef.current = id;
    playerStateRef.current = 'loading';
    noPlayCountRef.current = 0;
    console.log('[Reels] activate idx', index, id);
    wv.injectJavaScript(
      `window.__activate(${index},'${id}','${esc(thumbnailUrlFor(item))}'); true;`
    );
    if (ensureStreamRef.current) ensureStreamRef.current(item, index);

    // Warm the next valid reel so the NEXT swipe plays instantly (back-swipes
    // reuse the demoted layer, which still holds the previous video -> instant).
    preloadNeighbor(index);
    schedulePlayWatch();
  }, [preloadNeighbor, schedulePlayWatch]);

  const skipToIndex = useCallback((index) => {
    if (pendingSkipRef.current || !isMountedRef.current) return;
    pendingSkipRef.current = true;
    const list = videosRef.current;
    const failed = failedVideoIdsRef.current;
    const seen = seenSetRef.current;
    // Jump past broken & already-watched reels so we never land on (or park at) one.
    let target = -1;
    for (let t = index + 1; t < list.length; t++) {
      const id = list[t] && sanitizeVideoId(list[t].videoId);
      if (id && !failed.has(id) && !seen.has(id)) { target = t; break; }
    }
    if (target === -1) {
      // Everything ahead is watched/broken: land on the nearest playable-unknown.
      for (let t = index + 1; t < list.length; t++) {
        if (!failed.has(list[t].videoId)) { target = t; break; }
      }
    }
    console.log('[Reels] Skipping video, scrolling to next:', target);
    if (target >= 0 && flatListRef.current) {
      preloadAt(target); // warm the skip destination while it scrolls into view
      setTimeout(() => {
        try {
          // Unanimated jump + forced settle: a dead reel must never be left
          // parked on screen if an animated scroll gets interrupted/reverted.
          flatListRef.current.scrollToOffset({ offset: target * ITEM_HEIGHT, animated: false });
        } catch (e) {
          try {
            flatListRef.current.scrollToIndex({ index: target, animated: false });
          } catch (e2) {}
        }
        if (settleToIndexRef.current) settleToIndexRef.current(target);
      }, 250);
    } else if (list.length === 0) {
      setToast('No more videos available');
    } else if (loadMoreRef.current) {
      loadMoreRef.current();
    }
  }, [preloadAt]);

  // ---- feed fetching ----------------------------------------------------------

  async function fetchFeedPage(cat, token) {
    const q = [`category=${encodeURIComponent(cat)}`, `refresh=false`];
    if (token) q.push(`pageToken=${encodeURIComponent(token)}`);
    const res = await fetch(`${SERVER_URL}/api/reels/feed?${q.join('&')}`, { headers: authHeaders });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load feed');
    return data;
  }

  const fetchFeed = useCallback(async (cat, opts = {}) => {
    const { refresh = false, append = false, pageToken = null } = opts;
    const reqId = ++requestIdRef.current;
    if (loadingPageRef.current) return;
    loadingPageRef.current = true;

    try {
      if (!append) setLoading(true);
      setError(null);

      if (!seenLoadedRef.current) {
        seenSetRef.current = await loadSeen(user.id);
        seenLoadedRef.current = true;
      }

      if (!append) {
        // Instant paint + start playing from the local cache while we refresh.
        // The cached list must respect seen-history so re-entry never replays
        // reels the user has already watched (or that are known-failed).
        if (!refresh && !pageToken) {
          const cached = await loadFeedCache(cat);
          if (
            cached &&
            cached.length &&
            reqId === requestIdRef.current &&
            isMountedRef.current &&
            !videosRef.current.length
          ) {
            const fresh = cached.filter((v) => v && v.videoId &&
              !seenSetRef.current.has(v.videoId) &&
              !failedVideoIdsRef.current.has(v.videoId));
            if (fresh.length) {
              videosRef.current = fresh;
              setVideos(fresh);
              if (primeFeedRef.current) primeFeedRef.current(fresh);
            }
          }
        }
      }

      let data = await fetchFeedPage(cat, pageToken);
      if (!isMountedRef.current || reqId !== requestIdRef.current) return;

      let finalVideos = [];
      let cursor = data.nextPageToken || pageToken || null;
      let hasMore = data.hasMore === true;

      if (!append && !pageToken) {
        // Prefer NEW (unseen) content. On re-entry, jump to the saved cursor so
        // the user gets reels they've never seen instead of page 1 again.
        const novel = (list) =>
          (list || []).filter((v) => v && v.videoId &&
            !seenSetRef.current.has(v.videoId) &&
            !failedVideoIdsRef.current.has(v.videoId));

        let unseen = novel(data.videos);

        if (!refresh) {
          const savedCursor = await loadCursor(user.id, cat);
          if (savedCursor && savedCursor !== data.nextPageToken) {
            try {
              const deeper = await fetchFeedPage(cat, savedCursor);
              if (!isMountedRef.current || reqId !== requestIdRef.current) return;
              unseen = novel(deeper.videos);
              data = deeper;
              cursor = deeper.nextPageToken || savedCursor;
              hasMore = deeper.hasMore === true;
            } catch (e) { /* keep page-1 data */ }
          }
        }

        finalVideos = unseen;
        if (finalVideos.length < MIN_FRESH_BATCH && data.nextPageToken && hasMore) {
          let token = data.nextPageToken;
          for (let i = 0; i < AUTO_ADVANCE_MAX_PAGES; i++) {
            const p = await fetchFeedPage(cat, token);
            if (!isMountedRef.current || reqId !== requestIdRef.current) return;
            finalVideos = [...finalVideos, ...novel(p.videos)];
            cursor = p.nextPageToken || token;
            hasMore = p.hasMore === true;
            if (finalVideos.length >= MIN_FRESH_BATCH || !hasMore || !p.nextPageToken) break;
            token = p.nextPageToken;
          }
        }

        if (finalVideos.length >= 3) {
          finalVideos = finalVideos.slice(0, 40);
        } else if (data.videos && data.videos.length) {
          // Nothing novel left (fully seen / quota fallback). Prefer anything
          // still unseen or not-yet-failed; only show repeats as a last resort
          // so the screen is never blank.
          const stillFresh = data.videos.filter((v) => v && v.videoId &&
            !seenSetRef.current.has(v.videoId) &&
            !failedVideoIdsRef.current.has(v.videoId));
          finalVideos = (stillFresh.length ? stillFresh : data.videos.filter((v) => v && v.videoId)).slice(0, 40);
        }
      } else {
        finalVideos = (data.videos || []).filter((v) => v && v.videoId);
        cursor = data.nextPageToken || pageToken || null;
        hasMore = data.hasMore === true;
      }

      if (cursor) await saveCursor(user.id, cat, cursor);

      if (!append) {
        videosRef.current = finalVideos;
        setVideos(finalVideos);
        markSeenRef.current(finalVideos);
        failedVideoIdsRef.current.clear();
        nextPageTokenRef.current = cursor;
        hasMoreRef.current = hasMore && !!cursor;

        activeIndexRef.current = 0;
        setActiveIdx(0);
        scrollOffsetYRef.current = 0;
        overlayTranslateY.setValue(0);
        if (flatListRef.current) flatListRef.current.scrollToOffset({ offset: 0, animated: false });
        currentVideoIdRef.current = null;
        playerStateRef.current = 'idle';
        if (primeFeedRef.current) primeFeedRef.current(finalVideos);
        if (!refresh && finalVideos.length) saveFeedCache(cat, finalVideos.slice(0, 20));
        console.log('[Reels] Feed ready:', cat, finalVideos.length);
      } else {
        setVideos((prev) => {
          const ids = new Set(prev.map((v) => v.videoId));
          const fresh = finalVideos.filter((v) => !ids.has(v.videoId));
          const merged = [...prev, ...fresh];
          videosRef.current = merged;
          return merged;
        });
        markSeenRef.current(finalVideos);
      }

      if (data.warning) setToast(data.warning);
    } catch (e) {
      if (!isMountedRef.current || reqId !== requestIdRef.current) return;
      console.warn('[Reels] feed error:', e.message);
      if (!append || !videosRef.current.length) {
        setError(e.message);
        setToast(e.message);
      } else {
        setToast(e.message);
      }
    } finally {
      if (isMountedRef.current && reqId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingPageRef.current = false;
      }
    }
  }, [authHeaders, overlayTranslateY, user.id]);

  const loadMore = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRef.current || loadingPageRef.current) return;
    const token = nextPageTokenRef.current;
    if (!token) return;

    isLoadingMoreRef.current = true;
    loadingPageRef.current = true;
    const currentCategory = categoryRef.current;
    try {
      const data = await fetchFeedPage(currentCategory, token);
      if (!isMountedRef.current) return;

      const valid = (data.videos || []).filter((v) => v && v.videoId &&
        !failedVideoIdsRef.current.has(v.videoId) &&
        !seenSetRef.current.has(v.videoId));

      if (valid.length) {
        markSeenRef.current(valid);
        setVideos((prev) => {
          const ids = new Set(prev.map((v) => v.videoId));
          const fresh = valid.filter((v) => !ids.has(v.videoId));
          const merged = [...prev, ...fresh];
          videosRef.current = merged;
          return merged;
        });
      }

      const cursor = data.nextPageToken || token;
      nextPageTokenRef.current = cursor;
      hasMoreRef.current = data.hasMore === true && !!cursor;
      if (cursor) await saveCursor(user.id, currentCategory, cursor);
    } catch (e) {
      console.warn('[Reels] loadMore failed:', e.message);
    } finally {
      if (isMountedRef.current) {
        loadingPageRef.current = false;
        isLoadingMoreRef.current = false;
      }
    }
  }, [authHeaders, user.id]);

  // ---- stable refs ------------------------------------------------------------

  useEffect(() => { fetchFeedRef.current = fetchFeed; }, [fetchFeed]);
  useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);
  useEffect(() => { ensureStreamRef.current = ensureStream; }, [ensureStream]);
  useEffect(() => { primeFeedRef.current = primeFeed; }, [primeFeed]);
  useEffect(() => { onActivateRef.current = onActivate; }, [onActivate]);
  useEffect(() => { skipToIndexRef.current = skipToIndex; }, [skipToIndex]);
  useEffect(() => { markSeenRef.current = markSeen; }, [markSeen]);
  useEffect(() => { settleToIndexRef.current = settleToIndex; }, [settleToIndex]);

  // Queue broken-reel ids and report them to the server in batches so cached
  // feeds everywhere stop re-serving content that can't embed on this region.
  useEffect(() => {
    const iv = setInterval(async () => {
      if (!staleReportRef.current.size) return;
      const ids = Array.from(staleReportRef.current);
      staleReportRef.current.clear();
      try {
        await fetch(`${SERVER_URL}/api/reels/report`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ videoIds: ids }),
        });
      } catch (e) {}
    }, 10000);
    return () => clearInterval(iv);
  }, [authHeaders]);

  // If the WebView host page never becomes ready (flaky load), nudge it once
  // and surface a retry UI if it still will not come up - never leave the user
  // staring at thumbnails-only because the overlay silently failed to boot.
  useEffect(() => {
    if (!videos.length) return;
    const iv = setInterval(() => {
      if (readyRef.current) { clearInterval(iv); return; }
      if (webviewReloadsRef.current < 2) {
        webviewReloadsRef.current += 1;
        console.log('[Reels] WebView not ready, reloading attempt', webviewReloadsRef.current);
        try { webViewRef.current?.reload(); } catch (e) {}
      } else {
        clearInterval(iv);
        setWebviewFailed(true);
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [videos]);

  // ---- webview messages --------------------------------------------------------

  const handleWebViewMessage = useCallback((event) => {
    try {
      const data = typeof event.nativeEvent?.data === 'string' ? JSON.parse(event.nativeEvent.data) : null;
      if (!data || !data.type) return;

      if (data.type === 'ytBufferError') {
        // A warmed neighbor failed to buffer: exclude it so we never present it.
        const vid = typeof data.videoId === 'string' ? data.videoId : '';
        if (vid) {
          failedVideoIdsRef.current.add(vid);
          markSeenIds([vid]);
          staleReportRef.current.add(vid);
          console.log('[Reels] Buffer error, excluding:', vid, data.errorCode);
          // If that was the reel we were warming, preload the next valid one so
          // the upcoming swipe stays instant.
          if (preloadTargetRef.current && preloadTargetRef.current.id === vid) {
            preloadNeighbor(activeIndexRef.current);
          }
        }
        return;
      }

      if (data.type === 'ytPlayerEvent') {
        if (currentVideoIdRef.current && data.videoId && data.videoId !== currentVideoIdRef.current) {
          return; // stale event from a layer that is not the target anymore
        }
        const evt = data.event;
        if (evt === 'ready') {
          playerStateRef.current = 'ready';
        } else if (evt === 'playing') {
          playerStateRef.current = 'playing';
          noPlayCountRef.current = 0;
          deadRunRef.current = 0;
          console.log('[Reels] playing:', data.videoId);
          lastPlayingVideoIdRef.current = currentVideoIdRef.current;
          if (playWatchRef.current) {
            clearTimeout(playWatchRef.current);
            playWatchRef.current = null;
          }
        } else if (evt === 'paused') {
          playerStateRef.current = 'paused';
        } else if (evt === 'buffering') {
          playerStateRef.current = 'buffering';
          console.log('[Reels] BUFFERING:', data.videoId);
        } else if (evt === 'cued') {
          playerStateRef.current = 'ready';
        }
      } else if (data.type === 'ytPlayerError') {
        const errorCode = parseYTErrorCode(data.errorCode);
        const currentIndex = activeIndexRef.current;

        if (currentVideoIdRef.current && data.videoId && data.videoId !== currentVideoIdRef.current) {
          return; // stale error from a different target
        }

        if (currentIndex < videosRef.current.length && isMountedRef.current) {
          console.log('[Reels] YouTube player error (skip?):', errorCode, 'videoId:', currentVideoIdRef.current);
          const shouldSkip = isPlayableError(errorCode) || errorCode === 'API_LOAD_FAILED' || data.errorCode === 'BUFFER_TIMEOUT';
          const item = videosRef.current[currentIndex];
          if (shouldSkip && item && item.videoId) {
            failedVideoIdsRef.current.add(item.videoId);
            markSeenIds([item.videoId]);
            staleReportRef.current.add(item.videoId);
            deadRunRef.current += 1;
            // When the whole visible feed is broken (region/consent lock), stop
            // skip-looping and pull a fresh batch instead of advancing forever.
            if (deadRunRef.current >= 4) {
              deadRunRef.current = 0;
              console.log('[Reels] Too many broken reels in a row, refreshing feed');
              setToast('Too many broken reels - refreshing…');
              if (fetchFeedRef.current) fetchFeedRef.current(categoryRef.current, { refresh: true });
              return;
            }
            if (skipToIndexRef.current) skipToIndexRef.current(currentIndex);
          } else {
            playerStateRef.current = 'error';
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, []);

  // ---- scroll / settle (unchanged behaviour) ----------------------------------

  const handleScroll = useCallback((event) => {
    const y = event.nativeEvent.contentOffset.y;
    scrollOffsetYRef.current = y;
    overlayTranslateY.setValue(activeIndexRef.current * ITEM_HEIGHT - y);
  }, [overlayTranslateY]);

  const settleToIndex = useCallback((index) => {
    const list = videosRef.current;
    if (index < 0 || index >= list.length) return;

    activeIndexRef.current = index;
    pendingSkipRef.current = false;
    scrollOffsetYRef.current = index * ITEM_HEIGHT;
    overlayTranslateY.setValue(0);
    setActiveIdx(index);

    if (onActivateRef.current) onActivateRef.current(index);
  }, [overlayTranslateY]);

  const onViewableItemsChanged = useCallback(({ viewableItems }) => {
    if (!viewableItems || !viewableItems.length) return;
    const newIndex = viewableItems[0].index;
    if (newIndex == null) return;
    if (newIndex >= videosRef.current.length - 3 && loadMoreRef.current) {
      loadMoreRef.current();
    }
  }, []);

  const onMomentumScrollEnd = useCallback((event) => {
    const y = event.nativeEvent.contentOffset.y;
    const settledIndex = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / ITEM_HEIGHT)));
    settleToIndex(settledIndex);
  }, [settleToIndex]);

  const onScrollEndDrag = useCallback(() => {
    setTimeout(() => {
      if (!isMountedRef.current) return;
      const y = scrollOffsetYRef.current;
      const settledIndex = Math.max(0, Math.min(videosRef.current.length - 1, Math.round(y / ITEM_HEIGHT)));
      if (settledIndex !== activeIndexRef.current && Math.abs(y - settledIndex * ITEM_HEIGHT) < 8) {
        settleToIndex(settledIndex);
      }
    }, 320);
  }, [settleToIndex]);

  const viewabilityConfig = useMemo(() => ({
    itemVisiblePercentThreshold: 75,
    minimumViewTime: 100,
  }), []);

  const viewabilityConfigCallbackPairs = useMemo(() => [
    { viewabilityConfig, onViewableItemsChanged },
  ], [viewabilityConfig, onViewableItemsChanged]);

  const onTouchStart = useCallback((event) => {
    touchStartYRef.current = event.nativeEvent?.pageY ?? 0;
    touchStartXRef.current = event.nativeEvent?.pageX ?? 0;
    touchStartTimeRef.current = Date.now();
  }, []);

  const onTouchEnd = useCallback((event) => {
    const touchEndY = event.nativeEvent?.pageY ?? 0;
    const touchEndX = event.nativeEvent?.pageX ?? 0;
    const deltaY = Math.abs(touchEndY - touchStartYRef.current);
    const deltaX = Math.abs(touchEndX - touchStartXRef.current);
    const deltaTime = Date.now() - touchStartTimeRef.current;

    if (deltaX < 15 && deltaY < 15 && deltaTime < 250 && readyRef.current && touchStartXRef.current < SCREEN_W - 96) {
      if (webViewRef.current) {
        if (playerStateRef.current === 'playing' || playerStateRef.current === 'buffering') {
          webViewRef.current.injectJavaScript('window.__pause(); true;');
          playerStateRef.current = 'paused';
        } else if (playerStateRef.current === 'paused') {
          webViewRef.current.injectJavaScript('window.__play(); true;');
          playerStateRef.current = 'playing';
        }
      }
    }
  }, []);

  // ---- boot / lifecycle -------------------------------------------------------

  useEffect(() => {
    isMountedRef.current = true;

    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasActive = appVisibleRef.current;
      const isActive = nextState === 'active';
      appVisibleRef.current = isActive;

      if (isActive && !wasActive) {
        // Returning to the app: refresh so never-seen reels keep coming.
        if (fetchFeedRef.current) fetchFeedRef.current(categoryRef.current, { refresh: true });
      } else if (!isActive) {
        if (webViewRef.current && readyRef.current) {
          webViewRef.current.injectJavaScript('window.__pause(); true;');
          playerStateRef.current = 'paused';
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.remove();
      if (playWatchRef.current) {
        clearTimeout(playWatchRef.current);
        playWatchRef.current = null;
      }
      if (webViewRef.current && readyRef.current) {
        try {
          webViewRef.current.injectJavaScript('window.__destroy(); true;');
        } catch (e) {}
      }
    };
  }, [authHeaders]);

  // Initial feed load + category changes.
  useEffect(() => {
    if (isMountedRef.current) {
      // Cancel any in-flight fetch for the previous category and reset the list.
      requestIdRef.current += 1;
      loadingPageRef.current = false;
      isLoadingMoreRef.current = false;
      nextPageTokenRef.current = null;
      hasMoreRef.current = true;
      setVideos([]);
      videosRef.current = [];
      if (webViewRef.current && readyRef.current) {
        try { webViewRef.current.injectJavaScript('window.__destroy(); true;'); } catch (e) {}
      }
      if (fetchFeedRef.current) fetchFeedRef.current(category, { refresh: false });
    }
  }, [category]);

  // Bottom-nav Reels icon tapped while ALREADY inside Reels -> fresh feed.
  const prevRefreshTickRef = useRef(0);
  useEffect(() => {
    if (!refreshTick || refreshTick === prevRefreshTickRef.current) return;
    prevRefreshTickRef.current = refreshTick;
    if (fetchFeedRef.current) fetchFeedRef.current(categoryRef.current, { refresh: true });
  }, [refreshTick]);

  const onWebViewLoadEnd = useCallback(() => {
    readyRef.current = true;
    webviewReloadsRef.current = 0;
    setWebviewFailed(false);
    console.log('[Reels] webview ready');
    const item = videosRef.current[activeIndexRef.current];
    if (item && primeFeedRef.current) {
      primeFeedRef.current(videosRef.current);
    }
    try {
      webViewRef.current.injectJavaScript(`window.__setMuted(${mutedRef.current ? 'true' : 'false'}); true;`);
    } catch (e) {}
    // Arm the play-watchdog for the first reel (activates it and starts
    // detecting dead/invisible embeds) instead of waiting for a user swipe.
    if (settleToIndexRef.current) settleToIndexRef.current(activeIndexRef.current);
  }, []);

  const onWebViewError = useCallback(() => {
    playerStateRef.current = 'error';
    // A flaky overlay load should self-heal; after 2 failed reloads show a
    // manual retry state instead of a silent thumbnails-only screen.
    if (webviewReloadsRef.current < 2) {
      webviewReloadsRef.current += 1;
      setTimeout(() => {
        try { webViewRef.current?.reload(); } catch (e) {}
      }, 500);
    } else {
      setWebviewFailed(true);
    }
  }, []);

  // ---- render ------------------------------------------------------------------

  if (loading && !videos.length) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (error && !videos.length) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.errorContainer}>
          <Icon name="alert-circle" size={48} color={theme.danger} />
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          <TouchableOpacity
            onPress={() => fetchFeedRef.current && fetchFeedRef.current(categoryRef.current, { refresh: true })}
            style={[styles.retryBtn, { backgroundColor: theme.primary }]}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const activeItem = videos[activeIdx];

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      <FlatList
        ref={flatListRef}
        data={videos}
        keyExtractor={(item) => item.videoId}
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onScrollEndDrag={onScrollEndDrag}
        viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        getItemLayout={(data, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
        renderItem={({ item }) => {
          const videoId = sanitizeVideoId(item.videoId);
          const thumb = thumbnailUrlFor(item);
          return (
            <View style={styles.videoContainer}>
              {videoId ? (
                <Image source={{ uri: thumb }} style={styles.thumbImage} resizeMode="cover" />
              ) : (
                <View style={styles.solidThumb} />
              )}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="video-outline" size={52} color={theme.primaryLight} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              {toast || 'No videos available right now'}
            </Text>
            {toast && (
              <TouchableOpacity
                onPress={() => fetchFeedRef.current && fetchFeedRef.current(categoryRef.current, { refresh: true })}
                style={[styles.retryBtn, { backgroundColor: theme.primary, marginTop: 16 }]}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        }
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={4}
        removeClippedSubviews={true}
      />

      {/* Single overlay WebView hosting the two double-buffered players. */}
      <Animated.View
        style={[styles.playerOverlay, { transform: [{ translateY: overlayTranslateY }] }]}
        pointerEvents="none"
      >
        <WebView
          ref={webViewRef}
          source={webViewSource}
          style={styles.video}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          allowsFullscreenVideo={false}
          setSupportMultipleWindows={false}
          onMessage={handleWebViewMessage}
          onLoadEnd={onWebViewLoadEnd}
          onError={onWebViewError}
          onHttpError={onWebViewError}
          onRenderProcessGone={() => {
            console.log('[Reels] WebView renderer gone, recovering');
            playerStateRef.current = 'idle';
            readyRef.current = false;
            if (webviewReloadsRef.current < 2) {
              webviewReloadsRef.current += 1;
              setTimeout(() => {
                try { webViewRef.current?.reload(); } catch (e) {}
              }, 400);
            } else {
              setWebviewFailed(true);
            }
          }}
          scrollEnabled={false}
          originWhitelist={['*']}
          mixedContentMode="always"
          hardwareAccelerationEnabled={true}
          androidLayerType="hardware"
          overScrollMode="never"
        />
      </Animated.View>

      {webviewFailed && (
        <View style={[styles.errorContainer, styles.retryOverlay]}>
          <Icon name="alert-circle-outline" size={52} color={theme.primaryLight} />
          <Text style={[styles.errorText, { color: theme.text }]}>Reels failed to load</Text>
          <TouchableOpacity
            onPress={() => {
              setWebviewFailed(false);
              webviewReloadsRef.current = 0;
              playerStateRef.current = 'idle';
              try { webViewRef.current?.reload(); } catch (e) {}
            }}
            style={[styles.retryBtn, { backgroundColor: theme.primary }]}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast('')} />}

      {/* Top-left back button: leaves fullscreen Reels and returns to Chats */}
      <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityLabel="Back to chats">
        <Icon name="chevron-back" size={26} color="#fff" />
      </TouchableOpacity>

      {/* YT-style right action rail (non-blocking: touches pass through) */}
      {activeItem && sanitizeVideoId(activeItem.videoId) ? (
        <View style={styles.railWrap} pointerEvents="box-none">
          <View style={styles.railAvatar} pointerEvents="none">
            <Icon name="person" size={24} color="#fff" />
          </View>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={() => toggleLike(activeItem.videoId)}
            accessibilityLabel={likedIds.has(activeItem.videoId) ? 'Unlike' : 'Like'}
          >
            <Icon
              name={likedIds.has(activeItem.videoId) ? 'heart' : 'heart-outline'}
              size={30}
              color={likedIds.has(activeItem.videoId) ? '#FF2C55' : '#fff'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={() => shareVideo(activeItem)}
            accessibilityLabel="Share reel"
          >
            <Icon name="share-social" size={27} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={toggleMute}
            accessibilityLabel={muted ? 'Unmute' : 'Mute'}
          >
            <Icon name={muted ? 'volume-mute' : 'volume-high'} size={27} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.railBtn}
            onPress={() => reportVideo(activeItem)}
            accessibilityLabel="More options"
          >
            <Icon name="ellipsis-horizontal" size={25} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Caption overlay (YT-style): channel row + title over the player */}
      {activeItem ? (
        <View style={styles.caption} pointerEvents="none">
          <View style={styles.captionChannelRow}>
            <View style={styles.captionAvatar} pointerEvents="none">
              <Icon name="person" size={13} color="#fff" />
            </View>
            <Text numberOfLines={1} style={styles.captionChannel}>{activeItem.channelTitle || 'Tojey'}</Text>
          </View>
          <Text numberOfLines={2} style={styles.captionTitle}>{activeItem.title || ''}</Text>
          <Text numberOfLines={1} style={styles.captionMeta}>
            {activeItem.durationSeconds ? `${Math.round(activeItem.durationSeconds)}s` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  videoContainer: {
    width: SCREEN_W,
    height: ITEM_HEIGHT,
    backgroundColor: '#000',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111',
  },
  solidThumb: {
    flex: 1,
    backgroundColor: '#111',
  },
  playerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_W,
    height: ITEM_HEIGHT,
  },
  video: {
    flex: 1,
    backgroundColor: '#000',
  },
  railWrap: {
    position: 'absolute',
    right: 10,
    top: '42%',
    zIndex: 48,
    alignItems: 'center',
    gap: 18,
  },
  railAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(15,15,15,0.55)',
    borderWidth: 1.5,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  railBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(15,15,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: fs(15),
    marginTop: 12,
  },
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  retryOverlay: {
    position: 'absolute',
    top: 44,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 40,
  },
  errorText: {
    fontSize: fs(15),
  },
  retryBtn: {
    paddingHorizontal: fs(24),
    paddingVertical: fs(10),
    borderRadius: fs(10),
  },
  backBtn: {
    position: 'absolute',
    top: 26,
    left: 12,
    zIndex: 50,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: {
    position: 'absolute',
    left: 14,
    right: 92,
    bottom: 20,
    zIndex: 45,
  },
  captionChannelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  captionAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
  },
  captionChannel: {
    color: '#fff',
    fontSize: fs(14),
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
  captionTitle: {
    color: '#fff',
    fontSize: fs(14),
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
  captionMeta: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fs(12),
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 6,
  },
});