import { Platform, PermissionsAndroid, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import messaging from '@react-native-firebase/messaging';
import notifee, { AndroidImportance, AndroidVisibility, AndroidCategory, EventType } from '@notifee/react-native';
import { SERVER_URL } from '../config';
import { loadSession } from './auth';
import { showChatHead, getChatHeadEnabled, canDrawOverlay, getNudgeVibrationEnabled } from './chatHead';

export const NOTIFICATION_CHANNEL_ID = 'tojey-messages';
export const NOTIFEE_PRESS_ACTION = 'open-chat';

const NOTIF_PREFS_KEY = '@tojey_notif_prefs';

/**
 * Per-user notification preferences. `enabled` gates ALL popups (in-app banner +
 * system notification); `sound` and `vibration` are informational toggles kept in
 * sync with the native high-importance channel. Defaults: everything on.
 */
const DEFAULT_NOTIF_PREFS = { enabled: true, sound: true, vibration: true };
export async function getNotifPrefs() {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_PREFS_KEY);
    if (raw) return { ...DEFAULT_NOTIF_PREFS, ...JSON.parse(raw) };
  } catch (e) {}
  return { ...DEFAULT_NOTIF_PREFS };
}
export async function setNotifPrefs(patch) {
  const next = { ...DEFAULT_NOTIF_PREFS, ...(await getNotifPrefs()), ...patch };
  try {
    await AsyncStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(next));
  } catch (e) {}
  return next;
}

