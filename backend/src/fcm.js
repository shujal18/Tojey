/**
 * Firebase Cloud Messaging helper.
 *
 * Credentials are read from environment variables only, never committed:
 *   - FIREBASE_SERVICE_ACCOUNT_B64 : base64 of the full Firebase service-account JSON
 *     (preferred - single secret, no newline escaping issues on Render)
 *   - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY : individual fields
 *
 * If no credentials are configured the module stays disabled and every send returns a
 * non-fatal result - the rest of the server keeps working (Socket.IO delivery unaffected).
 */
let admin = null;
let messaging = null;
let configWarned = false;

function loadCredentials() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64 JSON:', e.message);
      return null;
    }
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return {
      type: 'service_account',
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

function ensureInitialized() {
  if (messaging) return true;
  if (admin === null) {
    const creds = loadCredentials();
    if (!creds) return false;
    try {
      admin = require('firebase-admin');
      admin.initializeApp({
        credential: admin.credential.cert(creds),
        projectId: creds.project_id,
      });
      messaging = admin.messaging();
      console.log('FCM enabled for project', creds.project_id || creds.projectId || '(unknown)');
    } catch (e) {
      admin = null;
      messaging = null;
      console.error('Firebase Admin initialization failed - FCM disabled:', e.message);
    }
  }
  return !!messaging;
}

function warnOnce() {
  if (configWarned) return;
  configWarned = true;
  console.warn(
    'FCM is not configured. Set FIREBASE_SERVICE_ACCOUNT_B64 (or FIREBASE_PROJECT_ID / ' +
    'FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY) to enable push notifications.'
  );
}

// Token codes from firebase-admin that mean the stored token is dead and must be dropped.
// NOTE: messaging/invalid-argument is NOT a token code - it means the whole message was
// rejected for a payload error, so it must never be treated as a dead-token (doing so
// would deactivate perfectly valid tokens on every failed send).
function isInvalidTokenCode(code) {
  if (!code) return false;
  return /registration-token-not-registered|invalid-registration|unregistered/i.test(code);
}

/**
 * Send one push notification to every active token of `tokens`.
 *
 * Resolves with:
 *   { success: true, messageId }              - at least one token accepted
 *   { success: false, note }                  - nothing accepted (or FCM disabled)
 *   void invalidTokens: string[]              - tokens firebase reports as dead
 */
// Show only the start and end of a token so logs stay debuggable without leaking FCM tokens.
function maskToken(t) {
  if (!t) return '';
  if (String(t).length <= 12) return '***';
  return `${String(t).slice(0, 8)}…${String(t).slice(-4)}`;
}

async function sendPush({ tokens, notification, data }) {
  if (!ensureInitialized()) {
    warnOnce();
    return { success: false, note: 'fcm-unconfigured', invalidTokens: [] };
  }
  try {
    // Data-only payloads (no `notification`) must NOT carry android.notification:
    // FCM keeps those as foreground-fallback notifications and can pop a blank tray
    // entry. Android builds the tray UI itself when `notification` is present.
    const payload = {
      tokens,
      notification,
      data,
      android: {
        priority: 'high',
        ...(notification
          ? {
              notification: {
                channelId: 'tojey-messages',
                sound: 'default',
                priority: 'high',
                defaultVibrateTimings: true,
                visibility: 'private',
                // Android-specific fields must live under android.notification. Putting
                // icon in the generic FCM notification object makes the Admin SDK reject
                // the message on some versions. Without an icon, Google Play services on
                // many devices silently drops the notification. ic_stat_tojey exists in
                // the APK and is what the app's own notifier uses, so it is resolvable.
                icon: 'ic_stat_tojey',
                // NOTE: there is no "category" field in FCM's android.notification
                // (that is an iOS APNS concept). Sending it makes FCM reject the whole
                // message with messaging/invalid-argument and drops the notification.
                // Message-category behavior for DND comes from the HIGH-importance
                // 'tojey-messages' channel, which the app creates natively.
              },
            }
          : {}),
      },
      // Web Push: the browser registers a real FCM web token via the Firebase JS SDK
      // ("@firebase/messaging") in the web app, stored with platform 'web' in
      // device_tokens. firebase-admin delivers to it through FCM's HTTP v1 API using
      // the service account, so NO VAPID key is needed here - the public VAPID key is
      // used only by the browser to subscribe. Do NOT add any custom webpush field
      // (e.g. vapidKey): this SDK version has no such field and it risks invalidating
      // the whole multicast payload.
    };
    const result = await messaging.sendEachForMulticast(payload);

    const invalidTokens = [];
    let accepted = 0;
    let firstSuccessMessageId = '';
    const perToken = [];
    let failureCount = 0;
    let payloadRejected = false;
    let payloadRejectMsg = '';
    (result.responses || []).forEach((r, i) => {
      if (r.success) {
        accepted++;
        if (!firstSuccessMessageId) firstSuccessMessageId = r.messageId || '';
        perToken.push({ ok: true, messageId: r.messageId || '' });
      } else {
        failureCount++;
        const code = r.error && r.error.code ? r.error.code : 'unknown';
        const msg  = r.error && r.error.message ? r.error.message : '';
        console.log(`[FCM] token ${i+1}/${tokens.length} code=${code} msg=${msg}`);
        perToken.push({ ok: false, code, msg });
        if (isInvalidTokenCode(code)) invalidTokens.push(tokens[i]);
        // A message-level invalid-argument means the whole payload was rejected BEFORE it
        // reached any device (e.g. an unknown field in android.notification), so every
        // token "fails" with the same code. That is NOT a token problem.
        if (/invalid-argument/.test(code)) payloadRejected = true;
        if (!payloadRejectMsg) payloadRejectMsg = msg;
      }
    });

    if (accepted > 0) {
      console.log(`[FCM] multicast: tokens=${tokens.length} accepted=${accepted} invalid=${invalidTokens.length} msgId=${firstSuccessMessageId}`);
      return { success: true, messageId: firstSuccessMessageId, invalidTokens, perToken };
    }
    if (payloadRejected && failureCount === tokens.length) {
      // Every token reported the same payload error - no device was reached and none of
      // the tokens are dead. Never deactivate tokens for this; log the real cause.
      console.error(`[FCM] multicast: payload rejected by FCM (invalid-argument): ${payloadRejectMsg || 'invalid message fields'} - check the android.notification payload. No tokens invalidated.`);
      return { success: false, note: 'fcm-invalid-payload', invalidTokens: [], perToken };
    }
    if (invalidTokens.length) {
      // UNREGISTERED on a freshly-registered token almost always means the token was
      // created for a DIFFERENT Firebase project/app than the Admin SDK being used
      // (e.g. a token registered from a build with another google-services.json), or
      // the app was uninstalled/reinstalled so Android invalidated the old token.
      const sample = invalidTokens.slice(0, 2).map(maskToken).join(', ');
      const projectId = (messaging.app && messaging.app.options && messaging.app.options.projectId) || 'unknown';
      console.log(`[FCM] multicast: all ${tokens.length} token(s) reported UNREGISTERED (sample: ${sample || 'n/a'}). Admin project=${projectId} - verify the app's google-services.json project matches, or reinstall to get a fresh token.`);
    }
    return { success: false, note: 'fcm-rejected', invalidTokens, perToken };
  } catch (e) {
    // FCM outage / network failure must never crash the server.
    console.error('FCM send failed:', e.errorInfo && e.errorInfo.code ? e.errorInfo.code : e.message);
    return { success: false, note: 'fcm-error', invalidTokens: [] };
  }
}

async function deactivateTokens(tokens) {
  if (!tokens || !tokens.length) return;
  const { pool } = require('./db');
  try {
    await pool.query('UPDATE device_tokens SET is_active = FALSE, updated_at = NOW() WHERE fcm_token = ANY($1)', [tokens]);
  } catch (e) {
    console.error('Failed to deactivate invalid FCM tokens:', e.message);
  }
}

module.exports = { sendPush, deactivateTokens, fcmEnabled: () => ensureInitialized() };