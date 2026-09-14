# Tojey — Saved Requirements & Product Rules

This file is the project's memory of agreed product behavior. Always read this before
changing notification, delivery, or chat behavior, and before assuming how the app works.

## Core architecture rule (unchanged)
- Socket.IO = realtime in-app delivery. FCM = Android system notification.
- Never run a keep-alive service just for FCM on Android.

## NOTIFICATION REQUIREMENT (from user, 2026-09-13/14)
1. The **"Send notification"** feature (mobile HomeScreen contact long-press → button →
   `POST /api/notifications/send`, and its web equivalent) MUST produce an Android system
   notification pop-up on the receiver's phone **whether the receiver is ONLINE or OFFLINE**.
   This is a hard requirement — the button is the reference feature and it must pop in all states.
2. **Chat-room messages** must be delivered in-app over the socket. Whether they also fire a
   system notification depends on the "message popup rule" below (see "Message popup rule").
3. The user complains that currently the Send-notification button pops but **chat messages do
   not** behave like it — the gap is `message:receive` has no system-notification path while
   `notification:receive` does (mobile App.jsx).
4. Chat messages must ALWAYS display *inside* the app (chat room), independent of popups.

## Message popup rule — CONFIRMED by user (2026-09-14, corrected)
- **CHAT MESSAGES SHOULD POP like the Send-notification button**: a system notification appears
  when the receiving app is NOT actively showing that conversation (background, minimized,
  terminated, or the app is open on a different screen). When the user is reading that same
  chat, the message stays in-app (no system popup).
- The explicit **Send notification** button (/api/notifications/send) MUST pop in EVERY state:
  ONLINE and OFFLINE (foreground, background, terminated).
- No double popups: app-side (socket→notifee) covers background/minimized/open-elsewhere;
  server FCM (GMS rendering) covers terminated/offline where no socket exists.

## Delivery mechanisms (single popup per state — avoid double popups)
- Foreground + socket alive → in-app only (NO system popup).
- Background + socket alive → app-side system notification from the socket event (notifee) is
  acceptable; server FCM for the same case must not double-fire.
- Terminated / offline (no socket) → server FCM (GMS renders the notification+data payload).

## Firebase / token invariants
- Project `tojey-dba45`, Android package `com.tojey`. No hardcoded FCM tokens.
- Always `messaging().getToken()` fresh; never reuse a cached token. Register on login / boot /
  token refresh. Logout deactivates. Never log raw tokens (mask). Android 6+; POST_NOTIFICATIONS
  only requested conditionally on Android 13+.

## FCM audit (2026-09-14) — verified chain + actions
Verified end-to-end (Android config → google-services.json → token gen/refresh/register → Neon
device_tokens → Admin send → routing). Project `tojey-dba45` matches everywhere; package
`com.tojey`; channel `tojey-messages` (importance HIGH); POST_NOTIFICATIONS Android-13+ only;
background handler registered at module scope in index.js; system-rendered FCM notifications for
`notification`+data so no JS dependency when backgrounded/terminated; UNREGISTERED handled by
deactivating token (never the user).
Audit fixes applied (working tree, UNCOMMITTED — user said no push to GitHub):
1. `mobile/android/app/build.gradle`: missing google-services.json now FAILS the build clearly
   instead of silently skipping Firebase.
2. `backend/src/server.js` message:send routing: `needFcm = !hasSocket` (was
   `!hasSocket || !receiverForeground`) so background-with-socket users get ONE popup via the app
   (notifee on message:receive) — deployed-app pairing without this = DOUBLE popups for
   backgrounded users. Render deploys from GitHub → needs a push to take effect.
3. `backend/src/fcm.js`: notification icon `ic_stat_tojey` added to push payload (GMS renders some
   pushes only with an icon).
4. `mobile/App.jsx`: global `message:receive` → showSystemNotification unless reading that chat.
Also: `google-services.json` is real + UNTRACKED; `.example` was deleted. `tom4.apk` local.
Device restrictions (cannot be fixed in app code): OPPO ColorOS kills the app ~1 min after
minimize and does not render GMS FCM notifications to removed/stopped apps; that phone's
framework DND was stuck at `zen_mode=3` (Alarms only) which intercepted even foreground popups.

## Process rule (from user)
- Before making any change or running any test, ANALYZE all the app's features first (back end
  routes, mobile screens/services, web app, all socket events). Do not act on assumptions.

## App inventory (for reference, verified 2026-09-14)
Back end: login, users+presence, uploads (range for media), devices/token (+deactivate),
notifications/send, devices/tokens (diag), devices/tokens/sendtest (diag), profile GET/PUT.
Socket events: presence:update, connected:ack, app:foreground/background, conversation:open,
message:send/receive/delivered/read/typing/start+stop/nudge/edit/delete/react,
conversation:list/clear, voice:transcribe, disconnect. Tables: users, conversations, messages,
message_reactions, media, voice_messages, user_presence, device_tokens, notifications,
read_receipts, settings, stored_media.
Mobile: HomeScreen (Send-notification button, nudge, chat head, cache), ChatRoomScreen (text/
voice/preview/media/view-once-label/reactions/swipe reply+edit), SettingsScreen, lock screen,
banners, ColorEmoji. Web: full chat minus audio, browser Notification for messages/nudges.