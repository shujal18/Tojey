// Playback source resolution shared by the Android player and downloads.
//
// Primary path: resolve a muxed progressive URL on the DEVICE (residential IP,
// no CORS) using the same PO-token-free innertube clients as the backend. This
// is what makes playback independent of Render's bot-flagged egress IP.
// Fallback path: the backend byte proxy (/api/yt/streams + /api/yt/media).
import { SERVER_URL } from '../config';
import { getShortStream } from './innertube';

function mimeFromUrl(url) {
  const m = /[?&]mime=([^&]+)/i.exec(String(url || ''));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch (e) {
    return '';
  }
}

export function mediaProxyUrl(videoId, token, itag = 'best', maxHeight = 0) {
  const t = encodeURIComponent(token || '');
  const cap = maxHeight > 0 ? `&maxHeight=${encodeURIComponent(maxHeight)}` : '';
  return `${SERVER_URL}/api/yt/media/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(itag)}&token=${t}${cap}`;
}

// Adaptive (video-only + audio-only) DASH manifest. Kept for compatibility with
// the player's optional DASH path; its segment BaseURLs point back at the byte
// proxy, so ExoPlayer never talks to googlevideo directly.
export function dashProxyUrl(videoId, token) {
  const t = encodeURIComponent(token || '');
  return `${SERVER_URL}/api/yt/dash/${encodeURIComponent(videoId)}?token=${t}`;
}

async function fetchStreams(videoId, token, retry = false) {
  const ac = new AbortController();
  // Metadata is an optimisation, not a hard dependency: the proxy accepts
  // itag=best and resolves the format itself. Keep this short so a slow
  // innertube probe never leaves the player stuck on a spinner.
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const suffix = retry ? '?refresh=true' : '';
    const res = await fetch(`${SERVER_URL}/api/yt/streams/${encodeURIComponent(videoId)}${suffix}`, {
      headers: { Authorization: `Bearer ${token || ''}` },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`streams ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns { videoId, videoUrl, audioUrl, height, itag }. `videoUrl` is always a
// playable muxed progressive source. Never throws — it always hands back a
// usable URL so the player can start.
export async function getProxyPlayback(videoId, token, opts = {}) {
  const maxHeight = opts.maxHeight || 720;
  const retry = opts.retry === true || opts.skipCache === true;

  // 1) Device-side extraction first. This is the only path that works when the
  //    backend's datacenter IP is YouTube-bot-checked.
  try {
    const direct = await getShortStream(videoId, { maxHeight, attempts: retry ? 1 : 3 });
    if (direct && direct.url) {
      return {
        videoId,
        videoUrl: direct.url,
        audioUrl: direct.audioUrl || null,
        videoMime: mimeFromUrl(direct.url),
        audioMime: direct.audioUrl ? mimeFromUrl(direct.audioUrl) : '',
        videoHasAudio: !direct.audioUrl,
        height: direct.height || 0,
        itag: direct.itag || 18,
        source: 'device',
      };
    }
  } catch (e) {
    // fall through to the backend proxy
  }

  // 2) Backend byte proxy (also works for videos the device client hides).
  try {
    const data = await fetchStreams(videoId, token, retry);
    const muxed = (data.formats || []).filter((f) => f && f.hasVideo && f.hasAudio);
    const withinCap = muxed
      .filter((f) => !f.height || f.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const pick = withinCap[0] || muxed.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const itag = pick && pick.itag != null ? pick.itag : 'best';
    const audio = data.defaultAudio;
    return {
      videoId,
      videoUrl: `${mediaProxyUrl(videoId, token, itag, maxHeight)}${retry ? `&_=${Date.now()}` : ''}`,
      audioUrl: audio && audio.itag != null ? `${mediaProxyUrl(videoId, token, audio.itag)}${retry ? `&_=${Date.now()}` : ''}` : null,
      videoMime: (pick && pick.mimeType) || '',
      audioMime: (audio && audio.mimeType) || '',
      videoHasAudio: !!(pick && pick.hasAudio),
      height: (pick && pick.height) || 0,
      itag,
      source: 'proxy',
    };
  } catch (e) {
    return {
      videoId,
      videoUrl: mediaProxyUrl(videoId, token, 'best', maxHeight),
      audioUrl: null,
      videoMime: '',
      audioMime: '',
      videoHasAudio: true,
      height: 0,
      itag: 'best',
      source: 'proxy',
    };
  }
}
