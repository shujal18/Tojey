// LibreTube-style YouTube API client - talks to the backend innertube layer
// (/api/yt/*). Stream URL resolution stays device-side (see innertube.js).
import { SERVER_URL } from '../config';

export default function makeYoutubeApi(token) {
  const headers = { Authorization: `Bearer ${token}` };

  async function get(path) {
    const res = await fetch(`${SERVER_URL}${path}`, { headers });
    if (!res.ok) throw new Error(`api ${res.status}`);
    return res.json();
  }

  async function search(query, filter, nextToken) {
    const q = new URLSearchParams();
    if (query) q.set('q', query);
    if (filter && filter !== 'all') q.set('filter', filter);
    if (nextToken) q.set('token', nextToken);
    return get(`/api/yt/search?${q.toString()}`);
  }

  async function suggestions(query) {
    const res = await get(`/api/yt/suggestions?q=${encodeURIComponent(query)}`);
    return res.suggestions || [];
  }

  function channel(channelId, tab, nextToken) {
    const q = new URLSearchParams();
    if (tab && tab !== 'videos') q.set('tab', tab);
    if (nextToken) q.set('token', nextToken);
    return get(`/api/yt/channel/${channelId}${q.toString() ? `?${q.toString()}` : ''}`);
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