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
import { SERVER_URL } from '../config';

export function mediaProxyUrl(videoId, token, itag = 'best') {
  const t = encodeURIComponent(token || '');
  return `${SERVER_URL}/api/yt/media/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(itag)}&token=${t}`;
}

async function fetchStreams(videoId, token) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
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

// Returns { videoId, videoUrl, audioUrl, height, itag }. `videoUrl` is always a
// playable muxed progressive source; `audioUrl` (optional) is the best
// audio-only track for the audio-only mode. Never throws — on metadata failure
// it still hands back the generic `itag=best` proxy URL so playback can try.
export async function getProxyPlayback(videoId, token, opts = {}) {
  const maxHeight = opts.maxHeight || 720;
  try {
    const data = await fetchStreams(videoId, token);
    const muxed = (data.formats || []).filter((f) => f && f.hasVideo && f.hasAudio);
    const withinCap = muxed
      .filter((f) => !f.height || f.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const pick = withinCap[0] || muxed.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    const itag = pick && pick.itag != null ? pick.itag : 'best';
    const audio = data.defaultAudio;
    return {
      videoId,
      videoUrl: mediaProxyUrl(videoId, token, itag),
      audioUrl: audio && audio.itag != null ? mediaProxyUrl(videoId, token, audio.itag) : null,
      height: (pick && pick.height) || 0,
      itag,
    };
  } catch (e) {
    return {
      videoId,
      videoUrl: mediaProxyUrl(videoId, token, 'best'),
      audioUrl: null,
      height: 0,
      itag: 'best',
    };
  }
}
