# Android FCM delivery: behavior, limits and what is NOT fixed

> Status as of the Layer-1/2/3 Message Sync + Local Cache work (v1.3.0). This document
> records the *honest* behavior of push delivery on Android 6+ (API 23, minSdk floor)
> and the constraints that cannot be verified or improved from this environment.

## What was implemented (payload + per-device routing)

- **Per-device foreground model.** Each socket registers `deviceId` on connect
  (`handshake.auth.deviceId`, socket.js → `getDeviceId()`). The server keeps
  `deviceId -> {deviceState, isForeground, lastSeq, lastTs, lastTsAck}` and decides per
  connected device whether to push over socket or FCM. Legacy clients (no `deviceId`)
  keep working through the old `userActivityMap`.
- **Notifications API now pushes to backgrounded-but-connected users.** `/api/notifications/send`
  builds the recipient's device-token list, skips devices that are foregrounded and
  connected (socket wins), and sends FCM for every other active device - previously it
  skipped FCM entirely when the user's socket was online.
- **Payload consistency.** `showSystemNotification` now stores the real message type and
  canonical fields (`senderUsername`, `senderName`, `title`, `body`) used by the
  notification tap intent and the background handler, so taps route to the right chat and
  kind. `extractNotifPayload` also parses `tojey_nudge` payloads (both click and detail
  intents) which were previously dropped.
- **`tojey_nudge` (chat heads).** Forced FCM via `tokensNeedingFcm` per active device
  (conversationId is now looked up server-side instead of created, and included in the
  data payload). A backgrounded-device nudge is delivered even though the recipient's
  socket is connected.
- **Nudge frequency** is rate-limited server-side (4/hour, per prior requirement).

## What is still NOT verified / impossible to verify here

The Android test matrix A-G below cannot be executed in this environment:

- **No Android device is attached.** The OPPO CPH1801 used for the prior round's live FCM
  tests is USB-disconnected, so no live push/lifecycle test can be run for v1.3.0.
  Everything below is platform *documentation*, not a claim that a particular path was
  observed on a device with this build.

### Known platform constraints (Android 6+, target/compile 34)

1. **Doze / App Standby (Android 6+).** Once the device enters Doze, high-priority FCM
   messages (`priority: 'high'`) may still be delivered but delivery latency grows
   without bound; nothing guarantees timely delivery in this window. Data-only messages
   with `priority: 'high'` are the only push that can wake the app in this state.
2. **Android 13+ POST_NOTIFICATIONS.** The app requests the runtime permission at most
   once per install (`@tojey_notif_perm_prompted` gate). If denied, FCM data messages are
   still processed (server mark) but no `SystemNotification`/chat-head appears - the
   server has **no way to know** permission was revoked, so the "device foreground /
   streamed" signal stays accurate but the "popped a notification" signal does not.
   Push-initiated stream opens (data payload) are *not* governed by the permission (they
   are an in-app navigation), so chat heads can still open the chat.
3. **Data-only vs. notification messages.** All pushes here are data-only
   (`notification` key is intentionally avoided) so the app controls the UI - the side
   effect is that the OS does not render anything if the app process/JS thread is killed
   and the `RNHeadlessJsTaskService` handler cannot run.
4. **Process killed → cold JS start.** For exact OS-kill cases the message may already be
   reconciled via socket/history on next open; the notification tap carries the payload
   and routes to the conversation, but a *notification popup* for a message received
   while the process is dead depends on the headless task gaining JS context in time.
5. **Multi-device.** Each device is now addressed individually (per-device state), but
   read/delivery receipts and the read-state echo are still conversation-scoped, so a
   second logged-in device cannot prove which *specific* device marked messages read.

## Test matrix (for the next person with a device)

A. Foreground connected → live stream, no duplicate popup.
B. Background connected (deviceState `background`) but socket alive → FCM data push pops
   SystemNotification + chat head.
C. Airplane mode → background → flight restored while socket reconnects → queued FCM
   (if arrived during cut) + socket history reconcile, no duplicates.
D. Force-stop app → send message → open via notification tap → routes to chat, cache
   first then history.
E. Android 13 prompt denial → no popup, chat head open still works.
F. Two devices, same account → send from device 1, only device 2 pops (device 1 streams
   and doesn't double-show).
G. 1000+ message thread → open: instant cache render, incremental `messages:after`, no
   duplicates, composer/service stable.

## Ops notes

- Validate FCM creds via `FIREBASE_SERVICE_ACCOUNT_B64` or individual fields in
  `backend/.env` (see `backend/.env.example`). Never log full tokens - `maskToken` masks.
- `render.yaml` auto-deploys backend on push to `main` when auto-deploy is enabled; the
  deployment status is not visible from here and must be confirmed in the Render
  dashboard.