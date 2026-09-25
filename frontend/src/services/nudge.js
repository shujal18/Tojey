export const NUDGE_PATTERN = [0, 450, 150, 450, 150, 450, 150, 450, 150, 450];

export function vibrateNudge() {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(NUDGE_PATTERN);
    }
  } catch (e) {}
}

export function askNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch (e) {}
}

// Pop a browser notification even when this tab is focused (used for the explicit
// "Send Notification" feature, unlike chat/nudge which never pop).
export function forceNotify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    new Notification(title, { body, tag: 'tojey' });
  } catch (e) {}
}