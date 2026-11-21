import { NativeModules, Platform } from 'react-native';
import { clamp } from '../components/video/videoConfig';

const Native = NativeModules.TojeyBrightness;

export function brightnessSupported() {
  return Platform.OS === 'android' && !!Native;
}

export async function setWindowBrightness(value) {
  if (!brightnessSupported()) return false;
  try {
    await Native.setBrightness(clamp(value, 0.01, 1));
    return true;
  } catch (e) {
    return false;
  }
}

export async function resetWindowBrightness() {
  if (!brightnessSupported()) return false;
  try {
    await Native.resetBrightness();
    return true;
  } catch (e) {
    return false;
  }
}
