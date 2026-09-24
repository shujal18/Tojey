import { NativeModules, Platform } from 'react-native';

const M = NativeModules.TojeyKeepAlive;

// Starts the low-visibility foreground service that keeps the app process alive in
// the background (WhatsApp-style), so FCM popups keep rendering after the user swipes
// the app away instead of letting OPPO/other OEMs force-stop it.
export function startKeepAlive() {
  if (Platform.OS !== 'android' || !M) return;
  try {
    M.start();
  } catch (e) {
    console.warn('keepalive start failed', e);
  }
}

export function stopKeepAlive() {
  if (Platform.OS !== 'android' || !M) return;
  try {
    M.stop();
  } catch (e) {
    console.warn('keepalive stop failed', e);
  }
}