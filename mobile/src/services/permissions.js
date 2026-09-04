import { Platform } from 'react-native';
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions';

const media = (Platform.OS === 'android'
  ? (Platform.Version >= 33 ? PERMISSIONS.ANDROID.READ_MEDIA_IMAGES : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE)
  : PERMISSIONS.IOS.PHOTO_LIBRARY);
const camera = (Platform.OS === 'android' ? PERMISSIONS.ANDROID.CAMERA : PERMISSIONS.IOS.CAMERA);
const mic = (Platform.OS === 'android' ? PERMISSIONS.ANDROID.RECORD_AUDIO : PERMISSIONS.IOS.MICROPHONE);

export async function ensureMediaPermission() {
  if (Platform.OS === 'web') return true;
  const r = await check(media);
  if (r === RESULTS.GRANTED) return true;
  const req = await request(media);
  return req === RESULTS.GRANTED || req === RESULTS.LIMITED;
}

export async function ensureCameraPermission() {
  if (Platform.OS === 'web') return true;
  const r = await check(camera);
  if (r === RESULTS.GRANTED) return true;
  const req = await request(camera);
  return req === RESULTS.GRANTED;
}

export async function ensureMicPermission() {
  if (Platform.OS === 'web') return true;
  const r = await check(mic);
  if (r === RESULTS.GRANTED) return true;
  const req = await request(mic);
  return req === RESULTS.GRANTED;
}
