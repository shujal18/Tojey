import { NativeModules } from 'react-native';

const { TojeyPip } = NativeModules;

export async function pipSupported() {
  try {
    return !!(await TojeyPip.isSupported());
  } catch (e) {
    return false;
  }
}

export async function enterPip(width = 16, height = 9) {
  try {
    return !!(await TojeyPip.enterPip(width, height));
  } catch (e) {
    return false;
  }
}