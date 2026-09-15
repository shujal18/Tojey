import { Platform, PermissionsAndroid, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, AndroidVisibility, AndroidCategory, EventType } from '@notifee/react-native';
import { SERVER_URL } from '../config';
import { loadSession } from './auth';
import { showChatHead, getChatHeadEnabled, canDrawOverlay, getNudgeVibrationEnabled } from './chatHead';

export const NOTIFICATION_CHANNEL_ID = 'tojey-messages';
export const NOTIFEE_PRESS_ACTION = 'open-chat';

// Show the floating chat head (and vibrate for nudges) from a background/headless
// FCM data message - this is what lets chat / nudge work on devices whose process
// is killed while the app is backgrounded (socket-only delivery would be lost).
const ChatHeadMod = NativeModules.TojeyChatHead;
async function handleBackgroundChatOrNudge(d) {
  const type = d && d.type;
  const isChat = type === 'tojey_chat';
  const isNudge = type === 'tojey_nudge' || (d && d.nudge === '1');
  if (!isChat && !isNudge) return false;
  try {
    if (isNudge) {
      const nudgVib = await getNudgeVibrationEnabled().catch(() => true);
      if (nudgVib && ChatHeadMod && ChatHeadMod.vibrate) {
        try { ChatHeadMod.vibrate('0,450,150,450,150,450,150,450,150,450'); } catch (e) {}
      }
    }
    const [chatHeadEnabled, over] = await Promise.all([
      getChatHeadEnabled().catch(() => true),
      canDrawOverlay().catch(() => false),
    ]);
    if (chatHeadEnabled && over) {
      showChatHead(d.senderPic || '💬', d.senderName || d.senderUsername || 'Tojey', 1);
    }
  } catch (e) {
    // best effort
  }
  return true;
}

// Never log full FCM tokens (they are bearer credentials).
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 12) return '***';
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

let tokenUnsub = null;

// Stable per-install device id (survives user switches, dies with app data). Lets the
// backend replace the OLD token of THIS device when Firebase rotates the token, instead
// of leaving the superseded token active.
const DEVICE_ID_KEY = '@tojey_device_id';
let cachedDeviceId = null;
async function getDeviceId() {
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
    title: d.title || (remoteMessage.notification && remoteMessage.notification.title) || '',
  };
}

async function ensureNotifeeChannel() {
  try {
    let existing = null;
    try {
      existing = await notifee.getChannel(NOTIFICATION_CHANNEL_ID);
    } catch (e) {}
    if (!existing) {
      await notifee.createChannel({
        id: NOTIFICATION_CHANNEL_ID,
        name: 'Chat notifications',
        importance: AndroidImportance.HIGH,
        sound: 'default',
        vibration: true,
        visibility: AndroidVisibility.PUBLIC,
      });
      existing = await notifee.getChannel(NOTIFICATION_CHANNEL_ID);
      console.log(`[FCM] channel '${NOTIFICATION_CHANNEL_ID}' created (importance=${existing && existing.importance}, vibration=${existing && existing.vibration})`);
    } else {
      console.log(`[FCM] channel '${NOTIFICATION_CHANNEL_ID}' already exists (importance=${existing.importance})`);
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
        category: AndroidCategory.MESSAGE,
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

// Fresh token guaranteed: getToken() always reflects Firebase's CURRENT token, never
// a cached/stale one. If Firebase rotated the token (reinstall, expiry, cleared app
// data) this is where we learn about it.
function currentToken() {
  return messaging().getToken();
}

async function registerToken(token, userToken) {
  const body = JSON.stringify({ token, platform: 'android', deviceId: await getDeviceId() });
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/devices/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body,
    });
  } catch (e) {
    console.warn(`[FCM] backend token registration network failed (${maskToken(token)}):`, e.message);
    return false;
  }
  let json = null;
  try { json = await res.json(); } catch (e) {}
  console.log(`[FCM] backend token registration response: status=${res.status} ok=${json && json.ok} (${maskToken(token)})`);
  if (!res.ok || !json || !json.ok) {
    console.warn('[FCM] token registration rejected by backend:', res.status, json && json.error);
    return false;
  }
  return true;
}

/**
 * Request permission, create the channel and register the push token with the backend.
 * Also wires token refresh. Returns true when FCM is usable.
 * Idempotent: safe to call on every login and every app boot with the CURRENT user's
 * JWT, so an account switch (logout -> login) re-binds this device token to the new
 * user instead of leaving it active under the old one.
 */
