import { NativeModules, Platform } from 'react-native';

const Native = NativeModules.TojeyRemoteControl;

export async function isRemoteControlEnabled() {
  if (Platform.OS !== 'android' || !Native || typeof Native.isEnabled !== 'function') return false;
  try {
    return !!(await Native.isEnabled());
  } catch (e) {
    return false;
  }
}

export function openRemoteControlSettings() {
  if (Platform.OS !== 'android' || !Native || typeof Native.openSettings !== 'function') return;
  try {
    Native.openSettings();
  } catch (e) {}
}

export async function dispatchRemoteTap(x, y) {
  if (Platform.OS !== 'android' || !Native || typeof Native.tap !== 'function') return false;
  try {
    return !!(await Native.tap(x, y));
  } catch (e) {
    return false;
  }
}

export async function dispatchRemoteSwipe(x1, y1, x2, y2, duration) {
  if (Platform.OS !== 'android' || !Native || typeof Native.swipe !== 'function') return false;
  try {
    return !!(await Native.swipe(x1, y1, x2, y2, duration || 260));
  } catch (e) {
    return false;
  }
}
