// LibreTube-style YouTube API client - talks to the backend innertube layer
// (/api/yt/*). Stream URL resolution stays device-side (see innertube.js).
import { SERVER_URL } from '../config';

export default function makeYoutubeApi(token) {
  const headers = { Authorization: `Bearer ${token}` };

  async function get(path) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const res = await fetch(`${SERVER_URL}${path}`, { headers, signal: ac.signal });
      if (!res.ok) throw new Error(`api ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function search(query, filter, nextToken) {
    const q = [];
    if (query) q.push(`q=${encodeURIComponent(query)}`);
    if (filter && filter !== 'all') q.push(`filter=${encodeURIComponent(filter)}`);
    if (nextToken) q.push(`token=${encodeURIComponent(nextToken)}`);
    return get(`/api/yt/search${q.length ? `?${q.join('&')}` : ''}`);
  }

  async function suggestions(query) {
    const res = await get(`/api/yt/suggestions?q=${encodeURIComponent(query)}`);
    return res.suggestions || [];
  }

  function channel(channelId, tab, nextToken) {
    const q = [];
    if (tab && tab !== 'videos') q.push(`tab=${encodeURIComponent(tab)}`);
    if (nextToken) q.push(`token=${encodeURIComponent(nextToken)}`);
    return get(`/api/yt/channel/${encodeURIComponent(channelId)}${q.length ? `?${q.join('&')}` : ''}`);
  }

  function playlist(playlistId, nextToken) {
    const q = nextToken ? `?token=${encodeURIComponent(nextToken)}` : '';
    return get(`/api/yt/playlist/${playlistId}${q}`);
  }

  function video(videoId) {
    return get(`/api/yt/video/${videoId}`);
  }

  function related(videoId, nextToken) {
    return get(`/api/yt/related/${videoId}?token=${encodeURIComponent(nextToken)}`);
  }

  return { search, suggestions, channel, playlist, video, related };
}