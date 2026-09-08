const UNSAFE_VIDEO_RE = /\.(mov|mkv|webm|avi|flv|3gp|3gpp|ts|mpg|mpeg|hevc|ogv|wmv)$/;
const SAFE_VIDEO_RE = /\.(mp4|m4v|m3u8)$/;

// ExoPlayer decodes just a few codecs in-app (mainly MP4/H.264/AAC). Container or
// codec mismatches (MOV, MKV, WEBM, HEVC…) throw a native error that no JS boundary
// can catch, crashing the app. Only allow known-safe formats to run in-app; the rest
// are handed to the system video player or skipped entirely.
export function canInlineVideoPreview(fileName, mime) {
  const name = String(fileName || '').toLowerCase();
  if (SAFE_VIDEO_RE.test(name)) return true;
  if (UNSAFE_VIDEO_RE.test(name)) return false;
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/')) return m === 'video/mp4' || m === 'video/mpeg';
  return true;
}