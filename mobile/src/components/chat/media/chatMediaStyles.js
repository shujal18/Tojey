import { StyleSheet } from 'react-native';
import { absUrl } from '../../../config';
import { fs, WIN_H, WIN_W } from '../../../utils/size';

export const MEDIA_COLORS = {
  overlay: 'rgba(0,0,0,0.58)',
  overlayStrong: 'rgba(0,0,0,0.76)',
  overlaySoft: 'rgba(0,0,0,0.3)',
  white: '#FFFFFF',
  whiteMuted: 'rgba(255,255,255,0.76)',
  accent: '#3D9BFF',
  border: 'rgba(255,255,255,0.14)',
  placeholder: '#15171C',
};

export const FADE_DURATION = 180;

export const BOTTOM_SHADE_LAYERS = [
  { height: fs(56), color: 'rgba(0,0,0,0.08)' },
  { height: fs(34), color: 'rgba(0,0,0,0.15)' },
  { height: fs(18), color: 'rgba(0,0,0,0.24)' },
];

export const styles = StyleSheet.create({
  bubble: {
    borderRadius: fs(12),
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: MEDIA_COLORS.placeholder,
    justifyContent: 'center',
    alignItems: 'center',
  },
  absoluteFill: StyleSheet.absoluteFillObject,
  fillImage: { width: '100%', height: '100%' },
  bottomShadeLayer: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  metaRow: {
    position: 'absolute',
    left: fs(8),
    right: fs(8),
    bottom: fs(7),
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  metaRowRight: {
    position: 'absolute',
    right: fs(8),
    bottom: fs(7),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: fs(10),
    paddingHorizontal: fs(6),
    paddingVertical: fs(2),
    backgroundColor: MEDIA_COLORS.overlaySoft,
  },
  metaText: {
    color: MEDIA_COLORS.white,
    fontSize: fs(11),
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  metaTextMuted: {
    color: MEDIA_COLORS.whiteMuted,
    fontSize: fs(10),
    fontWeight: '500',
  },
  metaSpacer: { marginRight: fs(4) },
  receipt: { marginLeft: fs(4) },
  centerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: fs(18),
    paddingHorizontal: fs(12),
    paddingVertical: fs(8),
    backgroundColor: MEDIA_COLORS.overlay,
  },
  loadingText: {
    color: MEDIA_COLORS.white,
    fontSize: fs(11),
    fontWeight: '600',
    marginLeft: fs(7),
  },
  retryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: fs(18),
    paddingHorizontal: fs(12),
    paddingVertical: fs(8),
    backgroundColor: MEDIA_COLORS.overlayStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: MEDIA_COLORS.border,
  },
  retryText: {
    color: MEDIA_COLORS.white,
    fontSize: fs(11),
    fontWeight: '700',
    marginLeft: fs(6),
  },
  uploadPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: fs(18),
    paddingHorizontal: fs(10),
    paddingVertical: fs(8),
    backgroundColor: MEDIA_COLORS.overlayStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: MEDIA_COLORS.border,
  },
  progressTrack: {
    width: fs(64),
    height: fs(4),
    borderRadius: fs(2),
    backgroundColor: 'rgba(255,255,255,0.24)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: fs(2), backgroundColor: MEDIA_COLORS.accent },
  progressText: {
    color: MEDIA_COLORS.white,
    fontSize: fs(10),
    fontWeight: '700',
    marginLeft: fs(8),
    minWidth: fs(30),
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  cancelButton: {
    width: fs(22),
    height: fs(22),
    borderRadius: fs(11),
    marginLeft: fs(8),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  playButton: {
    width: fs(52),
    height: fs(52),
    borderRadius: fs(26),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.52)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.42)',
  },
  playTriangle: { marginLeft: fs(2) },
  fallbackIcon: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  durationGroup: { flexDirection: 'row', alignItems: 'center', marginRight: fs(6) },
  durationIcon: { marginRight: fs(4) },
});

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function normalizeProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
}

export function progressPercent(value) {
  return Math.round(normalizeProgress(value) * 100);
}

export function resolveMediaSize({
  width,
  height,
  aspect,
  maxWidthRatio = 0.8,
  maxHeightRatio = 0.52,
  fallbackAspect = 16 / 9,
} = {}) {
  const maxW = Math.max(fs(120), WIN_W * maxWidthRatio);
  const maxH = Math.max(fs(120), WIN_H * maxHeightRatio);
  const w = positive(width);
  const h = positive(height);
  const ratio = positive(aspect) || positive(fallbackAspect) || 16 / 9;

  if (w > 0 && h > 0) {
    const fixedScale = Math.min(1, maxW / w, maxH / h);
    return { width: Math.round(w * fixedScale), height: Math.round(h * fixedScale) };
  }

  let outW = w;
  let outH = h;
  if (outW > 0) outH = outW / ratio;
  else if (outH > 0) outW = outH * ratio;
  else {
    outW = maxW;
    outH = outW / ratio;
  }

  const scale = Math.min(1, maxW / outW, maxH / outH);
  return { width: Math.round(outW * scale), height: Math.round(outH * scale) };
}

export function isImageUri(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const source = value.trim();
  if (/^data:image\//i.test(source)) return true;
  const path = source.split(/[?#]/)[0];
  if (/^content:\/\//i.test(path)) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(path);
}

export function mediaSource(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  return { uri: absUrl(String(value)) };
}

export function resolveImageBackground(thumbnailUri, uri) {
  const source = thumbnailUri || uri;
  return source ? mediaSource(source) : null;
}

export function resolveVideoThumbnail(thumbnailUri, uri) {
  if (!isImageUri(thumbnailUri)) return null;
  const thumb = String(thumbnailUri);
  const full = uri ? String(uri) : '';
  if (full && (thumb === full || absUrl(thumb) === absUrl(full))) return null;
  return mediaSource(thumb);
}

export function receiptVisual(receipt) {
  const value = receipt || {};
  return {
    name: value.icon || (value.read ? 'checkmark-done' : 'checkmark'),
    color: value.color || (value.read ? MEDIA_COLORS.accent : MEDIA_COLORS.whiteMuted),
    size: value.read ? fs(15) : fs(13),
  };
}

export function mediaAccessibilityLabel(kind, { durationLabel, timeLabel, edited, error } = {}) {
  const parts = [kind === 'video' ? 'Video message' : 'Image message'];
  if (durationLabel) parts.push(durationLabel);
  if (timeLabel) parts.push(timeLabel);
  if (edited) parts.push('edited');
  if (error) parts.push('failed to load');
  return parts.join(', ');
}

export function stopTouchPropagation(event) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
}
