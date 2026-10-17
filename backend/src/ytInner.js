// Direct YouTube innertube data layer (LibreTube/NewPipe pattern, no Data API
// quota). Endpoint <-> client mapping is chosen empirically (verified live):
//   - search           -> ANDROID  (compact* renderers + elementRenderer channels)
//   - player           -> ANDROID  (videoDetails, microformat, captions, chapters)
//   - browse (channels -> WEB      (richItemRenderer->lockupViewModel; ANDROID 400s)
//     / playlists)
//   - next (related)   -> WEB      (lockupViewModel; ANDROID uses verbose element
//                                   videoWithContextModel instead)
// Continuation tokens are client-bound, so each endpoint keeps ONE client.

const INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const BASE = 'https://www.youtube.com/youtubei/v1/';

const CLIENTS = {
  ANDROID: {
    clientName: 'ANDROID',
    clientVersion: '20.12.37',
    androidSdkVersion: 30,
    osName: 'Android',
    osVersion: '11',
    hl: 'en',
    gl: 'US',
    utcOffsetMinutes: 0,
  },
  WEB: {
    clientName: 'WEB',
    clientVersion: '2.20240927.01.00',
    hl: 'en',
    gl: 'US',
  },
  IOS: {
    clientName: 'IOS',
    clientVersion: '20.10.4',
    deviceModel: 'iPhone16,2',
    osName: 'iPhone',
    osVersion: '17.5',
    hl: 'en',
    gl: 'US',
    utcOffsetMinutes: 0,
  },
  // ANDROID_VR and VISIONOS are the clients YouTube currently does NOT require
  // a PO Token for (same ones yt-dlp recommends). Both return direct,
  // byte-range-addressable adaptive URLs (mp4 avc1) and are the least likely to
  // hit the datacenter "Sign in to confirm you're not a bot" wall.
  ANDROID_VR: {
    clientName: 'ANDROID_VR',
    clientVersion: '1.60.19',
    deviceMake: 'Oculus',
    deviceModel: 'Quest 3',
    osName: 'Android',
    osVersion: '12',
    androidSdkVersion: 32,
    hl: 'en',
    gl: 'US',
    utcOffsetMinutes: 0,
  },
  VISIONOS: {
    clientName: 'VISIONOS',
    clientVersion: '0.1',
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice14,1',
    osName: 'visionOS',
    osVersion: '1.3.0',
    hl: 'en',
    gl: 'US',
    utcOffsetMinutes: 0,
  },
};

const UAS = {
  ANDROID: 'com.google.android.youtube/20.12.37 (Linux; U; Android 11; US)',
  WEB: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  IOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ANDROID_VR: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip',
  VISIONOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
};

// Client rotation for the streaming `player` call. YouTube flags datacenter
// IPs with `LOGIN_REQUIRED` ("Sign in to confirm you're not a bot") on a
// per-client basis, so when one client is bot-checked we retry the next. Only
// clients that return a direct `url` (not a signatureCipher) are listed.
// ANDROID_VR/VISIONOS are PO-token-free and tried first; IOS/ANDROID follow.
// `playbackContext` (html5Preference) materially reduces bot-checks and is
// always sent.
const PLAYBACK_CLIENTS = ['ANDROID_VR', 'VISIONOS', 'IOS', 'ANDROID'];

// Optional: a YouTube cookie string (e.g. from an incognito session) exported
// into YOUTUBE_COOKIE. On datacenter IPs (Render et al.) a PO Token alone does
// not clear the IP-based bot check; an authenticated/guest cookie is the
// documented workaround. Unset -> anonymous requests, exactly as before.
function cookieHeader() {
  const c = process.env.YOUTUBE_COOKIE;
  return c ? String(c).trim() : '';
}
const PLAYBACK_TTL = 30 * 60 * 1000;
// How long to remember a "no playable source" result (e.g. the egress IP being
// bot-checked). Long enough to stop repeated innertube bursts, short enough to
// recover quickly if YouTube lifts the block.
const NEGATIVE_TTL = 90 * 1000;

const CHANNEL_TAB_PARAMS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHM%3D',
  playlists: 'EgeKAQQoAEAE',
  about: 'EgVhYm91dA%3D%3D',
};