// Show the floating chat head (and vibrate for nudges) from a background/headless
// FCM data message - this is what lets chat / nudge work on devices whose process
// is killed while the app is backgrounded (socket-only delivery would be lost).
const ChatHeadMod = NativeModules.TojeyChatHead;
async function handleBackgroundChatOrNudge(d, opts = {}) {
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
      // Also render a real tray notification for the nudge so the backgrounded
      // user sees it (data-only pushes have no system-rendered tray entry).
      if (opts.tray !== false) {
        try {
          await showSystemNotification({
            notificationId: numOf(d.id),
            senderId: numOf(d.senderId),
            senderUsername: d.senderUsername,
            senderName: d.senderName || d.senderUsername,
            receiverId: numOf(d.receiverId),
            message: d.body || '👋 nudged you!',
            title: d.title || d.senderName || d.senderUsername || 'Tojey',
          });
        } catch (e) {}
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

const numOf = (v) => (/^[1-9]\d*$/.test(String(v)) ? parseInt(v, 10) : undefined);

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

/**
 * Extract our notification payload from a RemoteMessage.
 * Handles all three data-only push types:
 *   `tojey_chat`    -> a new chat message (opens that exact conversation)
 *   `tojey_nudge`   -> a nudge/vibrate ping (opens the nudger's conversation)
 *   `tojey_notification` -> a manual "send notification" (notify-button flow)
 */
export function extractNotifPayload(remoteMessage) {
  if (!remoteMessage) return null;
  const d = (remoteMessage.data && typeof remoteMessage.data === 'object') ? remoteMessage.data : {};
  const num = (v) => (/^[1-9]\d*$/.test(String(v)) ? parseInt(v, 10) : null);
  if (d.type === 'tojey_chat') {
    return {
      kind: 'chat',
      conversationId: num(d.conversationId),
      messageId: num(d.messageId),
      senderId: num(d.senderId),
      senderUsername: d.senderUsername,
      senderName: d.senderName || d.senderUsername,
      receiverId: num(d.receiverId || d.toUserId),
      message: d.msgPreview || d.body || (remoteMessage.notification && remoteMessage.notification.body) || '',
      title: d.senderName || d.senderUsername || (remoteMessage.notification && remoteMessage.notification.title) || 'Tojey',
    };
  }
  if (d.type === 'tojey_nudge') {
    return {
      kind: 'nudge',
      conversationId: num(d.conversationId),
      senderId: num(d.senderId),
      senderUsername: d.senderUsername,
      senderName: d.senderName || d.senderUsername,
      receiverId: num(d.receiverId),
      message: d.body || (remoteMessage.notification && remoteMessage.notification.body) || '👋 nudged you!',
      title: d.senderName || d.senderUsername || 'Tojey',
    };
  }
  if (d.type !== 'tojey_notification') return null;
  return {
    kind: 'notification',
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
    const prefs = await getNotifPrefs();
    if (prefs.enabled === false) return;
    const ignoreSound = prefs.sound === false;
    await ensureNotifeeChannel();
    await notifee.displayNotification({
      id: payload.notificationId ? `tojey-n-${payload.notificationId}` : undefined,
      title: payload.title || payload.senderName || 'Tojey',
      body: payload.message || '',
      data: {
        // Carry the REAL type through (chat/nudge/system) so a tap anywhere in the app
        // resolves to the exact conversation instead of being forced through the
        // notify-button flow. All fields use the same canonical names as FCM data so
        // extractNotifPayload / press handlers behave identically for every source.
        type: payload.type || 'tojey_notification',
        senderId: payload.senderId != null ? String(payload.senderId) : undefined,
        receiverId: payload.receiverId != null ? String(payload.receiverId) : undefined,
        conversationId: payload.conversationId != null ? String(payload.conversationId) : undefined,
        senderUsername: payload.senderUsername != null ? String(payload.senderUsername) : undefined,
        senderName: payload.senderName != null ? String(payload.senderName) : undefined,
        title: payload.title != null ? String(payload.title) : undefined,
        body: payload.message != null ? String(payload.message) : undefined,
      },
      android: {
        channelId: NOTIFICATION_CHANNEL_ID,
        smallIcon: 'ic_stat_tojey',
        color: '#6C3CE9',
        importance: AndroidImportance.HIGH,
        category: AndroidCategory.MESSAGE,
        visibility: AndroidVisibility.PUBLIC,
        sound: ignoreSound ? undefined : 'default',
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
    // Android 13+ POST_NOTIFICATIONS: ask at MOST once per install (no dialog spam on
    // every boot). Later grants/revokes are always honored via a silent check. Older
    // Android (6-12) has no runtime permission and is always "granted".
    let hasPerm = Platform.Version < 33;
    try {
      const prompted = await AsyncStorage.getItem('@tojey_notif_perm_prompted');
      if (!prompted) {
        hasPerm = await requestNotificationPermission();
        await AsyncStorage.setItem('@tojey_notif_perm_prompted', '1');
      } else if (Platform.Version >= 33) {
        hasPerm = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
    } catch (e) {
      console.warn('notification permission gate failed:', e.message);
    }
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

/**
 * Subscribe to foreground pushes. Returns an unsubscribe function.
 * Chat messages arrive over the live socket while the app is in the foreground -
 * the App-level message:receive handler renders them, so `tojey_chat` is dropped
 * here to avoid a duplicate (only a foreground/background race reaches it).
 */
export function onForegroundMessage(cb) {
  try {
    return messaging().onMessage((remoteMessage) => {
      const payload = extractNotifPayload(remoteMessage);
      if (!payload) return;
      if (payload.kind === 'chat') {
        console.log(`[FCM] foreground chat skipped (socket renders it): sender=${payload.senderName}`);
        return;
      }
      console.log(`[FCM] foreground message received: kind=${payload.kind} sender=${payload.senderName}`);
      cb(payload);
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
        if (p) console.log(`[FCM] cold-start opened by notification: kind=${p.kind} conversationId=${p.conversationId}`);
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
        console.log(`[FCM] notification opened while running: kind=${payload.kind} conversationId=${payload.conversationId}`);
        cb(payload);
      }
    });
  } catch (e) {
    return () => {};
  }
}

/**
 * Android background/headless handler. Tojey pushes are DATA-ONLY, so this headless
 * JS task renders the tray notification with Notifee (for chat/nudge/system) and
 * triggers nudge vibration + chat-head bubble - even when the app is backgrounded or
 * terminated. Must be registered at module scope (see index.js).
 */
export function registerBackgroundHandler() {
  try {
    messaging().setBackgroundMessageHandler(async (remoteMessage) => {
      console.log('[FCM] background handler invoked:', JSON.stringify({
        hasNotification: !!remoteMessage?.notification,
        hasData: !!remoteMessage?.data,
        dataKeys: remoteMessage?.data ? Object.keys(remoteMessage.data) : [],
        messageId: remoteMessage?.messageId,
        type: remoteMessage?.data?.type,
      }));
      // Forwards-compat: if a future caller ever sends a `notification` payload,
      // Android already rendered it in the tray - creating another clone here would
      // duplicate it. Nudges are the exception (its tray entry needs the strong
      // vibrate + chat head), so run the handler without re-rendering the tray.
      if (remoteMessage && remoteMessage.notification) {
        const d = remoteMessage.data || {};
        if (d.nudge === '1' || d.type === 'tojey_nudge') {
          if (await handleBackgroundChatOrNudge(d, { tray: false })) return;
        } else {
          console.log(`[FCM] background (system-rendered notification, no JS render) type=${d.type}`);
          return;
        }
      }
      try {
        const payload = extractNotifPayload(remoteMessage);
        if (payload) {
          console.log(`[FCM] background render kind=${payload.kind} conversationId=${payload.conversationId} messageId=${payload.messageId}`);
          if (payload.kind === 'nudge') {
            await handleBackgroundChatOrNudge(remoteMessage.data, { tray: true });
          } else {
            await showSystemNotification(payload);
            await handleBackgroundChatOrNudge(remoteMessage.data, { tray: false });
          }
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