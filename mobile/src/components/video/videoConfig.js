export const VIDEO_ACCENT = '#8B5CF6';
export const VIDEO_SURFACE = '#07040E';

export const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const QUALITY_OPTIONS = ['Auto', '1080p', '720p', '480p', '360p'];
export const RESIZE_OPTIONS = ['Fit', 'Fill', 'Crop', 'Original', '16:9', '4:3'];

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function resizeModeFor(mode) {
  if (mode === 'Fill' || mode === 'Crop') return 'cover';
  return 'contain';
}

export function aspectForResize(mode) {
  if (mode === '16:9') return 16 / 9;
  if (mode === '4:3') return 4 / 3;
  return undefined;
}

export function selectedOrFirst(options, value, fallback) {
  return options.includes(value) ? value : fallback;
}
