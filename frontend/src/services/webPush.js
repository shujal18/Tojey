// Web Push (FCM) for the Tojey web app.
//
// The browser subscribes through the Firebase JS SDK (@firebase/messaging) using the
// public VAPID key, producing a real FCM web registration token that the backend stores
// (platform 'web'). firebase-admin then delivers data-only pushes to it via FCM's HTTP
// v1 API - no VAPID needed server-side. The service worker (public/firebase-messaging-sw.js)
// renders the tray notification even when the tab is closed.

import { initializeApp, getApps } from '@firebase/app';
import { getMessaging, getToken, deleteToken, onMessage } from '@firebase/messaging';

const API = import.meta.env.VITE_API_URL || '';

let app = null;
let messagingInstance = null;
let configPromise = null;

// Stable per-browser device id. The socket handshake carries it so the backend can mark
// this "device" foreground/background and route FCM vs Socket.IO per device.
export function getWebDeviceId() {
  try {
    let d = localStorage.getItem('tojey-web-device');
    if (!d) {
      d = 'web-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
      localStorage.setItem('tojey-web-device', d);
    }
    return d;
  } catch (e) {
    return 'web-' + Math.random().toString(36).slice(2, 12);
  }
}

// Browser-safe Firebase web config, served by the backend (never hardcoded in the bundle).
export function getFirebaseWebConfig() {
  if (!configPromise) {
    configPromise = fetch(`${API}/api/config`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return configPromise;
}

export function isWebPushConfigured(cfg) {
  return !!(cfg && cfg.firebaseMessagingSenderId && cfg.vapidPublicKey && cfg.firebaseApiKey && cfg.firebaseAppId && cfg.firebaseProjectId);
}

async function ensureMessaging() {
  const cfg = await getFirebaseWebConfig();
  if (!isWebPushConfigured(cfg)) return { ok: false, note: 'web-fcm-unconfigured' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return { ok: false, note: 'no-push-support' };
  if (Notification.permission === 'denied') return { ok: false, note: 'permission-denied' };

  if (!messagingInstance) {
    if (!getApps().length) {
      app = initializeApp({
        apiKey: cfg.firebaseApiKey,
        projectId: cfg.firebaseProjectId,
        messagingSenderId: cfg.firebaseMessagingSenderId,
        appId: cfg.firebaseAppId,
      });
    } else {
      app = getApps()[0];
    }
    messagingInstance = getMessaging(app);
  }
  return { ok: true };
}

// Subscribe this browser to web push and register the FCM token with the backend.
// Only proceeds when notification permission is already granted (the Settings action /
// enable flow performs the user-gesture prompt first).
export async function subscribeWebPush(token) {
  try {
    if (typeof Notification === 'undefined') return { ok: false, note: 'no-notifications' };
    if (Notification.permission !== 'granted') {
      // Wait for an explicit user action; do not silently request permission.
      return { ok: false, note: 'permission-required' };
    }
    const init = await ensureMessaging();
    if (!init.ok) return init;

    const config = await getFirebaseWebConfig();
    const sw = await navigator.serviceWorker.register('firebase-messaging-sw.js');
    await navigator.serviceWorker.ready;

    let fcmToken;
    try {
      fcmToken = await getToken(messagingInstance, { vapidKey: config.vapidPublicKey, serviceWorkerRegistration: sw });
    } catch (e) {
      // Sender/state mismatch (e.g. previous token bound to another sender): revoke and retry once.
      console.warn('[WebPush] getToken failed, revoking and retrying:', e.message);
      try { await deleteToken(messagingInstance); } catch (err) {}
      fcmToken = await getToken(messagingInstance, { vapidKey: config.vapidPublicKey, serviceWorkerRegistration: sw });
    }
    if (!fcmToken) return { ok: false, note: 'no-token' };

    const res = await fetch(`${API}/api/devices/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token: fcmToken, platform: 'web', deviceId: getWebDeviceId() }),
    });
    if (!res.ok) return { ok: false, note: 'server-rejected' };
    return { ok: true, token: fcmToken };
  } catch (e) {
    console.warn('[WebPush] subscribe failed:', e.message);
    return { ok: false, note: 'error' };
  }
}

// Unsubscribe this browser (logout).
export async function stopWebPush(token) {
  try {
    if (messagingInstance) {
      try { await deleteToken(messagingInstance); } catch (e) {}
      messagingInstance = null;
    }
  } catch (e) {}
  try {
    await fetch(`${API}/api/devices/token/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: getWebDeviceId() }),
    });
  } catch (e) {}
}

// Foreground data-message listener (FCM tojey_chat/tojey_nudge/tojey_notification arriving
// via onMessage). Returns an unsubscribe function.
export async function onWebPushForegroundMessage(handler) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return () => {};
    const init = await ensureMessaging();
    if (!init.ok) return () => {};
    return onMessage(messagingInstance, (payload) => {
      const data = (payload && payload.data) || {};
      handler(data);
    });
  } catch (e) {
    console.warn('[WebPush] onMessage failed:', e.message);
    return () => {};
  }
}