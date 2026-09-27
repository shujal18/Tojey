import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const Mod = NativeModules.TojeyKeepAlive;
const KEEP_ALIVE_KEY = '@tojey_keepalive_enabled';

export function supportsKeepAlive() {
  return !!Mod;
}

export async function getKeepAliveEnabled() {
  try {
    const raw = await AsyncStorage.getItem(KEEP_ALIVE_KEY);
    if (raw !== null) return raw === 'true';
  } catch (e) {}
  return true;
}

export async function setKeepAliveEnabled(enabled) {
  try {
    await AsyncStorage.setItem(KEEP_ALIVE_KEY, enabled ? 'true' : 'false');
  } catch (e) {}
}

export function startKeepAlive() {
  try {
    if (Mod && Mod.start) Mod.start();
  } catch (e) {}
}

export function stopKeepAlive() {
  try {
    if (Mod && Mod.stop) Mod.stop();
  } catch (e) {}
}

export async function isKeepAliveRunning() {
  try {
    if (Mod && Mod.isRunning) return !!(await Mod.isRunning());
  } catch (e) {}
  return false;
}

// True only when every precondition for socket-based background delivery holds:
// the feature is on (persisted pref) AND the native foreground service is live.
export async function isKeepAliveActive() {
  try {
    if (!supportsKeepAlive()) return false;
    if (!(await getKeepAliveEnabled())) return false;
    return await isKeepAliveRunning();
  } catch (e) {
    return false;
  }
}