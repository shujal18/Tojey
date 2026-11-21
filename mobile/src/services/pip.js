import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

const { TojeyPip } = NativeModules;

export async function pipSupported() {
  if (Platform.OS !== 'android' || !TojeyPip) return false;
  try {
    return !!(await TojeyPip.isSupported());
  } catch (e) {
    return false;
  }
}

export async function enterPip(width = 16, height = 9, playing = true) {
  if (Platform.OS !== 'android' || !TojeyPip) return false;
  try {
    return !!(await TojeyPip.enterPip(width, height, !!playing));
  } catch (e) {
    return false;
  }
}

export function onPipAction(handler) {
  if (Platform.OS !== 'android' || typeof handler !== 'function') return () => {};
  const subscription = DeviceEventEmitter.addListener('TojeyPipAction', handler);
  return () => subscription.remove();
}