const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value, ttl = CACHE_TTL) {
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

async function call(endpoint, body, opts = {}) {
  const { timeoutMs = 15000, skipCache = false, cacheKey, client = 'ANDROID', ttl } = opts;
  const keyBase = cacheKey || `${client}:${endpoint}:${JSON.stringify(body)}`;
  if (!skipCache) {
    const hit = cacheGet(keyBase);
    if (hit) return hit;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UAS[client],
    };
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (client === 'ANDROID') {
      headers['X-YouTube-Client-Name'] = '38';
      headers['X-YouTube-Client-Version'] = CLIENTS[client].clientVersion;
    }
    const res = await fetch(`${BASE}${endpoint}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        context: { client: CLIENTS[client] },
        ...body,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`innertube ${endpoint}[${client}] status ${res.status}: ${txt.slice(0, 160)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`innertube ${endpoint}[${client}] error: ${j.error.message || j.error.code}`);
    if (!skipCache) cacheSet(keyBase, j, ttl);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

// --- tiny traversal helpers ----------------------------------------------

function firstKey(node, keys) {
  if (!node || typeof node !== 'object') return undefined;
  for (const k of keys) {
    if (node[k] !== undefined) return node[k];
  }
  return undefined;
}

function findRenderers(root, rendererName, out = [], depth = 0) {
  if (!root || typeof root !== 'object' || depth > 24) return out;
  if (Array.isArray(root)) {
    for (const item of root) findRenderers(item, rendererName, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(root)) {
    if (k === rendererName && v && typeof v === 'object') {
      out.push(v);
    } else if (v && typeof v === 'object') {
      findRenderers(v, rendererName, out, depth + 1);
    }
  }
  return out;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const runs = firstKey(node, ['runs', 'simpleText']);
  if (Array.isArray(runs)) return runs.map((r) => (r && r.text) || '').join('');
  if (typeof runs === 'string') return runs;
  if (node.content) return textOf(node.content);
  if (node.title) {
    const t = firstKey(node.title, ['runs', 'simpleText']);
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.map((r) => r.text || '').join('');
  }
  return '';
}

function navTo(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function parseDuration(input) {
  const str = String(input || '').trim();
  const parts = str.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => isNaN(p))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec || 0;
}

function metaPartsOf(lockupMeta) {
  const parts = [];
  const rows = navTo(lockupMeta, ['metadata', 'contentMetadataViewModel', 'metadataRows']) || [];
  for (const r of rows) {
    for (const p of r.metadataParts || []) {
      const txt = p.text?.content;
      if (txt) parts.push(txt);
    }
  }
  return parts;
}

// WEB's current layout renders grid + related items as lockupViewModel. Also
// tolerant of the older videoRenderer/image <=> contentImage forms.
function parseLockup(l) {
  if (!l || typeof l !== 'object') return null;
  const type = l.contentType || '';
  const id = l.contentId;
  if (!id || !type) return null;
  const sources = navTo(l, ['contentImage', 'thumbnailViewModel', 'image', 'sources']) || [];
  const metaVm = navTo(l, ['metadata', 'lockupMetadataViewModel']) || {};
  const title = metaVm.title?.content || textOf(metaVm.title) || '';
  const parts = metaPartsOf(metaVm);
  let duration = 0;
  const overlays = navTo(l, ['contentImage', 'thumbnailViewModel', 'overlays']) || [];
  for (const o of overlays || []) {
    const badges = o.thumbnailBottomOverlayViewModel?.badges || [];
    for (const b of badges) {
      const t = b.thumbnailBadgeViewModel?.text;
      if (t) {
        duration = parseDuration(t);
        break;
      }
    }
    if (duration) break;
  }
  const base = {
    title,
    thumbnailUrl: (sources[sources.length - 1] || {}).url || '',
    durationSeconds: duration,
    views: parts[1] || '',
    publishedAt: parts[2] || '',
  };
  if (type === 'LOCKUP_CONTENT_TYPE_VIDEO') return { type: 'video', videoId: id, ...base, channelTitle: parts[0] || '' };
  if (id.startsWith('VL') || type === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
    return { type: 'playlist', playlistId: id.replace(/^VL/, ''), ...base, channelTitle: parts[0] || '' };
  }
  if (type === 'LOCKUP_CONTENT_TYPE_CHANNEL') {
    return { type: 'channel', channelId: id, ...base, channelTitle: title, subscribers: parts[0] || '' };
  }
  return null;
}

function parseVideoRenderer(r) {
  const videoId = r.videoId;
  if (!videoId) return null;
  const thumb = firstKey(r.thumbnail, ['thumbnails']) || [];
  const owner = firstKey(r, ['ownerText', 'longBylineText', 'shortBylineText']);
  return {
    type: 'video',
    videoId,
    title: textOf(r.title),
    thumbnailUrl: (thumb[thumb.length - 1] || {}).url || ((thumb[0] || {}).url) || '',
    durationSeconds: parseDuration(textOf(r.lengthText)) || parseInt(r.lengthSeconds || '0', 10) || 0,
    channelTitle: textOf(owner),
    channelId: navTo(owner, ['runs', '0', 'navigationEndpoint', 'browseEndpoint', 'browseId']) || '',
    publishedAt: textOf(r.publishedTimeText),
    views: textOf(r.viewCountText),
    live: !!(r.badges || []).some((b) => (b.metadataBadgeRenderer?.style) === 'BADGE_STYLE_TYPE_LIVE_NOW'),
    upcoming: !r.lengthText && !r.lengthSeconds,
  };
}

function parseChannelRenderer(r) {
  const browseId = navTo(r, ['navigationEndpoint', 'browseEndpoint', 'browseId']);
  if (!browseId) return null;
  const thumbs = firstKey(r.thumbnail, ['thumbnails']) || [];
  const badges = (r.badges || []).map((b) => textOf(b?.metadataBadgeRenderer?.label));
  return {
    type: 'channel',
    channelId: browseId,
    channelTitle: textOf(r.title),
    thumbnailUrl: (thumbs[thumbs.length - 1] || {}).url || '',
    subscribers: textOf(r.subscriberCountText),
    videoCount: textOf(r.videoCountText),
    verified: badges.includes('Verified'),
  };
}

function parsePlaylistRenderer(r) {
  const playlistId = navTo(r, ['navigationEndpoint', 'watchEndpoint', 'playlistId']) || r.playlistId;
  if (!playlistId) return null;
  const thumbs = firstKey(r.thumbnail, ['thumbnails']) || [];
  const thumb = (thumbs[thumbs.length - 1] || {}).url || (r.thumbnailRenderer?.playlistVideoThumbnailRenderer?.thumbnail?.thumbnails?.slice(-1)[0]?.url) || '';
  return {
    type: 'playlist',
    playlistId,
    title: textOf(r.title),
    thumbnailUrl: thumb,
    channelTitle: textOf(r.shortBylineText) || textOf(r.longBylineText),
    videoCount: (textOf(r.videoCount) || textOf(r.videoCountShortText) || '').replace(/[^0-9]/g, '') || '',
  };
}

function parseCompactVideo(r) {
  const videoId = r.videoId;
  if (!videoId) return null;
  const thumb = firstKey(r.thumbnail, ['thumbnails']) || [];
  const views = textOf(r.viewCountText);
  const published = textOf(r.publishedTimeText);
  return {
    type: 'video',
    videoId,
    title: textOf(r.title),
    thumbnailUrl: (thumb[thumb.length - 1] || {}).url || ((thumb[0] || {}).url) || '',
    durationSeconds: parseDuration(textOf(r.lengthText)),
    channelTitle: textOf(r.ownerText) || textOf(r.shortBylineText),
    channelId: navTo(r.ownerText || r.shortBylineText, ['runs', '0', 'navigationEndpoint', 'browseEndpoint', 'browseId']) || '',
    publishedAt: published,
    views,
    live: !!(r.badges || []).some((b) => (b.metadataBadgeRenderer?.style) === 'BADGE_STYLE_TYPE_LIVE_NOW'),
    upcoming: !r.lengthText && !r.badges,
  };
}

function parseCompactPlaylist(r) {
  const playlistId = r.playlistId;
  if (!playlistId) return null;
  const thumbs = firstKey(r.thumbnail, ['thumbnails']) || [];
  return {
    type: 'playlist',
    playlistId,
    title: textOf(r.title),
    thumbnailUrl: (thumbs[thumbs.length - 1] || {}).url || '',
    channelTitle: textOf(r.shortBylineText) || textOf(r.longBylineText),
    videoCount: (textOf(r.videoCountShortText) || textOf(r.videoCount) || '').replace(/[^0-9]/g, '') || '',
  };
}

function parseElementChannel(el) {
  const model = navTo(el, ['newElement', 'type', 'componentType', 'model', 'compactChannelModel', 'compactChannelData']);
  if (!model) return null;
  const browseId = navTo(model.onTap, ['innertubeCommand', 'browseEndpoint', 'browseId'])
    || navTo(model.avatar, ['endpoint', 'innertubeCommand', 'browseEndpoint', 'browseId']);
  if (!browseId) return null;
  const sources = navTo(model.avatar, ['image', 'sources']) || [];
  return {
    type: 'channel',
    channelId: browseId,
    channelTitle: (model.title && textOf({ simpleText: model.title })) || '',
    thumbnailUrl: (sources[sources.length - 1] || {}).url || '',
    subscribers: model.subscriberCount || '',
    videoCount: model.videoCount || '',
    verified: !!model.verifiedBadge,
  };
}

function extractItem(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.chipCloudRenderer) return null;
  if (node.lockupViewModel) return parseLockup(node.lockupViewModel);
  if (node.videoRenderer) return parseVideoRenderer(node.videoRenderer);
  if (node.compactVideoRenderer) return parseCompactVideo(node.compactVideoRenderer);
  if (node.channelRenderer) return parseChannelRenderer(node.channelRenderer);
  if (node.playlistRenderer) return parsePlaylistRenderer(node.playlistRenderer);
  if (node.compactPlaylistRenderer) return parseCompactPlaylist(node.compactPlaylistRenderer);
  if (node.elementRenderer) return parseElementChannel(node.elementRenderer);
  if (node.videoCardRenderer?.videoRenderer) return parseVideoRenderer(node.videoCardRenderer.videoRenderer);
  if (node.reelItemRenderer?.videoId) {
    return {
      type: 'shorts',
      videoId: node.reelItemRenderer.videoId,
      title: textOf(node.reelItemRenderer.headline) || '',
      thumbnailUrl: ((firstKey(node.reelItemRenderer.thumbnail, ['thumbnails']) || []).slice(-1)[0] || {}).url || '',
      durationSeconds: 0,
      channelTitle: textOf(node.reelItemRenderer.shortViewCountText) || '',
      views: textOf(node.reelItemRenderer.viewCountText),
    };
  }
  return null;
}

function itemOfContent(content) {
  if (!content || typeof content !== 'object') return null;
  if (content.lockupViewModel) return parseLockup(content.lockupViewModel);
  if (content.videoRenderer) return parseVideoRenderer(content.videoRenderer);
  if (content.compactVideoRenderer) return parseCompactVideo(content.compactVideoRenderer);
  if (content.playlistRenderer) return parsePlaylistRenderer(content.playlistRenderer);
  if (content.compactPlaylistRenderer) return parseCompactPlaylist(content.compactPlaylistRenderer);
  return extractItem(content);
}

function collectSearchItems(sections, nextTokenRef) {
  const items = [];
  for (const sec of sections || []) {
    if (sec.continuationItemRenderer) {
      nextTokenRef.token = sec.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || nextTokenRef.token;
      continue;
    }
    const inn = sec.itemSectionRenderer?.contents || [];
    for (const c of inn) {
      const it = extractItem(c);
      if (it) items.push(it);
    }
  }
  return items;
}

// Channel/playlist browse items: initial page renders via richGridRenderer
// (WEB) and continuation via appendContinuationItemsAction. The latter can be
// reported under either onResponseReceivedEndpoints or onResponseReceivedActions.
function collectBrowseItems(j) {
  const items = [];
  let nextToken = '';
  const tabs = navTo(j, ['contents', 'twoColumnBrowseResultsRenderer', 'tabs']);
  for (const t of tabs || []) {
    const content = t?.tabRenderer?.content;
    if (!content) continue;
    const lists = [content.richGridRenderer?.contents, content.sectionListRenderer?.contents];
    for (const list of lists) {
      for (const c of list || []) {
        if (c.continuationItemRenderer) {
          nextToken = c.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || nextToken;
          continue;
        }
        if (c.richItemRenderer) {
          const it = itemOfContent(c.richItemRenderer.content);
          if (it) items.push(it);
        } else if (c.itemSectionRenderer) {
          for (const sub of c.itemSectionRenderer.contents || []) {
            const it = itemOfContent(sub);
            if (it) items.push(it);
          }
        } else {
          const it = itemOfContent(c);
          if (it) items.push(it);
        }
      }
    }
  }
  for (const ep of appendContinuationActions(j)) {
    for (const c of ep.continuationItems || []) {
      if (c.continuationItemRenderer) {
        nextToken = c.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || nextToken;
        continue;
      }
      const it = itemOfContent(c.richItemRenderer?.content || c);
      if (it) items.push(it);
    }
  }
  return { items, nextToken };
}

function appendContinuationActions(j) {
  const out = [];
  for (const ep of j.onResponseReceivedEndpoints || []) {
    if (ep.appendContinuationItemsAction) out.push(ep.appendContinuationItemsAction);
  }
  for (const act of j.onResponseReceivedActions || []) {
    if (act.appendContinuationItemsAction) out.push(act.appendContinuationItemsAction);
  }
  return out;
}

function parseChannelPageHeader(j, channelId) {
  const pageHeader = findRenderers(j, 'pageHeaderViewModel', []).slice(-1)[0];
  if (pageHeader) {
    const avatar = navTo(pageHeader, ['image', 'decoratedAvatarViewModel', 'avatar', 'avatarViewModel', 'image', 'sources']) || [];
    const banner = navTo(pageHeader, ['banner', 'imageBannerViewModel', 'image', 'sources']) || [];
    const rows = navTo(pageHeader, ['metadata', 'contentMetadataViewModel', 'metadataRows']) || [];
    const parts = [];
    for (const r of rows) for (const p of (r.metadataParts || [])) if (p.text?.content) parts.push(p.text.content);
    return {
      channelId,
      channelTitle: pageHeader.title?.dynamicTextViewModel?.text?.content || textOf(pageHeader.title) || '',
      avatar: (avatar[avatar.length - 1] || {}).url || '',
      banner: (banner[banner.length - 1] || {}).url || '',
      subscribers: parts[1]?.includes('subscri') ? parts[1] : parts[0] || '',
      description: navTo(pageHeader, ['description', 'descriptionViewModel', 'content']) || '',
      links: parts,
    };
  }
  const c4 = findRenderers(j, 'c4TabbedHeaderRenderer', []).slice(-1)[0];
  if (c4) {
    const thumbs = firstKey(c4.avatar, ['thumbnails']) || [];
    const banner = firstKey(c4.banner, ['thumbnails']) || [];
    return {
      channelId,
      channelTitle: textOf(c4.title) || '',
      avatar: (thumbs[thumbs.length - 1] || {}).url || '',
      banner: (banner[banner.length - 1] || {}).url || '',
      subscribers: textOf(c4.subscriberCountText),
      description: textOf(c4.description),
      links: textOf(c4.subtitle),
    };
  }
  return { channelId, channelTitle: textOf(findRenderers(j, 'pageHeaderRenderer', [])[0]?.pageTitle) || '' };
}

function videoFromPlaylistRenderer(wr) {
  const videoId = wr.videoId;
  if (!videoId) return null;
  const parts = textOf(playlistLength(wr)).split(':').map(Number);
  return {
    videoId,
    title: textOf(wr.title),
    thumbnailUrl: ((firstKey(wr.thumbnail, ['thumbnails']) || []).slice(-1)[0] || {}).url || '',
    durationSeconds: parts.reduce((a, b) => (isNaN(b) ? a : a * 60 + b), 0) || parseInt(wr.lengthSeconds || '0', 10) || 0,
    channelTitle: textOf(wr.shortBylineText) || textOf(wr.longBylineText),
    channelId: navTo(wr.shortBylineText || wr.longBylineText, ['runs', '0', 'navigationEndpoint', 'browseEndpoint', 'browseId']) || '',
    index: wr.index?.simpleText,
  };
}

function playlistLength(wr) {
  return (wr.lengthText && (wr.lengthText.simpleText || wr.lengthText.runs)) || { simpleText: wr.lengthSeconds || '' };
}

function likeCountOf(j) {
  const sections = navTo(j, ['contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents']);
  for (const r of Array.isArray(sections) ? sections : []) {
    const seg = navTo(r, ['videoPrimaryInfoRenderer', 'videoActions', 'menuRenderer', 'topLevelButtons', '0', 'segmentedLikeDislikeButtonViewModel']);
    if (!seg) continue;
    const t = navTo(seg, ['likeButtonViewModel', 'likeButtonViewModel', 'toggleButtonViewModel', 'toggleButtonViewModel', 'defaultButtonViewModel', 'buttonViewModel', 'title']);
    if (typeof t === 'string') return t;
  }
  return '';
}

function collectRelated(j) {
  const items = [];
  let nextToken = '';
  const results = navTo(j, ['contents', 'twoColumnWatchNextResults', 'secondaryResults', 'secondaryResults', 'results']);
  for (const r of results || []) {
    if (r.continuationItemRenderer) {
      nextToken = r.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || nextToken;
      continue;
    }
    const it = itemOfContent(r);
    if (it) items.push(it);
  }
  for (const ep of appendContinuationActions(j)) {
    for (const c of ep.continuationItems || []) {
      if (c.continuationItemRenderer) {
        nextToken = c.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || nextToken;
        continue;
      }
      const it = itemOfContent(c);
      if (it) items.push(it);
    }
  }
  return { items, nextToken };
}

function parsePlayerMeta(j, videoId) {
  const vd = j.videoDetails || {};
  const vss = navTo(j, ['microformat', 'playerMicroformatRenderer']) || {};
  const chapters = [];
  const ati = navTo(j, ['playerOverlays', 'playerOverlayRenderer', 'decoratedPlayerBarRenderer', 'decoratedPlayerBarRenderer', 'playerBar', 'multiMarkersPlayerBarRenderer', 'markersMap']);
  if (Array.isArray(ati)) {
    for (const mm of ati) {
      if (!mm || typeof mm !== 'object') continue;
      const markers = Array.isArray(mm.value) ? mm.value : [];
      for (const ch of markers) {
        const c = ch.chapterRenderer;
        if (!c) continue;
        chapters.push({ title: textOf(c.title), start: parseInt(c.timeRangeStartMillis, 10) / 1000 });
      }
    }
  }
  const subtitles = [];
  for (const tr of navTo(j, ['captions', 'playerCaptionsTracklistRenderer', 'captionTracks']) || []) {
    subtitles.push({ lang: tr.languageCode || '', name: (tr.name && textOf(tr.name)) || tr.languageCode || '', baseUrl: tr.baseUrl || '' });
  }
  return {
    videoId,
    title: String(vd.title || ''),
    channel: String(vd.author || ''),
    channelId: String(vd.channelId || ''),
    lengthSeconds: parseInt(vd.lengthSeconds, 10) || 0,
    viewCount: parseInt(String(vss.viewCount || vd.viewCount || '0')) || 0,
    publishedTime: vss.publishDate || '',
    description: String(vd.shortDescription || ''),
    keywords: vd.keywords || [],
    allowRatings: vd.allowRatings !== false,
    isLive: !!vd.isLive,
    isFamilySafe: navTo(j, ['playabilityStatus', 'isFamilySafe']) !== false,
    chapters,
    subtitles,
    playerStatus: navTo(j, ['playabilityStatus', 'status']) || '',
    reason: textOf(navTo(j, ['playabilityStatus', 'reason'])) || '',
  };
}

// --- public API -----------------------------------------------------------

// Home grid categories (regular-length videos, not Shorts). Mirrors the app's
// category list; feeds are built from innertube search so no Data API key is
// needed. Shorts-style clips (<= 90s) are filtered out of the grid.
const HOME_CATEGORIES = {
  trending: { query: 'trending now', label: 'Trending' },
  music: { query: 'popular music videos', label: 'Music' },
  comedy: { query: 'funny comedy clips', label: 'Comedy' },
  gaming: { query: 'gaming videos', label: 'Gaming' },
  tech: { query: 'tech reviews', label: 'Tech' },
  news: { query: 'tech news', label: 'News' },
};

function homeCategories() {
  return Object.keys(HOME_CATEGORIES).map((id) => ({ id, label: HOME_CATEGORIES[id].label }));
}

function isRegularVideo(item) {
  return !!item && item.type === 'video' && (item.durationSeconds || 0) >= 91;
}

async function home(category, token) {
  const conf = HOME_CATEGORIES[category] || HOME_CATEGORIES.trending;
  const res = await search(token ? null : conf.query, token || null, 'videos');
  return {
    videos: (res.items || []).filter(isRegularVideo),
    nextToken: res.nextToken || '',
    hasMore: !!res.hasMore,
  };
}

async function search(query, token, filter) {
  const params = filter === 'videos'
    ? 'EgIQAQ%3D%3D'
    : filter === 'channels' ? 'EgIQAg%3D%3D'
    : filter === 'playlists' ? 'EgIQAw%3D%3D'
    : filter === 'shorts' ? 'EgIQAUICSAE%3D'
    : undefined;
  let j;
  if (token) {
    j = await call('search', { continuation: token }, { cacheKey: `search:${token.slice(0, 24)}` });
  } else {
    j = await call('search', { query, params }, { cacheKey: `search:${query}:${filter || 'all'}` });
  }

  const items = [];
  const tokenRef = { token: '' };
  const initial = navTo(j, ['contents', 'sectionListRenderer']);
  if (initial) {
    items.push(...collectSearchItems(initial.contents, tokenRef));
    const conts = initial.continuations || [];
    if (conts[0]?.nextContinuationData?.continuation) tokenRef.token = conts[0].nextContinuationData.continuation;
  }
  const contContents = navTo(j, ['continuationContents', 'sectionListContinuation']);
  if (contContents) {
    items.push(...collectSearchItems(contContents.contents, tokenRef));
    const conts = contContents.continuations || [];
    if (conts[0]?.nextContinuationData?.continuation) tokenRef.token = conts[0].nextContinuationData.continuation;
  }
  return { items, nextToken: tokenRef.token, hasMore: !!tokenRef.token };
}

async function suggestions(query) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`https://suggestqueries.google.com/complete/search?client=youtube&gs_ri=youtube&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UAS.WEB },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const txt = await res.text();
    const m = txt.match(/\[.*\]/s);
    if (!m) return [];
    let arr;
    try {
      arr = JSON.parse(m[0]);
    } catch (e) {
      return [];
    }
    return Array.isArray(arr) && Array.isArray(arr[1]) ? arr[1].map((x) => (Array.isArray(x) ? x[0] : x)).filter((s) => typeof s === 'string') : [];
  } catch (e) {
    return [];
  }
}

async function channel(channelId, tab, token, skipCache = false) {
  const browseId = String(channelId || '').startsWith('UC') ? channelId : null;
  if (!browseId) throw new Error('invalid channel id');
  let j;
  if (token) {
    j = await call('browse', { continuation: token }, {
      client: 'WEB', skipCache,
      cacheKey: `channelCont:${token.slice(0, 24)}`, ttl: 5 * 60 * 1000,
    });
  } else {
    const params = CHANNEL_TAB_PARAMS[tab] || CHANNEL_TAB_PARAMS.videos;
    j = await call('browse', { browseId, params }, { client: 'WEB', skipCache, cacheKey: `channel:${browseId}:${tab}` });
  }
  const header = parseChannelPageHeader(j, browseId);
  const { items, nextToken } = collectBrowseItems(j);
  return { ...header, type: 'channel', items, nextToken, hasMore: !!nextToken };
}

async function playlist(playlistId, token, skipCache = false) {
  let j;
  if (token) {
    j = await call('browse', { continuation: token }, { client: 'WEB', skipCache, cacheKey: `plCont:${token.slice(0, 24)}`, ttl: 5 * 60 * 1000 });
  } else {
    j = await call('browse', { browseId: `VL${playlistId}` }, { client: 'WEB', skipCache, cacheKey: `pl:${playlistId}` });
  }
  const videos = [];
  const { items, nextToken } = collectBrowseItems(j);
  let index = 1;
  for (const it of items) {
    if (it.type === 'video') videos.push({ ...it, index: index++ });
  }
  for (const wr of findRenderers(j, 'playlistVideoRenderer', [])) {
    const v = videoFromPlaylistRenderer(wr);
    if (v) videos.push(v);
  }
  if (token && !videos.length && !findRenderers(j, 'continuationItemRenderer', []).length) {
    return {
      playlistId,
      type: 'playlist',
      title: '',
      channelTitle: '',
      avatar: '',
      thumbnailUrl: '',
      videoCount: 0,
      description: '',
      videos: [],
      nextToken: '',
      hasMore: false,
    };
  }

  const pr = findRenderers(j, 'pageHeaderRenderer', []).slice(-1)[0] || {};
  const pv = pr.content?.pageHeaderViewModel || {};
  const title = pr.pageTitle || pv.title?.dynamicTextViewModel?.text?.content || textOf(pv.title) || 'Playlist';
  const rows = navTo(pv, ['metadata', 'contentMetadataViewModel', 'metadataRows']) || [];
  const parts = [];
  for (const r of rows) for (const p of (r.metadataParts || [])) if (p.text?.content) parts.push(p.text.content);
  const avatar = navTo(pv, ['image', 'decoratedAvatarViewModel', 'avatar', 'avatarViewModel', 'image', 'sources']) || [];
  const count = parseInt((parts[1] || '').replace(/[^0-9]/g, ''), 10) || videos.length || 0;
  return {
    playlistId,
    type: 'playlist',
    title,
    channelTitle: parts[0] || '',
    avatar: (avatar[avatar.length - 1] || {}).url || '',
    thumbnailUrl: videos[0]?.thumbnailUrl || '',
    videoCount: count,
    description: '',
    videos,
    nextToken,
    hasMore: !!nextToken,
  };
}

async function videoInfo(videoId, token, skipCache = false) {
  if (token) {
    const j = await call('next', { continuation: token }, { client: 'WEB', skipCache, cacheKey: `relatedCont:${token.slice(0, 24)}`, ttl: 5 * 60 * 1000 });
    const { items, nextToken } = collectRelated(j);
    return { related: items, nextToken, hasMore: !!nextToken };
  }
  const [pl, nx] = await Promise.all([
    playerResponse(videoId, skipCache),
    // Related videos are best-effort: a datacenter bot-check on the WEB `next`
    // endpoint must not take down the whole watch screen.
    call('next', {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
    }, { client: 'WEB', skipCache, cacheKey: `next:${videoId}`, ttl: 10 * 60 * 1000 }).catch(() => ({})),
  ]);
  const meta = parsePlayerMeta(pl, videoId);
  const related = collectRelated(nx);
  meta.likeCount = likeCountOf(nx) || '';
  const dateTxt = navTo(nx, ['contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents']);
  for (const r of Array.isArray(dateTxt) ? dateTxt : []) {
    const d = r.videoPrimaryInfoRenderer?.dateText;
    if (d) {
      meta.publishedTime = textOf(d) || meta.publishedTime;
      break;
    }
  }
  meta.related = related.items;
  meta.nextToken = related.nextToken;
  meta.hasMore = related.hasMore;
  return meta;
}

function normalizeFormat(f) {
  if (!f || !f.url) return null;
  const mime = String(f.mimeType || '');
  const codecs = (mime.match(/codecs="([^"]*)"/) || [])[1] || '';
  const hasVideo = /video\//.test(mime);
  // Muxed progressive formats (e.g. itag 18) use a `video/mp4` MIME whose codecs
  // string also lists an audio codec, so check the codecs too.
  const hasAudio = /audio\//.test(mime) || /mp4a|opus|vorbis|ac-3|ec-3|flac/.test(codecs);
  const approxDurationMs = parseInt(f.approxDurationMs, 10) || 0;
  const contentLength = parseInt(f.contentLength, 10)
    || (f.bitrate && approxDurationMs ? Math.round((f.bitrate * approxDurationMs) / 8000) : 0);
  return {
    itag: f.itag,
    url: f.url,
    mimeType: mime,
    codecs,
    quality: f.quality || '',
    qualityLabel: f.qualityLabel || f.audioQuality || '',
    width: f.width || 0,
    height: f.height || 0,
    fps: f.fps || 0,
    bitrate: f.bitrate || 0,
    averageBitrate: f.averageBitrate || 0,
    contentLength,
    audioQuality: f.audioQuality || '',
    audioSampleRate: f.audioSampleRate || '',
    audioChannels: f.audioChannels || 0,
    approxDurationMs: parseInt(f.approxDurationMs, 10) || 0,
    // Byte-range offsets for adaptive (single-file ISO-BMFF) formats; needed to
    // build a DASH MPD with SegmentBase (initialization + sidx index ranges).
    indexRange: f.indexRange ? `${f.indexRange.start}-${f.indexRange.end}` : '',
    initRange: f.initRange ? `${f.initRange.start}-${f.initRange.end}` : '',
    hasVideo,
    hasAudio,
  };
}

// Fetch the `player` response with client rotation + single-flight dedup.
// `call` caches raw responses even when playabilityStatus is LOGIN_REQUIRED, so
// a bot-check would otherwise be pinned for the whole TTL. Instead we probe each
// playback client (skipCache), keep the first OK response that carries direct
// stream URLs, and cache only that good result under one shared key. Concurrent
// requests for the same video share one in-flight promise (the media proxy can
// fire several at once; a burst is exactly what trips YouTube's bot check).
const playerInflight = new Map();

function hasDirectUrl(j) {
  const sd = j.streamingData || {};
  const any = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  return any.some((f) => !!f.url);
}

// A muxed (progressive audio+video) format — e.g. itag 18. Used to prefer the
// response that keeps the progressive path playable (Shorts/Reels `itag=best`
// and the DASH-failure fallback both need one); some clients (IOS) return only
// video-only adaptive streams.
function hasMuxedUrl(j) {
  const sd = j.streamingData || {};
  return (sd.formats || []).some((f) => f.url && /video\//.test(String(f.mimeType || '')) && /(mp4a|opus|vorbis|ac-3|ec-3|flac)/.test(String(f.mimeType || '')));
}

async function playerResponse(videoId, skipCache = false) {
  const key = `playerResp:${videoId}`;
  if (!skipCache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  if (playerInflight.has(key)) return playerInflight.get(key);

  const p = (async () => {
    let firstNonOk = null;
    let firstOk = null;
    const tried = [];
    for (const client of PLAYBACK_CLIENTS) {
      let j;
      try {
        j = await call('player', {
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        }, { client, skipCache: true });
      } catch (e) {
        tried.push(`${client}:err`);
        if (!firstNonOk) firstNonOk = e;
        continue;
      }
      const status = navTo(j, ['playabilityStatus', 'status']);
      tried.push(`${client}:${status}${hasMuxedUrl(j) ? '+mux' : ''}`);
      if (status === 'OK' && hasDirectUrl(j)) {
        // Prefer a response that also carries a muxed format so the progressive
        // path stays usable; keep the first OK-with-URL as a fallback.
        if (hasMuxedUrl(j)) {
          cacheSet(key, j, PLAYBACK_TTL);
          return j;
        }
        if (!firstOk) firstOk = j;
      }
      if (!firstNonOk) firstNonOk = j;
    }
    if (firstOk) {
      cacheSet(key, firstOk, PLAYBACK_TTL);
      return firstOk;
    }
    console.warn(`yt:player no playable source for ${videoId} [${tried.join(' ')}]`);
    // Every client was bot-checked/unplayable. Return whatever we saw so the
    // caller can surface the playability reason to the UI instead of throwing a
    // generic network error.
    if (firstNonOk && typeof firstNonOk === 'object' && firstNonOk.playabilityStatus) {
      // Remember the failure briefly so the frontend's DASH-then-progressive
      // fallback (and any repeat taps) don't each re-fire four innertube calls —
      // a burst of requests is exactly what keeps the egress IP flagged. The
      // frontend switches to the official embed as soon as it sees this.
      cacheSet(key, firstNonOk, NEGATIVE_TTL);
      return firstNonOk;
    }
    if (firstNonOk instanceof Error) throw firstNonOk;
    throw new Error('no playable stream');
  })();

  playerInflight.set(key, p);
  try {
    return await p;
  } finally {
    playerInflight.delete(key);
  }
}

// Returns normalized stream metadata. `url` values are signed, IP-bound
// googlevideo links and must stay server-side (the /api/yt/media proxy uses
// them with the same egress IP that requested them).
async function playerStreams(videoId, skipCache = false) {
  const j = await playerResponse(videoId, skipCache);
  const sd = j.streamingData || {};
  const progressive = (sd.formats || []).map(normalizeFormat).filter(Boolean);
  const adaptive = (sd.adaptiveFormats || []).map(normalizeFormat).filter(Boolean);
  return {
    videoId,
    status: navTo(j, ['playabilityStatus', 'status']) || '',
    reason: textOf(navTo(j, ['playabilityStatus', 'reason'])) || '',
    expiresInSeconds: parseInt(sd.expiresInSeconds, 10) || 0,
    hlsManifestUrl: sd.hlsManifestUrl || '',
    dashManifestUrl: sd.dashManifestUrl || '',
    formats: progressive,
    adaptiveFormats: adaptive,
  };
}

async function playerInfo(videoId, skipCache = false) {
  const j = await playerResponse(videoId, skipCache);
  return parsePlayerMeta(j, videoId);
}

// --- DASH manifest (high-quality adaptive playback) -----------------------
// YouTube never returns dashManifestUrl for VOD, and every client caps *muxed*
// progressive streams at 360p. The only path to YouTube-like quality (>360p) is
// the adaptive (video-only + audio-only) ISO-BMFF formats, which are single files
// addressed by byte ranges. We therefore build an on-demand DASH MPD with
// SegmentBase (initialization + sidx index ranges) whose BaseURLs point back at
// our own /api/yt/media byte proxy. dash.js in the browser then does ABR
// switching exactly like YouTube does.

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function isoDuration(totalSec) {
  const s = Math.max(0, Number(totalSec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3);
  let out = 'PT';
  if (h) out += `${h}H`;
  if (m) out += `${m}M`;
  out += `${sec}S`;
  return out;
}

function pickReps(fmts, preferCodec) {
  // Only ISO-BMFF (mp4) representations are used: H.264 (avc1) + AAC (mp4a) are
  // universally decodable by MSE, so prefer them and fall back to any mp4 if a
  // video happens to lack them. Byte-range info is mandatory for SegmentBase.
  const mp4 = fmts.filter((f) => /\/mp4/.test(f.mimeType || '') && f.indexRange && f.initRange);
  const preferred = preferCodec ? mp4.filter((f) => String(f.codecs || '').startsWith(preferCodec)) : mp4;
  const base = preferred.length ? preferred : mp4;
  const seen = new Set();
  return base.filter((f) => {
    if (seen.has(f.itag)) return false;
    seen.add(f.itag);
    return true;
  });
}

async function dashMpd(videoId, token) {
  const s = await playerStreams(videoId, false);
  if (s.status !== 'OK') {
    const err = new Error(s.reason || 'unplayable');
    err.playabilityStatus = s.status;
    err.reason = s.reason;
    throw err;
  }
  const videoReps = pickReps(s.adaptiveFormats, 'avc1');
  const audioReps = pickReps(s.adaptiveFormats, 'mp4a');
  if (!videoReps.length || !audioReps.length) {
    const e = new Error('no adaptive representations');
    e.playabilityStatus = s.status;
    e.reason = 'no adaptive representations';
    throw e;
  }

  const all = [...s.formats, ...s.adaptiveFormats];
  const durationSec = Math.max(...all.map((f) => (f.approxDurationMs || 0) / 1000)) || 0;
  const tok = encodeURIComponent(token || '');

  const repLine = (f, isVideo) => {
    const attrs = [
      `id="${xmlEsc(String(f.itag))}"`,
      `codecs="${xmlEsc(f.codecs)}"`,
      `bandwidth="${Math.max(1, f.averageBitrate || f.bitrate || 1)}"`,
    ];
    if (isVideo) {
      if (f.width) attrs.push(`width="${f.width}"`);
      if (f.height) attrs.push(`height="${f.height}"`);
      if (f.fps) attrs.push(`frameRate="${f.fps}"`);
    } else if (f.audioSampleRate) {
      attrs.push(`audioSamplingRate="${xmlEsc(f.audioSampleRate)}"`);
    }
    const url = `/api/yt/media/${videoId}?itag=${xmlEsc(String(f.itag))}&token=${tok}`;
    return [
      `      <Representation ${attrs.join(' ')}>`,
      `        <BaseURL>${xmlEsc(url)}</BaseURL>`,
      `        <SegmentBase indexRange="${xmlEsc(f.indexRange)}" timescale="1000">`,
      `          <Initialization range="${xmlEsc(f.initRange)}"/>`,
      `        </SegmentBase>`,
      `      </Representation>`,
    ].join('\n');
  };

  const videoSet = [
    `    <AdaptationSet id="0" contentType="video" mimeType="video/mp4" startWithSAP="1">`,
    ...videoReps.map((f) => repLine(f, true)),
    `    </AdaptationSet>`,
  ].join('\n');
  const audioSet = [
    `    <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" startWithSAP="1">`,
    ...audioReps.map((f) => repLine(f, false)),
    `    </AdaptationSet>`,
  ].join('\n');

  const mpd = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${isoDuration(durationSec)}" minBufferTime="PT1.5S">`,
    `  <Period>`,
    videoSet,
    audioSet,
    `  </Period>`,
    `</MPD>`,
    ``,
  ].join('\n');

  return {
    mpd,
    durationSec,
    videoRepresentations: videoReps.map((f) => ({ itag: f.itag, height: f.height, width: f.width, fps: f.fps, qualityLabel: f.qualityLabel, codecs: f.codecs, bitrate: f.bitrate || f.averageBitrate })),
    audioRepresentations: audioReps.map((f) => ({ itag: f.itag, codecs: f.codecs, bitrate: f.bitrate || f.averageBitrate, audioQuality: f.audioQuality })),
  };
}

