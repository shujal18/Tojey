import AsyncStorage from '@react-native-async-storage/async-storage';

// Stable per-install device id (survives user switches, dies with app data). Lets the
// server keep presence/app-state reports per device (no push tokens are used anymore).
const DEVICE_ID_KEY = '@tojey_device_id';
const DEVICE_SEQ_KEY = '@tojey_device_seq';
let cachedDeviceId = null;
export async function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      await AsyncStorage.setItem(DEVICE_ID_KEY, id);
    }
    cachedDeviceId = id;
    return id;
  } catch (e) {
    return 'unknown';
  }
}

// Monotonic per-device sequence for app-state reports, persisted across app restarts so
// a stale event emitted by a previous process can never overwrite a newer foreground
// report on the server (out-of-order guard).
export async function nextDeviceSeq() {
  try {
    const raw = await AsyncStorage.getItem(DEVICE_SEQ_KEY);
    const next = (raw ? parseInt(raw, 10) : 0) + 1;
    await AsyncStorage.setItem(DEVICE_SEQ_KEY, String(next));
    return next;
  } catch (e) {
    return Date.now();
  }
}