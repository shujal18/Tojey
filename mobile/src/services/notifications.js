import { Platform, PermissionsAndroid } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, AndroidVisibility, EventType } from '@notifee/react-native';
import { SERVER_URL } from '../config';
import { loadSession } from './auth';

export const NOTIFICATION_CHANNEL_ID = 'tojey-messages';
export const NOTIFEE_PRESS_ACTION = 'open-chat';

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

async function ensureNotifeeChannel() {
  try {
    const existing = await notifee.getChannel(NOTIFICATION_CHANNEL_ID);
    if (!existing) {
      await notifee.createChannel({
        id: NOTIFICATION_CHANNEL_ID,
        name: 'Chat notifications',
        importance: AndroidImportance.HIGH,
        sound: 'default',
        vibration: true,
        visibility: AndroidVisibility.PUBLIC,
      });
    }
  } catch (e) {
    console.warn('ensureNotifeeChannel failed:', e.message);
  }
}

/**
 * Post a real Android system notification (heads-up pop-up, sound, vibration),
 * like WhatsApp/Messenger. This works even while the app is in the foreground
 * and does not depend on Google Play services / push delivery, so it also covers
 * the OPPO/ColorOS case where remote FCM banners are suppressed.
 */
export async function showSystemNotification(payload) {
  if (!payload || Platform.OS !== 'android') return;
  try {
    await ensureNotifeeChannel();
    await notifee.displayNotification({
      id: payload.notificationId ? `tojey-n-${payload.notificationId}` : undefined,
      title: payload.title || payload.senderName || 'Tojey',
      body: payload.message || '',
      data: {
        type: 'tojey_notification',
        senderId: payload.senderId != null ? String(payload.senderId) : undefined,
        receiverId: payload.receiverId != null ? String(payload.receiverId) : undefined,
        conversationId: payload.conversationId != null ? String(payload.conversationId) : undefined,
      },
      android: {
        channelId: NOTIFICATION_CHANNEL_ID,
        smallIcon: 'ic_stat_tojey',
        color: '#6C3CE9',
        importance: AndroidImportance.HIGH,
        visibility: AndroidVisibility.PUBLIC,
        pressAction: { id: NOTIFEE_PRESS_ACTION },
      },
    });
  } catch (e) {
    console.warn('showSystemNotification failed:', e.message);
  }
}

/** Called when the user taps a system notification while the app is in the foreground. */
export function onSystemNotificationPressed(cb) {
  let unsub = null;
  try {
    unsub = notifee.onForegroundEvent(({ type, detail }) => {
      if (type !== EventType.PRESS) return;
      const pressId = detail.pressAction && detail.pressAction.id;
      if (pressId !== NOTIFEE_PRESS_ACTION) return;
      const n = detail.notification;
      const d = (n && n.data) || {};
      if (!d.senderId) return;
      cb({
        senderId: parseInt(d.senderId, 10) || undefined,
        receiverId: d.receiverId ? parseInt(d.receiverId, 10) : undefined,
        conversationId: d.conversationId ? parseInt(d.conversationId, 10) : undefined,
        title: n.title || '',
        message: n.body || '',
      });
    });
  } catch (e) {
    console.warn('onSystemNotificationPressed failed:', e.message);
  }
  return () => {
    try {
      if (unsub) unsub();
    } catch (e) {}
  };
}

/** Resolve the system notification that launched the app (cold start/background tap). */
export async function checkInitialSystemNotification() {
  if (Platform.OS !== 'android') return null;
  try {
    const initial = await notifee.getInitialNotification();
    const n = initial && initial.notification;
    const d = (n && n.data) || {};
    if (!d || !d.senderId) return null;
    return {
      senderId: parseInt(d.senderId, 10) || undefined,
      receiverId: d.receiverId ? parseInt(d.receiverId, 10) : undefined,
      conversationId: d.conversationId ? parseInt(d.conversationId, 10) : undefined,
      title: n.title || '',
      message: n.body || '',
    };
  } catch (e) {
    return null;
  }
}

async function requestNotificationPermission() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 33) {
    try {
      const already = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (already) return true;
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      if (granted === PermissionsAndroid.RESULTS.GRANTED) return true;
      console.warn('POST_NOTIFICATIONS not granted:', granted);
      return false;
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
    await ensureNotifeeChannel();
    const hasPerm = await requestNotificationPermission();
    try {
      await notifee.requestPermission();
    } catch (e) {
      console.warn('notifee requestPermission failed:', e.message);
    }

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
    if (!hasPerm) {
      console.warn('Push enabled but POST_NOTIFICATIONS denied - banners will not show on Android 13+.');
    }
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

/**
 * Deactivate this device's FCM token on the backend (logout). Uses the calling
 * user's session; the server only deactivates tokens that belong to that user.
 */
export async function deactivateToken() {
  if (Platform.OS !== 'android') return;
  let token = null;
  try {
    token = await messaging().getToken();
  } catch (e) {
    console.warn('deactivateToken: could not read token:', e.message);
    return;
  }
  if (!token) return;
  try {
    const s = await loadSession();
    if (!s || !s.token) return;
    const res = await fetch(`${SERVER_URL}/api/devices/token/deactivate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.token}`,
      },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) console.warn('deactivateToken server error', res.status);
  } catch (e) {
    console.warn('deactivateToken failed:', e.message);
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
  try {
    notifee.onBackgroundEvent(async () => {});
  } catch (e) {
    console.warn('Notifee background handler unavailable:', e.message);
  }
}