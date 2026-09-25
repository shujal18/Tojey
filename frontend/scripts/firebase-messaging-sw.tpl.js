/* Tojey web-push service worker (compat source).
 * Generated from this template at build time by scripts/gen-sw.mjs which injects the
 * Firebase web messaging sender id (__MESSAGING_SENDER_ID__). The generated file is
 * written to public/firebase-messaging-sw.js and copied verbatim into dist/ by Vite.
 *
 * Uses the Firebase compat CDN bundles so this worker needs no bundling. It receives
 * FCM data-only pushes (only type tojey_notification, from the explicit "Send
 * Notification" option) and renders the system notification itself; clicking it
 * re-opens the exact conversation (?chat=<id>).
 */
importScripts('https://www.gstatic.com/firebasejs/11.3.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.3.1/firebase-messaging-compat.js');

firebase.initializeApp({ messagingSenderId: '__MESSAGING_SENDER_ID__' });
const messaging = firebase.messaging();

function mediaLabel(type) {
  if (type === 'VOICE') return 'Voice message';
  if (type === 'IMAGE') return 'Photo';
  if (type === 'VIDEO') return 'Video';
  if (type === 'FILE' || type === 'DOCUMENT') return 'File';
  return '';
}

messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.senderName || data.title || 'Tojey';
  let body = data.body || 'New message';
  if (!body) {
    const label = mediaLabel(data.msgType);
    body = label ? (label + (data.msgPreview ? ': ' + data.msgPreview : '')) : (data.msgPreview || 'New message');
  }
  const senderId = data.senderId || '';
  self.registration.showNotification(title, {
    body,
    tag: data.conversationId ? 'tojey-' + data.conversationId : 'tojey',
    renotify: false,
    data: {
      senderId,
      conversationId: data.conversationId || '',
      url: senderId ? '/?chat=' + senderId : '/',
    },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});