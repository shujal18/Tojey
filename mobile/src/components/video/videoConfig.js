import { Vibration } from 'react-native';

export const VIDEO_ACCENT = '#3D9BFF';
export const VIDEO_SURFACE = '#050A14';

export const CONTROL_SHOW_MS = 150;
export const CONTROL_HIDE_MS = 220;
export const SHEET_OPEN_MS = 250;

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

export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m).padStart(2, '0');
  return h
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`;
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

export function seekWindowFor(duration) {
  const total = Number(duration) || 0;
  if (total <= 0) return 30;
  return clamp(total * 0.15, 20, Math.max(120, total * 0.5));
}

export function tickHaptic() {
  try {
    Vibration.vibrate(8);
  } catch (e) {}
}

export function selectedOrFirst(options, value, fallback) {
  return options.includes(value) ? value : fallback;
}
