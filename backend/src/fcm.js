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
function isInvalidTokenCode(code) {
  if (!code) return false;
  return /registration-token-not-registered|invalid-registration|invalid-argument|unknown-error-code\s*\(?unregistered/i.test(code)
    || /UNREGISTERED/.test(code);
}

/**
 * Send one push notification to every active token of `tokens`.
 *
 * Resolves with:
 *   { success: true, messageId }              - at least one token accepted
 *   { success: false, note }                  - nothing accepted (or FCM disabled)
 *   void invalidTokens: string[]              - tokens firebase reports as dead
 */
async function sendPush({ tokens, notification, data }) {
  if (!ensureInitialized()) {
    warnOnce();
    return { success: false, note: 'fcm-unconfigured', invalidTokens: [] };
  }
  try {
    const result = await messaging.sendEachForMulticast({
      tokens,
      notification,
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'tojey-messages',
          sound: 'default',
          priority: 'high',
          defaultVibrateTimings: true,
          visibility: 'private',
        },
      },
    });

    const invalidTokens = [];
    let accepted = 0;
    let firstSuccessMessageId = '';
    (result.responses || []).forEach((r, i) => {
      if (r.success) {
        accepted++;
        if (!firstSuccessMessageId) firstSuccessMessageId = r.messageId || '';
      } else if (isInvalidTokenCode(r.error && r.error.code)) {
        invalidTokens.push(tokens[i]);
      }
    });

    if (accepted > 0) {
      console.log(`FCM send: accepted=${accepted}/${tokens.length} invalid=${invalidTokens.length} msgId=${firstSuccessMessageId}`);
      return { success: true, messageId: firstSuccessMessageId, invalidTokens };
    }
    if (invalidTokens.length) {
      console.log(`FCM send: all ${tokens.length} token(s) reported invalid.`);
    }
    return { success: false, note: 'fcm-rejected', invalidTokens };
  } catch (e) {
    // FCM outage / network failure must never crash the server.
    console.error('FCM send failed:', e.errorInfo && e.errorInfo.code ? e.errorInfo.code : e.message);
    return { success: false, note: 'fcm-error' };
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