# Tojey — Saved Requirements & Product Rules

This file is the project's memory of agreed product behavior. Always read this before
changing notification, delivery, or chat behavior, and before assuming how the app works.

## Core architecture rule (unchanged)
- Socket.IO = realtime in-app delivery. FCM = Android system notification.
- Never run a keep-alive service just for FCM on Android.

## NOTIFICATION REQUIREMENT (from user, 2026-09-14, final)
1. **Chat messages must NEVER produce an Android system notification/pop-up**, in any app
   state (foreground, background, terminated, or on a different screen). Chat is in-app only.
2. The **"Send notification"** button (`POST /api/notifications/send` + mobile HomeScreen
   long-press → send) MUST produce a real Android system notification pop-up on the receiver
   device **whether ONLINE or OFFLINE**. This is the ONLY system notification the app
   produces. The server routes via Socket.IO when online and FCM when offline.

## Delivery mechanisms (button-only popup, confirmed final)
- Online + socket alive → `notification:receive` over socket → app renders notifee popup (works on OEM ROMs like ColorOS).
- Offline / no socket → FCM push via Firebase Admin (system-tray notification rendered by GMS).
- Chat messages: Socket.IO only, in-app. No FCM ever for chat messages.

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