import { Platform, PermissionsAndroid } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import { SERVER_URL } from '../config';

export const NOTIFICATION_CHANNEL_ID = 'tojey-messages';

let tokenUnsub = null;

/**
 * Extract our notification payload from a RemoteMessage.
 * Returns null for anything that is not a Tojey notification.
 */
export function extractNotifPayload(remoteMessage) {
  if (!remoteMessage) return null;
  const d = (remoteMessage.data && typeof remoteMessage.data === 'object') ? remoteMessage.data : {};
  if (d.type !== 'tojey_notification') return null;
  const num = (v) => (/^[1-9]\d*$/.test(String(v)) ? parseInt(v, 10) : null);
  return {
    notificationId: num(d.notificationId || d.id),
    senderId: num(d.senderId),
    senderUsername: d.senderUsername,
    senderName: d.senderName,
    receiverId: num(d.receiverId),
    conversationId: num(d.conversationId),
    message: d.body || (remoteMessage.notification && remoteMessage.notification.body) || '',
    title: (remoteMessage.notification && remoteMessage.notification.title) || '',
  };
}

async function createNotificationChannel() {
  try {
    await messaging().android.createChannel({
      id: NOTIFICATION_CHANNEL_ID,
      name: 'Chat notifications',
      importance: 4, // IMPORTANCE_HIGH
      sound: 'default',
      vibration: true,
    });
  } catch (e) {
    console.warn('createNotificationChannel failed:', e.message);
  }
}

async function requestNotificationPermission() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 33) {
    try {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch (e) {
      console.warn('POST_NOTIFICATIONS request failed:', e.message);
      return false;
    }
  }
  return true;
}

async function registerToken(token, userToken) {
  try {
    const res = await fetch(`${SERVER_URL}/api/devices/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ token, platform: 'android' }),
    });
    if (!res.ok) {
      console.warn('registerToken server error', res.status);
    }
  } catch (e) {
    console.warn('registerToken network failed:', e.message);
  }
}

/**
 * Request permission, create the channel and register the push token with the backend.
 * Also wires token refresh. Returns true when FCM is usable.
 */
export async function startPush(userToken) {
  if (Platform.OS !== 'android') return false;
  try {
    await createNotificationChannel();
    await requestNotificationPermission();

    if (tokenUnsub) {
      tokenUnsub();
      tokenUnsub = null;
    }

    const token = await messaging().getToken();
    await registerToken(token, userToken);

    // Refresh tokens as soon as Firebase issues them.
    tokenUnsub = messaging().onTokenRefresh(async (t) => {
      await registerToken(t, userToken);
    });
    return true;
  } catch (e) {
    // Firebase not configured (no google-services.json) or FCM unavailable.
    console.warn('Push notifications unavailable:', e.message);
    return false;
  }
}

export function stopPush() {
  if (tokenUnsub) {
    tokenUnsub();
    tokenUnsub = null;
  }
}

/** Subscribe to foreground pushes. Returns an unsubscribe function. */
export function onForegroundMessage(cb) {
  try {
    return messaging().onMessage((remoteMessage) => {
      const payload = extractNotifPayload(remoteMessage);
      if (payload) cb(payload);
    });
  } catch (e) {
    return () => {};
  }
}

/** Resolve the notification that opened the app from a cold start, if any. */
export function checkInitialNotification() {
  try {
    return messaging()
      .getInitialNotification()
      .then((m) => extractNotifPayload(m));
  } catch (e) {
    return Promise.resolve(null);
  }
}

/** Called when the user taps a notification while the app is running/backgrounded. */
export function onNotificationOpened(cb) {
  try {
    return messaging().onNotificationOpenedApp((remoteMessage) => {
      const payload = extractNotifPayload(remoteMessage);
      if (payload) cb(payload);
    });
  } catch (e) {
    return () => {};
  }
}

/**
 * Android background/headless handler. Our pushes include a `notification` payload so the
 * system renders them automatically; this hook exists for future data-only messages.
 * Must be registered at module scope (see index.js).
 */
export function registerBackgroundHandler() {
  try {
    messaging().setBackgroundMessageHandler(async () => {});
  } catch (e) {
    console.warn('Background message handler unavailable:', e.message);
  }
}