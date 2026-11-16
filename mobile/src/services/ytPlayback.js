// Backend-proxied YouTube playback — the same path the web player uses.
//
// The web client never touches googlevideo directly: it asks the backend for
// stream metadata (/api/yt/streams) and then streams bytes through the
// same-egress proxy (/api/yt/media?itag=...&token=...). The proxy resolves
// signatures with PO-token-free clients and always returns a muxed
// (video+audio) progressive stream, which is exactly what a single
// react-native-video <Video> can play. Device-side innertube extraction is not
// used anymore: the old ANDROID client needs a PO token and only yielded
// video-only tracks, so videos failed or played silent.
//import { SERVER_URL } from '../config';

// ---------------------------------------------------
// Returns a URL that the <Video> component can use directly.
// ---------------------------------------------------
export function mediaProxyUrl(videoId, token, itag = 'best') {
  const t = encodeURIComponent(token || '');
  return `${SERVER_URL}/api/yt/media/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(itag)}&token=${t}`;
}

// ---------------------------------------------------
// Ask the backend for the list of available formats.
// Timeout reduced to 10 s so a slow backend never leaves the player stuck on a spinner.
// ---------------------------------------------------
async function fetchStreams(videoId, token) {
  const ac = new AbortController();
  // 10 s is enough for innertube/yt‑dlp probe.
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${SERVER_URL}/api/yt/streams/${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${token || ''}` },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`streams ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------
// Final shape returned to the player.
// ---------------------------------------------------
export async function getProxyPlayback(videoId, token, opts = {}) {
  const maxHeight = opts.maxHeight || 720;          // keep the same UI cap
  try {
    const data = await fetchStreams(videoId, token);
    const muxed = (data.formats || []).filter((f) => f && f.hasVideo && f.hasAudio);
    const withinCap = muxed.filter((f) => !f.height || f.height <= maxHeight);
    const pick = withinCap[0] || muxed.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const itag = pick && pick.itag != null ? pick.itag : 'best';
    return {
      videoId,
      videoUrl: mediaProxyUrl(videoId, token, itag),
      height: (pick && pick.height) || 0,
      itag,
    };
  } catch (e) {
    // Never throw – hand back a usable URL so the player never gets stuck.
    return {
      videoId,
      videoUrl: mediaProxyUrl(videoId, token, 'best'),
      height: 0,
      itag: 'best',
    };
  }
}