async function sponsorSegments(videoId) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}&actionType=skip`, {
      headers: { 'User-Agent': UAS.WEB },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (res.status === 404) return [];
    if (!res.ok) return [];
    const j = await res.json();
    if (!Array.isArray(j)) return [];
    return j.flatMap((group) => (group && Array.isArray(group.segments) ? group.segments : []))
      .map((s) => ({ start: s.start, end: s.end, category: s.category || 'sponsor' }));
  } catch (e) {
    return [];
  }
}

async function dislikes(videoId) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': UAS.WEB },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    return {
      likes: parseInt(j.likes, 10) || 0,
      dislikes: parseInt(j.dislikes, 10) || 0,
      rating: parseFloat(j.rating) || 0,
    };
  } catch (e) {
    return null;
  }
}

async function dearrow(videoId) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': UAS.WEB },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    return {
      title: typeof j.title === 'string' ? j.title : null,
      thumbnail: (Array.isArray(j.thumbnail) && j.thumbnail.length && typeof j.thumbnail[0] === 'string') ? j.thumbnail[0] : null,
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  search,
  home,
  homeCategories,
  suggestions,
  channel,
  playlist,
  videoInfo,
  playerInfo,
  playerStreams,
  dashMpd,
  sponsorSegments,
  dislikes,
  dearrow,
  call,
};