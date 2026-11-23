import { NativeModules, Platform } from 'react-native';

const Native = (() => {
  try {
    return Platform.OS === 'android' ? NativeModules.TojeyMedia || null : null;
  } catch (e) {
    return null;
  }
})();

export async function getVideoThumbnail(uri) {
  if (!Native || typeof Native.getVideoThumbnail !== 'function' || !uri) return null;
  try {
    const result = await Native.getVideoThumbnail(String(uri));
    if (!result || !result.uri) return null;
    return {
      uri: result.uri,
      width: Number(result.width) || 0,
      height: Number(result.height) || 0,
      durationMs: Number(result.durationMs) || 0,
    };
  } catch (e) {
    return null;
  }
}

export function formatVideoDurationLabel(durationMs) {
  const total = Math.max(0, Math.floor((Number(durationMs) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default getVideoThumbnail;
