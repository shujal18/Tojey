import { NativeModules, Platform } from 'react-native';

const Native = NativeModules.TojeyOrientation;

export function orientationSupported() {
  return Platform.OS === 'android' && !!Native;
}

export async function lockOrientation(kind) {
  if (!orientationSupported()) return false;
  try {
    return !!(await Native.lock(kind));
  } catch (e) {
    return false;
  }
}

export async function unlockOrientation() {
  if (!orientationSupported()) return false;
  try {
    return !!(await Native.unlock());
  } catch (e) {
    return false;
  }
}
