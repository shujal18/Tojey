import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

const Native = (() => {
  try {
    return NativeModules.TojeyPip || null;
  } catch (e) {
    return null;
  }
})();

export async function pipSupported() {
  if (Platform.OS !== 'android' || !Native) return false;
  try {
    return !!(await Native.isSupported());
  } catch (e) {
    return false;
  }
}

export async function enterPip(width = 16, height = 9, playing = true) {
  if (Platform.OS !== 'android' || !Native) return false;
  try {
    return !!(await Native.enterPip(width, height, !!playing));
  } catch (e) {
    return false;
  }
}

export function onPipAction(handler) {
  if (Platform.OS !== 'android' || typeof handler !== 'function') return () => {};
  const subscription = DeviceEventEmitter.addListener('TojeyPipAction', handler);
  return () => subscription.remove();
}