export async function startPush(userToken) {
  if (Platform.OS !== 'android') return false;
  try {
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

    const token = await currentToken();
    console.log(`[FCM] getToken succeeded: ${maskToken(token)}`);
    if (!token) {
      console.warn('[FCM] getToken returned empty - Firebase messaging not ready');
      return false;
    }
    const registered = await registerToken(token, userToken);
    if (registered) {
      console.log(`[FCM] token registered with backend: ${maskToken(token)}`);
    } else {
      console.warn(`[FCM] token NOT registered with backend: ${maskToken(token)}`);
    }
    console.log(`[FCM] POST_NOTIFICATIONS ${hasPerm ? 'GRANTED' : 'DENIED'} on Android ${Platform.Version}`);

    // Refresh tokens as soon as Firebase issues them, ALWAYS for the currently logged
    // in user (userToken is captured for this startPush call, so an account switch
    // followed by startPush(userToken') re-registers under the right identity).
    tokenUnsub = messaging().onTokenRefresh(async (t) => {
      console.log(`[FCM] token refresh detected: ${maskToken(t)}`);
      const ok = await registerToken(t, userToken);
      console.log(`[FCM] refreshed token ${ok ? 'registered' : 'registration FAILED'}: ${maskToken(t)}`);
    });
    if (!hasPerm) {
      console.warn('[FCM] POST_NOTIFICATIONS denied on Android 13+ - banners/sound will NOT show. Ask the user to enable notifications in App Settings.');
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
      body: JSON.stringify({ token, deviceId: await getDeviceId() }),
    });
    console.log(`[FCM] deactivate at logout: status=${res.status} (${maskToken(token)})`);
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
      if (payload) {
        console.log(`[FCM] foreground message received: conversationId=${payload.conversationId} sender=${payload.senderName}`);
        cb(payload);
      }
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
      .then((m) => {
        const p = extractNotifPayload(m);
        if (p) console.log(`[FCM] cold-start opened by notification: conversationId=${p.conversationId}`);
        return p;
      });
  } catch (e) {
    return Promise.resolve(null);
  }
}

/** Called when the user taps a notification while the app is running/backgrounded. */
export function onNotificationOpened(cb) {
  try {
    return messaging().onNotificationOpenedApp((remoteMessage) => {
      const payload = extractNotifPayload(remoteMessage);
      if (payload) {
        console.log(`[FCM] notification opened while running: conversationId=${payload.conversationId}`);
        cb(payload);
      }
    });
  } catch (e) {
    return () => {};
  }
}

/**
 * Android background/headless handler. Our pushes carry a real `notification` payload,
 * so Android's FCM client renders the tray notification by itself when the app is
 * backgrounded/terminated, and this JS hook is intentionally NOT invoked for those.
 * It only fires for purely data-only messages, which we render with Notifee. Must be
 * registered at module scope (see index.js).
 */
export function registerBackgroundHandler() {
  try {
    messaging().setBackgroundMessageHandler(async (remoteMessage) => {
      // If the message already carries a `notification` payload, Android already
      // rendered it in the tray - creating another clone here would duplicate it.
      if (remoteMessage && remoteMessage.notification) {
        console.log(`[FCM] background (system-rendered notification, no JS render) type=${remoteMessage.data && remoteMessage.data.type}`);
        return;
      }
      try {
        const payload = extractNotifPayload(remoteMessage);
        if (payload) {
          console.log(`[FCM] background data-only render conversationId=${payload.conversationId}`);
          await showSystemNotification(payload);
        } else if (remoteMessage && remoteMessage.data) {
          const d = remoteMessage.data;
          if (await handleBackgroundChatOrNudge(d)) {
            console.log(`[FCM] background data-only ${d.type || 'nudge'} -> chat head/nudge handled`);
          } else {
            console.log('[FCM] background data-only render (generic)');
            await showSystemNotification({ title: d.title || 'Tojey', message: d.body || '' });
          }
        }
      } catch (e) {
        console.warn('background render failed:', e.message);
      }
    });
  } catch (e) {
    console.warn('Background message handler unavailable:', e.message);
  }
  try {
    notifee.onBackgroundEvent(async () => {});
  } catch (e) {
    console.warn('Notifee background handler unavailable:', e.message);
  }
}