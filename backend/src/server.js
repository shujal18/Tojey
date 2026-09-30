require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { initDB, pool } = require('./db');
const { signToken, verifyToken, authenticate, authMiddleware } = require('./auth');
const { sendPush, deactivateTokens, fcmEnabled } = require('./fcm');
const { getFeed } = require('./youtube');
const path = require('path');
const { upload } = require('./media');

// Show only the start and end of a token so logs stay debuggable without leaking FCM tokens.
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 12) return '***';
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Minimal in-memory rate limiter for the notification endpoint (single Render instance).
const sendBucket = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const windowMs = 30000;
  const max = 10;
  const b = sendBucket.get(userId);
  if (!b || now - b.start >= windowMs) {
    sendBucket.set(userId, { start: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

const FRONTEND_DIST = path.join(__dirname, '..', '..', 'frontend', 'dist');
const fs = require('fs');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  console.log('✓ Serving built frontend from', FRONTEND_DIST);
}

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8,
  pingInterval: 15000,
  pingTimeout: 10000,
});

app.get('/', (req, res) => res.json({ app: 'Tojey', status: 'running' }));

// Public, harmless config the clients need at runtime. Only the Web Push PUBLIC key
// (VAPID) is exposed - it is designed to be shared; the private half never leaves the
// Firebase project / env vars.
app.get('/api/config', (req, res) => {
  // Everything here is browser-safe (public credentials designed to ship to clients).
  // The web app needs these to subscribe via the Firebase JS SDK and to register FCM
  // web tokens that firebase-admin can later push to.
  const config = {};
  for (const [key, envName] of [
    ['vapidPublicKey', 'FIREBASE_PUBLIC_VAPID_KEY'],
    ['firebaseApiKey', 'FIREBASE_API_KEY'],
    ['firebaseProjectId', 'FIREBASE_PROJECT_ID'],
    ['firebaseMessagingSenderId', 'FIREBASE_MESSAGING_SENDER_ID'],
    ['firebaseAppId', 'FIREBASE_APP_ID'],
  ]) {
    if (process.env[envName]) config[key] = process.env[envName];
  }
  res.json(config);
});

// Startup FCM diagnostics - runs after initDB() so we can see config state
function logFcmStartupStatus() {
  const hasB64 = !!process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const hasParts = !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
  if (hasB64 || hasParts) {
    try {
      const creds = hasB64
        ? JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'))
        : { project_id: process.env.FIREBASE_PROJECT_ID };
      console.log(`[FCM] Firebase Admin ENABLED for project: ${creds.project_id || creds.projectId || 'unknown'}`);
    } catch (e) {
      console.log('[FCM] Firebase Admin ENABLED (project ID not parseable from env)');
    }
  } else {
    console.log('[FCM] Firebase Admin DISABLED - no server-side credentials configured');
    console.log('[FCM] Missing Render env vars: FIREBASE_SERVICE_ACCOUNT_B64 (preferred) OR FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY');
    console.log('[FCM] Android google-services.json cannot replace server credentials');
  }
}

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const token = signToken(user);

  try {
    const result = await pool.query(
      `SELECT id, username, display_name, bio, profile_pic_url FROM users WHERE username = $1`,
      [user.username]
    );
    const dbUser = result.rows[0];
    if (!dbUser) {
      return res.status(401).json({ error: 'Account not provisioned' });
    }
    res.json({ token, user: { id: dbUser.id, username: dbUser.username, displayName: dbUser.display_name, bio: dbUser.bio, profilePic: dbUser.profile_pic_url } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.bio, u.profile_pic_url,
       p.is_online, p.last_seen
       FROM users u
       LEFT JOIN user_presence p ON p.user_id = u.id`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const path = require('path');
    const { v4: uuidv4 } = require('uuid');
    const ext = path.extname(req.file.originalname) || '.bin';
    const filename = `${uuidv4()}${ext}`;
    await pool.query(
      `INSERT INTO stored_media (filename, mimetype, size, data) VALUES ($1, $2, $3, $4)`,
      [filename, req.file.mimetype, req.file.size, req.file.buffer]
    );
    res.json({
      url: `/uploads/${filename}`,
      filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/uploads/:filename', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT mimetype, data FROM stored_media WHERE filename = $1',
      [req.params.filename]
    );
    if (result.rows.length === 0) return res.status(404).send('Not found');
    const mimetype = result.rows[0].mimetype || 'application/octet-stream';
    const body = result.rows[0].data;
    const total = body.length;
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', mimetype);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    // HTTP Range support is required by ExoPlayer (in-app video playback) for
    // seeking and for large files. Return a 206 with the requested slice.
    const range = req.headers.range;
    if (typeof range === 'string' && /^bytes=.+$/.test(range.trim())) {
      const m = range.trim().match(/^bytes=(-?\d*)-(-?\d*)$/);
      let start = NaN;
      let end = NaN;
      if (m) {
        if (m[1] !== '') start = parseInt(m[1], 10);
        if (m[2] !== '') end = parseInt(m[2], 10);
      }
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end)) end = total - 1;
      if (start < 0) start = Math.max(0, total + start); // suffix range e.g. bytes=-500
      if (end >= total) end = total - 1;
      if (start > end || start >= total) {
        return res.status(416).set('Content-Range', `bytes */${total}`).end();
      }
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', String(end - start + 1));
      return res.send(body.slice(start, end + 1));
    }

    res.send(body);
  } catch (e) {
    console.error('upload serve error', e.message);
    res.status(500).send('Server error');
  }
});

// Register (or refresh) an FCM push token for the authenticated user.
// A user may own several tokens (one per device). Conflict is on the token itself so a
// refreshed token replaces the old registration instead of creating duplicates.
app.post('/api/devices/token', authMiddleware, async (req, res) => {
  try {
    const user = (await pool.query('SELECT id FROM users WHERE username = $1', [req.user.username])).rows[0];
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { token, platform, deviceId } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token is required' });
    }

    await pool.query(
      `INSERT INTO device_tokens (user_id, fcm_token, platform, device_id, last_seen_at, updated_at, is_active)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), TRUE)
       ON CONFLICT (fcm_token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         platform = COALESCE(EXCLUDED.platform, device_tokens.platform),
         device_id = COALESCE(EXCLUDED.device_id, device_tokens.device_id),
         last_seen_at = NOW(),
         updated_at = NOW(),
         is_active = TRUE`,
      [user.id, token.trim(), platform || 'android', deviceId || null]
    );

    // Firebase rotated this device's token: supersede any OTHER active token that this
    // same device previously registered for this user, so the old (now-dead) token never
    // lingers as an active entry that later hard-fails with UNREGISTERED.
    if (deviceId) {
      await pool.query(
        `UPDATE device_tokens SET is_active = FALSE, updated_at = NOW()
         WHERE user_id = $1 AND device_id = $2 AND fcm_token <> $3 AND is_active = TRUE`,
        [user.id, deviceId, token.trim()]
      );
    }

    console.log(`[FCM] token registered: user=${user.id} device=${deviceId || 'n/a'} token=${maskToken(token.trim())}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('devices:token error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deactivate the caller's FCM token (logout / app data cleared). The owner is taken
// from the JWT - a token can only be deactivated by the user it belongs to.
app.post('/api/devices/token/deactivate', authMiddleware, async (req, res) => {
  try {
    const user = (await pool.query('SELECT id FROM users WHERE username = $1', [req.user.username])).rows[0];
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const { token, deviceId } = req.body || {};
    if (!deviceId && (!token || typeof token !== 'string' || !token.trim())) {
      return res.status(400).json({ error: 'token or deviceId is required' });
    }

    // Deactivate everything this device registered for this user (covers token rotation
    // between login and logout); without a deviceId, fall back to the token-scoped row.
    const tp = token ? token.trim() : null;
    if (deviceId) {
      await pool.query(
        `UPDATE device_tokens SET is_active = FALSE, updated_at = NOW()
         WHERE user_id = $1 AND device_id = $2 AND ($3::text IS NULL OR fcm_token = $3)`,
        [user.id, deviceId, tp]
      );
    } else {
      await pool.query(
        `UPDATE device_tokens SET is_active = FALSE, updated_at = NOW()
         WHERE user_id = $1 AND fcm_token = $2`,
        [user.id, tp]
      );
    }

    console.log(`[FCM] token deactivated: user=${user.id} device=${deviceId || 'n/a'} token=${tp ? maskToken(tp) : '*'}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('devices:token deactivate error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a notification from the authenticated user to receiverId.
// The sender is taken from the JWT, never from the request body.
// Routing decision happens here, server-side:
//   receiver has an active Socket.IO connection  -> deliver over sockets, NO FCM
//   receiver has no active socket                -> deliver via FCM push
app.post('/api/notifications/send', authMiddleware, async (req, res) => {
  try {
    const sender = (await pool.query(
      'SELECT id, username, display_name, profile_pic_url FROM users WHERE username = $1',
      [req.user.username]
    )).rows[0];
    if (!sender) return res.status(401).json({ error: 'Unauthorized' });

    if (rateLimited(sender.id)) {
      return res.status(429).json({ error: 'Too many notifications. Try again shortly.' });
    }

    const { receiverId, message, conversationId, idempotencyKey } = req.body || {};

    if (!/^[1-9]\d*$/.test(String(receiverId))) {
      return res.status(400).json({ error: 'receiverId is required' });
    }
    if (String(receiverId) === String(sender.id)) {
      return res.status(400).json({ error: 'Cannot send a notification to yourself' });
    }

    const body = (typeof message === 'string' ? message.trim() : '');
    if (!body) return res.status(400).json({ error: 'message is required' });
    if (body.length > 500) return res.status(400).json({ error: 'message is too long' });

    const receiver = (await pool.query(
      'SELECT id, username, display_name FROM users WHERE id = $1',
      [receiverId]
    )).rows[0];
    if (!receiver) return res.status(404).json({ error: 'Receiver not found' });

    // Idempotency: a repeated request with the same key returns the stored result
    // without delivering again.
    let existingNotif = null;
    if (idempotencyKey) {
      existingNotif = (await pool.query(
        'SELECT * FROM notifications WHERE idempotency_key = $1',
        [idempotencyKey]
      )).rows[0];
      if (existingNotif) {
        return res.json({ ok: true, duplicate: true, notification: existingNotif, deliveryMethod: existingNotif.delivery_method, status: existingNotif.status });
      }
    }

    let convo = null;
    if (conversationId) {
      convo = (await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId])).rows[0];
      if (!convo) return res.status(404).json({ error: 'Conversation not found' });
      const involvesSender = convo.user1_id === sender.id || convo.user2_id === sender.id;
      const involvesReceiver = convo.user1_id === receiver.id || convo.user2_id === receiver.id;
      if (!involvesSender || !involvesReceiver) {
        return res.status(403).json({ error: 'Conversation does not involve both users' });
      }
    } else {
      convo = await getOrCreateConversation(sender.id, receiver.id);
    }

    const online = userSockets(receiver.id).size > 0;
    const deliveryMethod = online ? 'socket' : 'fcm';

    const insert = await pool.query(
      `INSERT INTO notifications (sender_id, receiver_id, conversation_id, message, type, delivery_method, status, idempotency_key, created_at, delivered_at)
       VALUES ($1, $2, $3, $4, 'NOTIFICATION', $5, 'sent', $6, NOW(), NOW())
       RETURNING *`,
      [sender.id, receiver.id, convo.id, body, deliveryMethod, idempotencyKey || null]
    );
    const notif = insert.rows[0];

    if (online) {
      // Deliver to every active socket of the receiver.
      io.to(`user:${receiver.id}`).emit('notification:receive', {
        notification: notif,
        conversationId: convo.id,
        sender: { userId: sender.id, username: sender.username, displayName: sender.display_name, profilePic: sender.profile_pic_url || '' },
      });
    }

    // Real push to every device of the receiver that is NOT foreground-with-socket, so
    // a backgrounded second device still gets its popup. Android gets a true system
    // notification (rendered by Google Play Services - reliable when the app is closed);
    // web tokens get data-only because the service worker renders its own popup.
    const push = await pushFcmToUser(receiver.id, online, {
      title: sender.display_name || sender.username,
      body,
    }, {
      type: 'tojey_notification',
      notificationId: String(notif.id),
      id: String(notif.id),
      senderId: String(sender.id),
      senderUsername: sender.username,
      senderName: sender.display_name || sender.username,
      senderPic: sender.profile_pic_url || '',
      receiverId: String(receiver.id),
      conversationId: String(convo.id),
      title: sender.display_name || sender.username,
      body,
    });

    if (push.invalidTokens.length) {
      await deactivateTokens(push.invalidTokens);
    }

    if (!push.success) {
      if (online) {
        // The receiver is online on at least one socket; they already got it over the
        // socket and every offline second-device push failed. Reflect that honestly.
        const updated = (await pool.query(
          `UPDATE notifications SET status = 'sent', delivered_at = NOW(), fcm_message_id = $1 WHERE id = $2 RETURNING *`,
          [push.messageId || null, notif.id]
        )).rows[0];
        return res.json({
          ok: true,
          notification: updated,
          deliveryMethod: 'socket',
          status: updated.status,
          note: push.note || 'push to background devices failed',
          fcmNote: push.note,
        });
      }
      const updated = (await pool.query(
        `UPDATE notifications SET status = 'failed', delivered_at = NULL WHERE id = $1 RETURNING *`,
        [notif.id]
      )).rows[0];
      const note = push.note === 'fcm-unconfigured'
        ? 'push is disabled on the server'
        : 'receiver has no registered device token';
      return res.json({ ok: true, notification: updated, deliveryMethod: 'fcm', status: 'failed', note, fcmNote: push.note });
    }

    const status = 'sent';
    const updated = (await pool.query(
      `UPDATE notifications SET status = $1, delivered_at = $2, fcm_message_id = $3 WHERE id = $4 RETURNING *`,
      [status, new Date(), push.messageId || null, notif.id]
    )).rows[0];

    return res.json({
      ok: true,
      notification: updated,
      deliveryMethod: online ? 'socket' : 'fcm',
      status: updated.status,
      note: push.invalidTokens.length ? `deactivated ${push.invalidTokens.length} invalid token(s)` : undefined,
      fcmNote: push.note,
    });
  } catch (e) {
    console.error('notifications:send error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/fcm/status', authMiddleware, async (req, res) => {
  try {
    const user = (await pool.query('SELECT id, username FROM users WHERE username = $1', [req.user.username])).rows[0];
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const adminEnabled = fcmEnabled();
    const projectId = adminEnabled ? (() => {
      try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
          return JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')).project_id;
        }
        return process.env.FIREBASE_PROJECT_ID;
      } catch (e) { return 'unknown'; }
    })() : null;

    const tokensRes = await pool.query(
      `SELECT fcm_token, device_id, is_active, updated_at
       FROM device_tokens WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 10`,
      [user.id]
    );

    const activeTokens = tokensRes.rows.filter(r => r.is_active);
    const userTokens = tokensRes.rows.map(r => ({
      deviceId: r.device_id || 'legacy',
      active: r.is_active,
      tokenMasked: r.fcm_token ? (r.fcm_token.length > 12 ? r.fcm_token.slice(0, 8) + '…' + r.fcm_token.slice(-4) : '***') : null,
      updatedAt: r.updated_at,
    }));

    res.json({
      firebaseAdmin: adminEnabled ? 'ENABLED' : 'DISABLED',
      firebaseProjectId: projectId,
      totalActiveTokens: activeTokens.length,
      tokens: userTokens,
      note: adminEnabled ? 'FCM is configured. Test push with /api/devices/tokens/sendtest' : 'Set FIREBASE_SERVICE_ACCOUNT_B64 (or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY) in Render env vars to enable FCM. Android google-services.json does NOT configure the backend.',
    });
  } catch (e) {
    console.error('fcm:status error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Build/version diagnostic: proves which deploy is live and whether keep-alive
// devices are reaching the in-memory router. Harmless counters only, no PII.
app.get('/api/version', (req, res) => {
  let trackedDevices = 0;
  let keepAliveDevices = 0;
  let foregroundDevices = 0;
  for (const st of deviceStateMap.values()) {
    trackedDevices++;
    if (st.keepAlive) keepAliveDevices++;
    if (st.state === 'foreground') foregroundDevices++;
  }
  res.json({
    version: 'v1.17.0',
    deployment: process.env.RENDER_DEPLOYMENT_ID || null,
    trackedDevices,
    keepAliveDevices,
    foregroundDevices,
    now: new Date().toISOString(),
  });
});

// Reels: clients report reels that fail to embed (region/age-restricted) so
// cached feeds stop re-serving them to every user. Bounded, per-user rate limit.
const reelsReportRate = new Map();
app.post('/api/reels/report', authMiddleware, (req, res) => {
  try {
    const { category, videoIds } = req.body || {};
    if (!Array.isArray(videoIds) || !videoIds.length) {
      return res.status(400).json({ error: 'videoIds required' });
    }
    const { markVideoFailed } = require('./youtube');
    const validCategories = ['trending', 'memes', 'hindi', 'hindi_songs', 'love'];
    const c = typeof category === 'string' && validCategories.includes(category) ? category : 'trending';
    const valid = videoIds
      .filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id))
      .slice(0, 20);
    if (!valid.length) {
      return res.status(400).json({ error: 'no valid video ids' });
    }

    // Rate-limit: ~30 reports/minute/user is far above any client's normal load.
    const uid = String((req.user && (req.user.id || req.user._id || req.user.username)) || req.ip || 'anon');
    const now = Date.now();
    const r = reelsReportRate.get(uid);
    if (r) {
      if (now - r.start > 60000) {
        reelsReportRate.set(uid, { start: now, count: 1 });
      } else if (r.count >= 30) {
        return res.status(429).json({ error: 'Too many reel reports' });
      } else {
        r.count += 1;
      }
    } else {
      reelsReportRate.set(uid, { start: now, count: 1 });
    }

    valid.forEach((id) => markVideoFailed(c, id, 'client_report'));
    res.json({ ok: true, marked: valid.length });
  } catch (e) {
    console.error('reels:report error', e.message);
    res.status(500).json({ error: 'Failed to process reel report' });
  }
});

// Reels feed endpoint - returns short video metadata from YouTube via backend proxy
app.get('/api/reels/feed', authMiddleware, async (req, res) => {
  try {
    const { category = 'trending', refresh = 'false', pageToken } = req.query;
    const validCategories = [
      'trending', 'memes', 'hindi', 'hindi_songs', 'love'
    ];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const forceRefresh = refresh === 'true';
    const { getFeed, getQuotaStatus } = require('./youtube');
    const result = await getFeed(category, forceRefresh, pageToken);
    
    const quotaStatus = getQuotaStatus();
    
    res.json({
      videos: result.videos.map(v => ({
        videoId: v.videoId,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        durationSeconds: v.durationSeconds,
        category: v.category,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        source: v.source,
        localUrl: v.localUrl,
      })),
      cached: result.cached,
      category,
      nextPageToken: result.nextPageToken,
      hasMore: result.hasMore,
      source: result.source,
      cacheAge: result.cacheAge,
      stale: result.stale,
      warning: result.warning,
      quota: quotaStatus,
    });
  } catch (e) {
    console.error('reels:feed error', e.message);
    if (e.message.includes('YOUTUBE_API_KEY')) {
      return res.status(503).json({ error: 'Reels service unavailable - API key not configured' });
    }
    if (e.message.startsWith('QUOTA_')) {
      const { getQuotaStatus } = require('./youtube');
      return res.status(200).json({
        videos: [],
        cached: false,
        category,
        nextPageToken: null,
        hasMore: false,
        source: 'empty',
        warning: 'YouTube quota exceeded - no cached content available',
        quota: getQuotaStatus(),
      });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Reels categories list endpoint
app.get('/api/reels/categories', authMiddleware, async (req, res) => {
  try {
    const categories = [
      { id: 'trending', label: 'For You' },
      { id: 'memes', label: 'Memes' },
      { id: 'hindi', label: 'Hindi' },
      { id: 'hindi_songs', label: 'Hindi Songs' },
      { id: 'love', label: 'Love & Romantic' },
    ];
    res.json({ categories });
  } catch (e) {
    console.error('reels:categories error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reels direct-stream endpoint: resolves signed video+audio URLs via yt-dlp so
// the client plays the reel directly instead of a YouTube embed. Embeds get gated
// when several devices share one IP ("second device just loads"); direct streams
// let every device play at once. Cached + single-flight in ytFormat.
app.get('/api/reels/format/:videoId', authMiddleware, async (req, res) => {
  const videoId = String(req.params.videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video id' });
  }
  try {
    const { getFormat } = require('./ytFormat');
    const f = await getFormat(videoId);
    res.json(f);
  } catch (e) {
    console.error('reels:format error', videoId, e.code, e.message);
    res.status(502).json({ error: 'format unavailable', code: e.code, detail: String(e.message).slice(0, 300) });
  }
});

// YouTube (Home video grid) feed — regular-length videos, not Shorts.
app.get('/api/youtube/feed', authMiddleware, async (req, res) => {
  try {
    const { category = 'trending', refresh = 'false', pageToken } = req.query;
    const forceRefresh = refresh === 'true';
    const { getVideosFeed, getVideoCategories, getQuotaStatus } = require('./youtube');
    const valid = getVideoCategories().map((c) => c.id);
    if (!valid.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const result = await getVideosFeed(category, forceRefresh, pageToken);
    res.json({
      videos: result.videos.map((v) => ({
        videoId: v.videoId,
        title: v.title,
        thumbnailUrl: v.thumbnailUrl,
        durationSeconds: v.durationSeconds,
        category: v.category,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        source: v.source,
      })),
      cached: result.cached,
      category,
      nextPageToken: result.nextPageToken || null,
      hasMore: !!result.hasMore,
      source: result.source,
      warning: result.warning,
      quota: getQuotaStatus(),
    });
  } catch (e) {
    console.error('youtube:feed error', e.message);
    if (e.message.includes('YOUTUBE_API_KEY')) {
      return res.status(503).json({ error: 'YouTube service unavailable - API key not configured' });
    }
    if (e.message.startsWith('QUOTA_')) {
      return res.status(200).json({
        videos: [],
        cached: false,
        category,
        nextPageToken: null,
        hasMore: false,
        source: 'empty',
        warning: 'YouTube quota exceeded - no cached content available',
        quota: require('./youtube').getQuotaStatus(),
      });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// YouTube (Home video grid) categories list.
app.get('/api/youtube/categories', authMiddleware, async (req, res) => {
  try {
    const { getVideoCategories } = require('./youtube');
    const categories = getVideoCategories().map((c) => ({ id: c.id, label: c.label }));
    res.json({ categories });
  } catch (e) {
    console.error('youtube:categories error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- LibreTube-style innertube API (no Data API quota) ----------------------
// Search, channels, playlists, watch pages and related videos run through the
// direct innertube scraper in ytInner.js. Stream URLs stay client-side (signed
// googlevideo URLs are IP-bound, so the backend cannot resolve playable links
// for the device - the mobile client resolves its own streams via getStreams).
const yt = require('./ytInner');
const YTID = /^[a-zA-Z0-9_-]{11}$/;
const ID = /^[a-zA-Z0-9_-]+$/;

app.get('/api/yt/search', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (!q) return res.status(400).json({ error: 'q is required' });
    const filter = String(req.query.filter || 'all').slice(0, 20);
    const token = String(req.query.token || '').slice(0, 4000) || null;
    const result = await yt.search(q, token, filter);
    res.json(result);
  } catch (e) {
    console.error('yt:search error', e.message);
    res.status(502).json({ error: 'search unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/yt/suggestions', authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.json({ suggestions: [] });
    const suggestions = await yt.suggestions(q);
    res.json({ suggestions });
  } catch (e) {
    console.error('yt:suggestions error', e.message);
    res.json({ suggestions: [] });
  }
});

app.get('/api/yt/channel/:channelId', authMiddleware, async (req, res) => {
  try {
    const channelId = String(req.params.channelId || '');
    if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) return res.status(400).json({ error: 'Invalid channel id' });
    const tab = String(req.query.tab || 'videos').slice(0, 20);
    const token = String(req.query.token || '').slice(0, 4000) || null;
    const skipCache = req.query.refresh === 'true';
    const result = await yt.channel(channelId, tab, token, skipCache);
    res.json(result);
  } catch (e) {
    console.error('yt:channel error', e.message);
    res.status(502).json({ error: 'channel unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/yt/playlist/:playlistId', authMiddleware, async (req, res) => {
  try {
    const playlistId = String(req.params.playlistId || '');
    if (!ID.test(playlistId) || playlistId.startsWith('VL')) {
      return res.status(400).json({ error: 'Invalid playlist id' });
    }
    const token = String(req.query.token || '').slice(0, 4000) || null;
    const skipCache = req.query.refresh === 'true';
    const result = await yt.playlist(playlistId, token, skipCache);
    res.json(result);
  } catch (e) {
    console.error('yt:playlist error', e.message);
    res.status(502).json({ error: 'playlist unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/yt/subfeed', authMiddleware, async (req, res) => {
  try {
    const ids = String(req.query.channels || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^UC[a-zA-Z0-9_-]{22}$/.test(s))
      .slice(0, 15);
    if (!ids.length) return res.json({ items: [], hasMore: false });
    const per = Math.max(1, Math.min(6, Number(req.query.per) || 4));
    const cap = Math.max(1, Math.min(40, Number(req.query.cap) || 24));
    const out = [];
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map(async (cid) => {
        try {
          const c = await yt.channel(cid, 'videos', null, true);
          const items = (c.items || []).filter((x) => x.type === 'video').slice(0, per);
          if (c.channelTitle || c.avatar) {
            items.forEach((x) => {
              x.channelId = cid;
              if (c.channelTitle) x.channel = x.channelTitle || c.channelTitle;
              if (c.avatar && !x.avatar) x.avatar = c.avatar;
            });
          }
          out.push(...items);
        } catch (e) {
          console.error(`yt:subfeed channel ${cid} error`, e.message);
        }
      }));
    }
    out.sort((a, b) => {
      const ta = Date.parse(a.publishedAt || '');
      const tb = Date.parse(b.publishedAt || '');
      if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
      return 0;
    });
    const seen = new Set();
    const items = [];
    for (const it of out) {
      if (!it.videoId || seen.has(it.videoId)) continue;
      seen.add(it.videoId);
      items.push(it);
      if (items.length >= cap) break;
    }
    res.json({ items, hasMore: false });
  } catch (e) {
    console.error('yt:subfeed error', e.message);
    res.status(502).json({ error: 'subfeed unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/yt/video/:videoId', authMiddleware, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '');
    if (!YTID.test(videoId)) return res.status(400).json({ error: 'Invalid video id' });
    const skipCache = req.query.refresh === 'true';
    const info = await yt.videoInfo(videoId, null, skipCache);
    const [sponsor, ryd, dearrow] = await Promise.all([
      yt.sponsorSegments(videoId),
      yt.dislikes(videoId).catch(() => null),
      yt.dearrow(videoId).catch(() => null),
    ]);
    info.sponsorSegments = sponsor;
    info.ryd = ryd;
    info.dearrow = dearrow;
    res.json(info);
  } catch (e) {
    console.error('yt:video error', e.message);
    res.status(502).json({ error: 'video unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/yt/related/:videoId', authMiddleware, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '');
    if (!YTID.test(videoId)) return res.status(400).json({ error: 'Invalid video id' });
    const token = String(req.query.token || '').slice(0, 4000) || null;
    if (!token) return res.status(400).json({ error: 'token is required' });
    res.json(await yt.videoInfo(videoId, token, true));
  } catch (e) {
    console.error('yt:related error', e.message);
    res.status(502).json({ error: 'related unavailable', detail: e.message.slice(0, 200) });
  }
});

app.get('/api/yt/sponsorblock/:videoId', authMiddleware, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '');
    if (!YTID.test(videoId)) return res.status(400).json({ error: 'Invalid video id' });
    res.json({ segments: await yt.sponsorSegments(videoId) });
  } catch (e) {
    console.error('yt:sponsorblock error', e.message);
    res.json({ segments: [] });
  }
});

app.get('/api/yt/dislikes/:videoId', authMiddleware, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '');
    if (!YTID.test(videoId)) return res.status(400).json({ error: 'Invalid video id' });
    const data = await yt.dislikes(videoId);
    if (!data) return res.json({ dislikes: null });
    res.json(data);
  } catch (e) {
    console.error('yt:dislikes error', e.message);
    res.json({ dislikes: null });
  }
});

// ---- Piped-backed Reels (Shorts) feed ---------------------------------------
// The Android Reels screen talks only to this backend; this service resolves
// metadata + stream URLs from a configurable Piped instance (see piped.js).
// No video bytes and no thumbnails are stored in Neon - streams are played
// directly from Piped/CDN via Media3/ExoPlayer on the device.

const piped = require('./piped');

app.get('/api/piped/categories', authMiddleware, (req, res) => {
  try {
    res.json({ categories: piped.categories() });
  } catch (e) {
    console.error('piped:categories error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/piped/feed', authMiddleware, async (req, res) => {
  try {
    const category = String(req.query.category || 'trending').slice(0, 30);
    const nextpage = String(req.query.nextpage || '').slice(0, 4000) || null;
    const refresh = String(req.query.refresh || '');
    const result = await piped.feed(category, nextpage, refresh);
    res.json({
      videos: result.items,
      category: result.category,
      nextpage: result.nextpage,
      hasMore: result.hasMore,
    });
  } catch (e) {
    console.error('piped:feed error', e.code || '', e.message);
    res.status(502).json({
      error: 'feed unavailable',
      code: e.code || null,
      detail: String(e.message || '').slice(0, 200),
    });
  }
});

app.get('/api/piped/streams/:videoId', authMiddleware, async (req, res) => {
  const videoId = String(req.params.videoId || '');
  try {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Invalid video id' });
    }
    const result = await piped.streams(videoId);
    res.json(result);
  } catch (e) {
    console.error('piped:streams error', videoId, e.code || '', e.message);
    res.status(502).json({
      error: 'streams unavailable',
      code: e.code || null,
      detail: String(e.message || '').slice(0, 200),
    });
  }
});

// Reels YouTube quota status endpoint
app.get('/api/reels/quota-status', authMiddleware, async (req, res) => {
  try {
    const { getQuotaStatus } = require('./youtube');
    const status = getQuotaStatus();
    res.json({
      quota: status,
      youtubeApiConfigured: !!process.env.YOUTUBE_API_KEY,
    });
  } catch (e) {
    console.error('reels:quota-status error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Diagnostics: the caller's own FCM token registrations (read-only, masked).
app.get('/api/devices/tokens', authMiddleware, async (req, res) => {
  try {
    const user = (await pool.query('SELECT id FROM users WHERE username = $1', [req.user.username])).rows[0];
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query(
      `SELECT id, platform, device_id,
              left(fcm_token, 16) || '...' AS fcm_token_masked,
              is_active, created_at, updated_at
       FROM device_tokens WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 10`,
      [user.id]
    );
    res.json({ tokens: result.rows });
  } catch (e) {
    console.error('devices:tokens diag error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Diagnostics: force an FCM push to the caller's OWN active tokens, regardless of
// online/socket state. Used to prove device-side rendering while the app is open.
app.post('/api/devices/tokens/sendtest', authMiddleware, async (req, res) => {
  try {
    const user = (await pool.query('SELECT id, username, display_name FROM users WHERE username = $1', [req.user.username])).rows[0];
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const tokensRes = await pool.query(
      `SELECT fcm_token FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
      [user.id]
    );
    const tokens = tokensRes.rows.map((r) => r.fcm_token);
    if (!tokens.length) return res.json({ ok: true, note: 'no active tokens registered', sent: false });

    const push = await sendPush({
      tokens,
      // Notification + data (true FCM notification): Android renders this in the tray
      // when the app is backgrounded/terminated, independent of the JS background handler.
      notification: {
        title: 'Tojey FCM Test',
        body: 'FCM reached your Android device.',
      },
      data: {
        type: 'tojey_diag',
        title: 'Tojey FCM Test',
        body: 'FCM reached your Android device.',
      },
    });
    if (push.invalidTokens.length) await deactivateTokens(push.invalidTokens);
    const masked = tokens.slice(0, 3).map(maskToken).join(', ');
    console.log(`[FCM] sendtest to user ${user.id}: tokens=${tokens.length} accepted-note=${push.success ? push.messageId || 'ok' : (push.note || 'failed')} invalid=${push.invalidTokens.length} tokens=${masked}${tokens.length > 3 ? '…' : ''}`);
    res.json({ ok: true, sent: push.success, tokens: tokens.length, accepted: push.success ? 1 : 0, invalid: push.invalidTokens.length, messageId: push.messageId || null, note: push.note, perToken: push.perToken || [] });
  } catch (e) {
    console.error('devices:sendtest error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const { displayName, bio, profilePic } = req.body;
    const fields = [];
    const values = [];
    if (displayName !== undefined) { values.push(displayName); fields.push(`display_name = $${values.length}`); }
    if (bio !== undefined) { values.push(bio); fields.push(`bio = $${values.length}`); }
    if (profilePic !== undefined) { values.push(profilePic); fields.push(`profile_pic_url = $${values.length}`); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.user.username);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE username = $${values.length} RETURNING id, username, display_name, bio, profile_pic_url`,
      values
    );
    const u = result.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    const updated = { id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, profilePic: u.profile_pic_url };
    res.json({ user: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Server-side online tracking: userId -> Set<socketId>.
// A user may have several live sockets (multiple devices/tabs). Presence in this map is the
// ONLY source of truth used to decide Socket.IO vs FCM routing. DB user_presence is a mirror
// for the REST /api/users listing. NOTE: this is in-memory and single-instance (see render.yaml).
const socketUserMap = new Map();

// Per-user "app is actually on the screen" state, reported by the clients when the mobile
// app backgrounds/foregrounds (socket event app:foreground / app:background). A user whose
// app is MINIMIZED still has a live socket, but they must get a real system notification via
// FCM - routing by socket presence alone misses exactly the backgrounded case.
const userActivityMap = new Map(); // userId -> true(foreground) | false(background)

// Per-device app state (multi-device): each device keeps its OWN foreground/background
// flag, so Phone1 on-screen gets Socket.IO-only delivery while Phone2 (same account,
// backgrounded) still receives a real FCM popup for the very same message.
const deviceStateMap = new Map(); // deviceId -> { state: 'foreground'|'background', seq, ts }
const deviceSockets = new Map();  // deviceId -> Set<socketId>
const socketToDevice = new Map(); // socketId -> deviceId

// A device is "foreground" only when it has a live socket AND last reported on-screen.
// Unknown/missing state defaults to foreground while a socket exists (a client that
// never sent app:foreground is either a legacy/desktop tab or still rendering - Socket.IO
// already delivered the message there, and the client dedups by id, so skipping FCM is safe).
// A foreground report is only trusted for FOREGROUND_TRUST_MS: an app whose process was
// killed by the OS/OEM (OPPO/ColorOS power manager) or a dropped network can leave a
// half-open socket that never disconnects. Treating that zombie as foreground suppressed
// FCM forever - silent notifications after the app looked closed. Open apps keep their
// report fresh with a ~30s heartbeat, so only dead/unreachable devices age out to FCM.
const FOREGROUND_TRUST_MS = 90 * 1000;
function deviceIsForeground(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return false;
  const sockets = deviceSockets.get(deviceId);
  if (!sockets || sockets.size === 0) return false;
  const st = deviceStateMap.get(deviceId);
  if (!st) return true;
  if (st.state !== 'foreground') return false;
  return Date.now() - st.ts <= FOREGROUND_TRUST_MS;
}

// Record a device's foreground/background report with out-of-order protection.
// Each device sends a monotonic seq (persisted across app restarts) so a stale
// duplicate (reconnect echo, two processes) can never downgrade a newer report.
// A background report may carry `keepAlive: true` - the device's foreground
// keep-alive service is running, so the socket stays connected and the CLIENT
// renders popups locally; the server then skips FCM for it.
function setDeviceState(deviceId, state, meta) {
  if (!deviceId || typeof deviceId !== 'string') return;
  const now = Date.now();
  const rawSeq = meta && meta.seq;
  let seq = -1;
  if (typeof rawSeq === 'number' && Number.isFinite(rawSeq)) seq = rawSeq;
  else if (typeof rawSeq === 'string' && /^\d+$/.test(rawSeq)) seq = parseInt(rawSeq, 10);
  const cur = deviceStateMap.get(deviceId);
  if (cur) {
    if (seq >= 0 && cur.seq >= 0 && seq <= cur.seq) return; // duplicate / out-of-order
    if (seq < 0 && now <= cur.ts) return;                   // legacy client, ts fallback
  }
  const keepAlive = state === 'background' && !!(meta && meta.keepAlive);
  deviceStateMap.set(deviceId, { state, seq, ts: now, keepAlive });
}

// A device with a live foreground keep-alive service: backgrounded but still connected,
// so the client renders message popups locally over the socket. Treat it like foreground
// for FCM purposes - sending a GMS popup too would double-notify.
function deviceHasKeepAlive(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return false;
  const sockets = deviceSockets.get(deviceId);
  if (!sockets || sockets.size === 0) return false;
  const st = deviceStateMap.get(deviceId);
  if (!st || st.state !== 'background' || !st.keepAlive) return false;
  return true;
}

function addDeviceSocket(socketId, deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return false;
  socketToDevice.set(socketId, deviceId);
  if (!deviceSockets.has(deviceId)) deviceSockets.set(deviceId, new Set());
  deviceSockets.get(deviceId).add(socketId);
  return true;
}

function removeDeviceSocket(socketId) {
  const deviceId = socketToDevice.get(socketId);
  if (!deviceId) return;
  socketToDevice.delete(socketId);
  const sockets = deviceSockets.get(deviceId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) {
      deviceSockets.delete(deviceId);
      // No live socket means this device cannot be foreground anymore; drop its last
      // state so a later message goes to FCM (the app re-reports on reconnect).
      deviceStateMap.delete(deviceId);
    }
  }
}

// True when the recipient should render in their open chat UI (socket) instead of a
// system notification. Unknown state defaults to foreground for backward compatibility.
function isUserForeground(userId) {
  const act = userActivityMap.get(userId);
  return act !== false;
}

function userSockets(userId) {
  return socketUserMap.get(userId) || new Set();
}

function addSocket(userId, socketId) {
  if (!socketUserMap.has(userId)) socketUserMap.set(userId, new Set());
  socketUserMap.get(userId).add(socketId);
}

function removeSocket(userId, socketId) {
  const set = socketUserMap.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) socketUserMap.delete(userId);
  return set.size === 0;
}

// Per-device FCM routing helper (also used by nudge + /api/notifications/send).
// Given the receiver's active device_tokens rows, returns the tokens that need an FCM
// push: every device that is NOT currently foreground-with-socket gets a popup. Tokens
// without a device_id (legacy registrations / web) fall back to the user-level rule.
function tokensNeedingFcm(rows, userId, legacyHasSocket) {
  const tokens = [];
  let phoneForeground = 0;
  let keepAliveSkip = 0;
  let legacySkip = 0;
  for (const r of rows) {
    if (!r || !r.fcm_token) continue;
    if (r.device_id) {
      if (deviceIsForeground(r.device_id)) { phoneForeground += 1; continue; }
      if (deviceHasKeepAlive(r.device_id)) { keepAliveSkip += 1; continue; }
      tokens.push({ token: r.fcm_token, platform: r.platform || 'android' });
    } else {
      // Legacy rows: keep the old behavior - skip FCM only when the whole user is
      // foreground (a live socket + an on-screen report on some device).
      if (legacyHasSocket && isUserForeground(userId)) { legacySkip += 1; continue; }
      tokens.push({ token: r.fcm_token, platform: r.platform || 'android' });
    }
  }
  return { tokens, phoneForeground, keepAliveSkip, legacySkip };
}

// Short human-readable preview for a chat message push (media/call/system friendly).
function messagePreview(message) {
  const t = message && message.type;
  const raw = typeof message.content === 'string' ? message.content.trim() : '';
  if (t === 'VOICE') return 'Voice message';
  if (t === 'IMAGE') return raw ? `Photo: ${raw}` : 'Photo';
  if (t === 'VIDEO') return raw ? `Video: ${raw}` : 'Video';
  if (t === 'FILE' || t === 'DOCUMENT') {
    const name = typeof message.file_name === 'string' && message.file_name ? `: ${message.file_name}` : '';
    return `File${name}`;
  }
  if (t === 'CALL') return raw || 'Video call';
  if (t === 'TEXT') return raw;
  return raw || 'New message';
}

// Deliver a push to every device of `userId` that is NOT foreground-with-socket
// (closed app / closed tab / backgrounded device); on-screen clients already got the
// message over the live socket. Platform-split so Android gets a REAL system-rendered
// notification (notification + data: Google Play Services draws the tray entry even
// when the app process is killed - the only reliable closed-app path on OPPO/ColorOS
// etc.) while web tokens stay data-only (the service worker renders its own popup).
// Fire-and-forget: never blocks the caller, never crashes the server.
async function pushFcmToUser(receiverUserId, online, notification, data) {
  const combined = { success: false, messageId: '', invalidTokens: [], note: '', perToken: [] };
  try {
    const tokensRes = await pool.query(
      `SELECT fcm_token, device_id, platform FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
      [receiverUserId]
    );
    const { tokens } = tokensNeedingFcm(tokensRes.rows, receiverUserId, online);
    if (!tokens.length) return combined;

    const android = tokens.filter(t => t.platform !== 'web');
    const web = tokens.filter(t => t.platform === 'web');
    if (android.length) {
      const p = await sendPush({ tokens: android.map(t => t.token), notification, data });
      combined.success = combined.success || p.success;
      combined.messageId = combined.messageId || p.messageId || '';
      combined.invalidTokens = combined.invalidTokens.concat(p.invalidTokens || []);
      combined.note = combined.note || p.note || '';
      combined.perToken = combined.perToken.concat(p.perToken || []);
    }
    if (web.length) {
      const p = await sendPush({ tokens: web.map(t => t.token), data });
      combined.success = combined.success || p.success;
      combined.messageId = combined.messageId || p.messageId || '';
      combined.invalidTokens = combined.invalidTokens.concat(p.invalidTokens || []);
      combined.note = combined.note || p.note || '';
      combined.perToken = combined.perToken.concat(p.perToken || []);
    }
    return combined;
  } catch (e) {
    console.error('pushFcmToUser error:', e && e.message);
    return combined;
  }
}

// WhatsApp-style FCM push for a received chat message / nudge. Fire-and-forget.
async function deliverFcmPush(receiverUserId, { notification, data }) {
  try {
    const online = userSockets(receiverUserId).size > 0;
    const push = await pushFcmToUser(receiverUserId, online, notification, data);
    if (push.invalidTokens && push.invalidTokens.length) {
      await deactivateTokens(push.invalidTokens);
    }
  } catch (e) {
    console.error('deliverFcmPush error:', e && e.message);
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = verifyToken(token);
  if (!user) return next(new Error('Unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', async (socket) => {
  const username = socket.user.username;

  try {
    const dbUserRow = (await pool.query('SELECT id, username, display_name, profile_pic_url FROM users WHERE username = $1', [username])).rows[0];
    if (!dbUserRow) {
      socket.emit('error', { message: 'User not found' });
      socket.disconnect();
      return;
    }
    const dbUser = {
      userId: dbUserRow.id,
      username: dbUserRow.username,
      displayName: dbUserRow.display_name,
      profile_pic_url: dbUserRow.profile_pic_url || '',
    };

    // Track every live socket for this user (multi-device / multi-tab support).
    addSocket(dbUser.userId, socket.id);

    // Per-device tracking: the handshake auth carries this device's stable id so the
    // FCM vs Socket.IO routing decision can be made independently for each device.
    const handshakeDeviceId =
      socket.handshake && socket.handshake.auth && typeof socket.handshake.auth.deviceId === 'string'
        ? socket.handshake.auth.deviceId
        : null;
    if (handshakeDeviceId) addDeviceSocket(socket.id, handshakeDeviceId);

    await pool.query(
      `INSERT INTO user_presence (user_id, is_online, last_seen, socket_id)
       VALUES ($1, TRUE, NOW(), $2)
       ON CONFLICT (user_id) DO UPDATE SET
         is_online = TRUE, last_seen = NOW(),
         socket_id = CASE
           WHEN user_presence.socket_id IS NULL THEN $2
           ELSE user_presence.socket_id
         END`,
      [dbUser.userId, socket.id]
    );

    socket.join(`user:${dbUser.userId}`);
    io.emit('presence:update', { userId: dbUser.userId, isOnline: true, displayName: dbUser.displayName, lastSeen: new Date().toISOString() });

    socket.emit('connected:ack', { userId: dbUser.userId, displayName: dbUser.displayName });

    // App foreground/background state (drives FCM vs Socket.IO routing for messages).
    socket.on('app:foreground', (meta) => {
      const deviceId = socketToDevice.get(socket.id) || (meta && meta.deviceId);
      if (deviceId) {
        // Multi-device path: track this device independently, ignore stale/duplicate reports.
        setDeviceState(deviceId, 'foreground', meta);
        return;
      }
      // Legacy client (no deviceId): keep the old user-level behavior.
      userActivityMap.set(dbUser.userId, true);
    });
    socket.on('app:background', (meta) => {
      const deviceId = socketToDevice.get(socket.id) || (meta && meta.deviceId);
      if (deviceId) {
        setDeviceState(deviceId, 'background', meta);
        return;
      }
      // Any live socket stopping means the UI is no longer on screen -> needs real
      // notifications. Only ever downgrade; a foreground report wins if it arrived late.
      if (userActivityMap.get(dbUser.userId) !== true) userActivityMap.set(dbUser.userId, false);
    });

    socket.on('conversation:open', async ({ otherUserId }) => {
      try {
        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);
        socket.emit('conversation:opened', { conversationId: convo.id, otherUserId });

        const msgs = await pool.query(
          `SELECT * FROM (
             SELECT m.*,
                    COALESCE((SELECT json_agg(r.*) FROM message_reactions r
                              WHERE r.message_id = m.id), '[]') AS reactions
             FROM messages m
             WHERE m.conversation_id = $1
               AND m.is_deleted_for_everyone = FALSE
             ORDER BY m.created_at DESC
             LIMIT 200
           ) sub
           ORDER BY created_at ASC`,
          [convo.id]
        );
        socket.emit('messages:history', msgs.rows);
      } catch (e) {
        console.error('conversation:open error', e);
      }
    });

    // Paginated older-history loader (scroll up for older messages). Returns the
    // `limit` oldest messages strictly older than `beforeId`.
    socket.on('messages:loadMore', async ({ otherUserId, beforeId, limit = 50 }, callback = () => {}) => {
      try {
        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);
        const beforeRaw = Number.parseInt(beforeId, 10);
        const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
        const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 10), 100);
        const msgs = await pool.query(
          `SELECT * FROM (
             SELECT m.*,
                    COALESCE((SELECT json_agg(r.*) FROM message_reactions r
                              WHERE r.message_id = m.id), '[]') AS reactions
             FROM messages m
             WHERE m.conversation_id = $1
               AND m.is_deleted_for_everyone = FALSE
               AND ($2::int IS NULL OR m.id < $2)
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT $3
           ) sub
           ORDER BY created_at ASC, id ASC`,
          [convo.id, before, lim]
        );
        callback({ ok: true, messages: msgs.rows, hasMore: msgs.rows.length === lim });
      } catch (e) {
        console.error('messages:loadMore error', e);
        callback({ error: e.message });
      }
    });

    // Incremental offline/reconnect sync: return ONLY the messages strictly newer than
    // `afterId` (ascending). A client that already cached messages 1..105 asks for
    // afterId=105 and gets 106.. up to `limit` instead of re-downloading the whole
    // conversation. Rows carry the full server state (reactions, is_edited, deletion)
    // so the merge step can update-in-place any message that changed while offline.
    socket.on('messages:after', async ({ otherUserId, afterId, limit = 200 }, callback = () => {}) => {
      try {
        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);
        const afterRaw = Number.parseInt(afterId, 10);
        const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : null;
        const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 10), 200);
        const msgs = await pool.query(
          `SELECT * FROM (
             SELECT m.*,
                    COALESCE((SELECT json_agg(r.*) FROM message_reactions r
                              WHERE r.message_id = m.id), '[]') AS reactions
             FROM messages m
             WHERE m.conversation_id = $1
               AND m.is_deleted_for_everyone = FALSE
               AND ($2::int IS NULL OR m.id > $2)
             ORDER BY m.id ASC
             LIMIT $3
           ) sub
           ORDER BY id ASC`,
          [convo.id, after, lim]
        );
        const sent = msgs.rows;
        callback({ ok: true, messages: sent, hasMore: sent.length >= lim, afterId: after });
      } catch (e) {
        console.error('messages:after error', e);
        callback({ error: e.message });
      }
    });

    socket.on('message:send', async (data, callback = () => {}) => {
      try {
        const { otherUserId, type = 'TEXT', content = '', mediaUrl = '', thumbUrl = '', duration = 0, waveform = '', replyTo = null, isViewOnce = false, transcript = '', fileName = '', fileSize = 0, mediaSize = 0, clientId = null } = data;

        if (!otherUserId) return callback({ error: 'otherUserId required' });

        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);

        // Idempotency: if this clientId was already saved (e.g. an offline-queued
        // send that reached the server twice), return the existing row instead of
        // inserting a duplicate.
        if (clientId) {
          const existing = await pool.query(
            'SELECT * FROM messages WHERE conversation_id = $1 AND client_id = $2',
            [convo.id, String(clientId)]
          );
          if (existing.rows.length) {
            const dup = existing.rows[0];
            if (!dup.reactions) dup.reactions = [];
            callback({ ok: true, message: dup, deduped: true });
            return;
          }
        }

        const result = await pool.query(
          `INSERT INTO messages
            (conversation_id, sender_id, reply_to, type, content, media_url, thumb_url,
             duration, waveform, transcript, status, is_view_once, created_at, file_name, media_size, client_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SENT', $11, NOW(), $12, $13, $14)
           RETURNING *`,
          [convo.id, dbUser.userId, replyTo, type, content, mediaUrl || null, thumbUrl || null,
           duration || 0, waveform || '', transcript || '', isViewOnce || false, fileName || '', fileSize || mediaSize || 0, clientId ? String(clientId) : null]
        );

        const message = result.rows[0];
        message.reactions = [];
        const dbProfilePic = dbUser.profile_pic_url || '';

        // Always deliver the message itself over the socket (both foreground AND
        // background clients; background clients persist it for when the UI returns).
        socket.to(`user:${otherUserId}`).emit('message:receive', {
          message,
          sender: { userId: dbUser.userId, displayName: dbUser.displayName, profilePic: dbProfilePic },
          conversationId: convo.id,
        });

        const receiverHasSocket = userSockets(otherUserId).size > 0;

        if (receiverHasSocket) {
          setTimeout(() => {
            io.to(`user:${dbUser.userId}`).emit('message:delivered', {
              messageId: message.id,
              userId: dbUser.userId,
            });
          }, 300);
        }

        // Push to every receiver device/tab that is NOT currently foreground-with-socket
        // (closed app, closed tab, backgrounded device), so messages pop like
        // WhatsApp/Messenger even when the app is not on screen. Android receives a true
        // system notification (rendered by Google Play Services, no app process needed);
        // web tokens get data-only because the service worker renders its own popup.
        deliverFcmPush(otherUserId, {
          notification: {
            title: dbUser.displayName || dbUser.username,
            body: messagePreview(message).slice(0, 140),
          },
          data: {
            type: 'tojey_chat',
            messageId: String(message.id),
            senderId: String(dbUser.userId),
            senderUsername: dbUser.username,
            senderName: dbUser.displayName || dbUser.username,
            senderPic: dbProfilePic,
            receiverId: String(otherUserId),
            conversationId: String(convo.id),
            msgType: message.type,
            msgPreview: messagePreview(message).slice(0, 140),
            body: messagePreview(message).slice(0, 140),
            title: dbUser.displayName || dbUser.username,
          },
        });

        callback({ ok: true, message });
      } catch (e) {
        console.error('message:send error', e);
        callback({ error: e.message });
      }
    });

    socket.on('message:read', async ({ messageIds, otherUserId }) => {
      try {
        const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
        for (const id of ids) {
          await pool.query(
            `UPDATE messages SET status = 'READ', read_at = NOW()
             WHERE id = $1 AND sender_id = $2`,
            [id, otherUserId]
          );
          await pool.query(
            `INSERT INTO read_receipts (message_id, user_id, read_at) VALUES ($1, $2, NOW())
             ON CONFLICT (message_id, user_id) DO NOTHING`,
            [id, dbUser.userId]
          );
        }
        socket.to(`user:${otherUserId}`).emit('message:read', {
          messageIds: ids,
          readerId: dbUser.userId,
        });
      } catch (e) {
        console.error('message:read error', e);
      }
    });

    socket.on('typing:start', ({ otherUserId }) => {
      socket.to(`user:${otherUserId}`).emit('typing:start', { userId: dbUser.userId });
    });

    socket.on('typing:stop', ({ otherUserId }) => {
      socket.to(`user:${otherUserId}`).emit('typing:stop', { userId: dbUser.userId });
    });

    // Nudge / "vibrate" ping: tells the other person's device to vibrate.
    socket.on('nudge', ({ otherUserId }) => {
      if (!otherUserId || String(otherUserId) === String(dbUser.userId)) return;
      const from = {
        userId: dbUser.userId,
        username: dbUser.username,
        displayName: dbUser.displayName,
        profilePic: dbUser.profile_pic_url || '',
      };
      socket.to(`user:${otherUserId}`).emit('nudge', { from });
      // Real push for nudges too when the recipient is not on screen (their app/device
      // vibrates + renders a tray entry even if closed). Same per-device routing as a
      // chat message; on-screen clients got the socket nudge already.
      deliverFcmPush(otherUserId, {
        notification: {
          title: dbUser.displayName || dbUser.username,
          body: '👋 nudged you!',
        },
        data: {
          type: 'tojey_nudge',
          senderId: String(dbUser.userId),
          senderUsername: dbUser.username,
          senderName: dbUser.displayName || dbUser.username,
          senderPic: dbUser.profile_pic_url || '',
          receiverId: String(otherUserId),
          title: dbUser.displayName || dbUser.username,
          body: '👋 nudged you!',
        },
      });
    });

    socket.on('message:edit', async ({ messageId, content }) => {
      try {
        await pool.query(
          "UPDATE messages SET content = $1, is_edited = TRUE WHERE id = $2 AND sender_id = $3",
          [content, messageId, dbUser.userId]
        );
        const msg = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
        const otherId = await getOtherId(msg, dbUser.userId);
        if (otherId) {
          socket.to(`user:${otherId}`).emit('message:edited', { messageId, content, senderId: dbUser.userId });
        }
        socket.emit('message:edited', { messageId, content, senderId: dbUser.userId });
      } catch (e) {
        console.error(e);
      }
    });

    socket.on('message:delete', async ({ messageId, mode }) => {
      try {
        const msg = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
        const otherId = await getOtherId(msg, dbUser.userId);
        if (mode === 'everyone') {
          if (msg && msg.media_url && msg.media_url.startsWith('/uploads/')) {
            await pool.query('DELETE FROM stored_media WHERE filename = $1', [msg.media_url.replace('/uploads/', '')]);
          }
          await pool.query(
            `UPDATE messages SET is_deleted_for_everyone = TRUE, content = NULL, media_url = NULL
             WHERE id = $1 AND sender_id = $2`,
            [messageId, dbUser.userId]
          );
          if (otherId) {
            socket.to(`user:${otherId}`).emit('message:deleted', { messageId, mode });
          }
        } else {
          await pool.query('DELETE FROM messages WHERE id = $1 AND sender_id = $2', [messageId, dbUser.userId]);
        }
        socket.emit('message:deleted', { messageId, mode });
      } catch (e) {
        console.error(e);
      }
    });

    socket.on('message:react', async ({ messageId, reaction }) => {
      try {
        if (reaction) {
          await pool.query(
            `INSERT INTO message_reactions (message_id, user_id, reaction) VALUES ($1, $2, $3)
             ON CONFLICT (message_id, user_id) DO UPDATE SET reaction = $3`,
            [messageId, dbUser.userId, reaction]
          );
        } else {
          await pool.query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [messageId, dbUser.userId]);
        }
        const msg = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
        const reactions = (await pool.query('SELECT * FROM message_reactions WHERE message_id = $1', [messageId])).rows;
        const otherId = await getOtherId(msg, dbUser.userId);
        io.to(`user:${otherId || ''}`).emit('message:reaction', { messageId, reactions, senderId: dbUser.userId });
        socket.emit('message:reaction', { messageId, reactions, senderId: dbUser.userId });
      } catch (e) {
        console.error(e);
      }
    });

    socket.on('conversation:list', async () => {
      try {
        const result = await pool.query(
          `SELECT c.id AS conversation_id,
                  CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END AS other_id,
                  u.display_name, u.username, u.profile_pic_url,
                  p.is_online, p.last_seen,
                  m.id AS message_id, m.type, m.content, m.created_at, m.sender_id, m.file_name, m.media_size
           FROM conversations c
           JOIN users u ON u.id = CASE WHEN c.user1_id = $1 THEN c.user2_id ELSE c.user1_id END
           LEFT JOIN user_presence p ON p.user_id = u.id
           LEFT JOIN LATERAL (
             SELECT * FROM messages ms
             WHERE ms.conversation_id = c.id AND ms.is_deleted_for_everyone = FALSE
             ORDER BY ms.created_at DESC LIMIT 1
           ) m ON TRUE
           WHERE c.user1_id = $1 OR c.user2_id = $1`,
          [dbUser.userId]
        );
        const list = result.rows.map((r) => ({
          conversationId: r.conversation_id,
          other: {
            id: r.other_id,
            username: r.username,
            display_name: r.display_name,
            profile_pic_url: r.profile_pic_url,
            isOnline: r.is_online,
            last_seen: r.last_seen,
          },
          lastMessage: r.message_id
            ? { id: r.message_id, type: r.type, content: r.content, created_at: r.created_at, sender_id: r.sender_id, file_name: r.file_name, media_size: r.media_size }
            : null,
        }));
        socket.emit('conversation:list', list);
      } catch (e) {
        console.error('conversation:list error', e);
      }
    });

    socket.on('conversation:clear', async ({ otherUserId }) => {
      try {
        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);
        const convoId = convo.id;
        await pool.query(
          `DELETE FROM stored_media WHERE filename IN (
             SELECT regexp_replace(media_url, '^/uploads/', '') FROM messages
             WHERE conversation_id = $1 AND media_url LIKE '/uploads/%'
           )`,
          [convoId]
        );
        await pool.query(
          `DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`,
          [convoId]
        );
        await pool.query(
          `DELETE FROM read_receipts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`,
          [convoId]
        );
        await pool.query(`DELETE FROM media WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`, [convoId]);
        await pool.query(`DELETE FROM voice_messages WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`, [convoId]);
        await pool.query(`DELETE FROM messages WHERE conversation_id = $1`, [convoId]);
        io.to(`user:${otherUserId}`).emit('conversation:cleared', { conversationId: convoId, userId: dbUser.userId });
        socket.emit('conversation:cleared', { conversationId: convoId });
      } catch (e) {
        console.error('conversation:clear error', e);
      }
    });

    socket.on('voice:transcribe', async ({ messageId }) => {
      try {
        const msg = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
        if (!msg) return;
        socket.emit('voice:transcribed', { messageId, transcript: mockTranscribe(msg.content) });
      } catch (e) {
        console.error(e);
      }
    });

    // --- Video-call signaling relay (1:1) ---
    // WebRTC media flows peer-to-peer; the server ONLY relays tiny JSON
    // (invite/accept/reject/offer/answer + ICE candidates) to the other user's
    // live socket. No media ever passes through here. All handlers run after the
    // socket auth middleware, so both ends are authenticated users.
    const relayVideo = (eventName, targetUserId, payload) => {
      socket.to(`user:${targetUserId}`).emit(eventName, payload);
    };
    const validTarget = (n) => Number.isInteger(n) && n > 0 && n !== dbUser.userId;

    // In-call presence: tells BOTH users' devices which of their chats is
    // currently in a call, so HomeScreen can show a WhatsApp-style "In a call"
    // subtitle under that conversation. Pure presence (no media/signaling).
    const broadcastCallPresence = (userA, userB, onCall) => {
      socket.to(`user:${userA}`).emit('video-call:presence', { targetUserId: userB, onCall: !!onCall });
      socket.to(`user:${userB}`).emit('video-call:presence', { targetUserId: userA, onCall: !!onCall });
    };

    socket.on('video-call:invite', ({ calleeId, callId }, callback = () => {}) => {
      const target = Number(calleeId);
      const id = String(callId || '');
      if (!Number.isInteger(target) || target <= 0) return callback({ error: 'calleeId required' });
      if (target === dbUser.userId) return callback({ error: 'Cannot call yourself' });
      if (!id) return callback({ error: 'callId required' });
      if (!userSockets(target).size) return callback({ error: 'offline' });
      relayVideo('video-call:invite', target, {
        callId: id,
        callerId: dbUser.userId,
        caller: {
          userId: dbUser.userId,
          username: dbUser.username,
          displayName: dbUser.displayName,
          profilePic: dbUser.profile_pic_url || '',
        },
      });
      broadcastCallPresence(dbUser.userId, target, true);
      callback({ ok: true, callId: id });
    });

    socket.on('video-call:accept', ({ targetUserId, callId }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id) return;
      relayVideo('video-call:accept', target, { callId: id, calleeId: dbUser.userId });
      broadcastCallPresence(dbUser.userId, target, true);
    });

    socket.on('video-call:reject', ({ targetUserId, callId }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id) return;
      relayVideo('video-call:reject', target, { callId: id, calleeId: dbUser.userId });
      broadcastCallPresence(dbUser.userId, target, false);
    });

    socket.on('video-call:offer', ({ targetUserId, callId, offer }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id || !offer) return;
      relayVideo('video-call:offer', target, { callId: id, offer });
    });

    socket.on('video-call:answer', ({ targetUserId, callId, answer }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id || !answer) return;
      relayVideo('video-call:answer', target, { callId: id, answer });
    });

    socket.on('video-call:ice-candidate', ({ targetUserId, callId, candidate }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id || !candidate) return;
      relayVideo('video-call:ice-candidate', target, { callId: id, candidate });
    });

    socket.on('video-call:end', ({ targetUserId, callId }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id) return;
      relayVideo('video-call:end', target, { callId: id, endedBy: dbUser.userId });
      broadcastCallPresence(dbUser.userId, target, false);
    });

    socket.on('disconnect', async () => {
      removeDeviceSocket(socket.id);
      const wasTracked = userSockets(dbUser.userId).has(socket.id);
      const nowOffline = removeSocket(dbUser.userId, socket.id);

      // A socket that never completed setup may still fire disconnect - ignore it.
      if (!wasTracked) return;

      try {
        if (nowOffline) {
          // No remaining sockets for this user -> offline.
          await pool.query(
            `UPDATE user_presence SET is_online = FALSE, last_seen = NOW(), typing_to = NULL, socket_id = NULL
             WHERE user_id = $1`,
            [dbUser.userId]
          );
          const p = (await pool.query('SELECT last_seen FROM user_presence WHERE user_id = $1', [dbUser.userId])).rows[0];
          io.emit('presence:update', { userId: dbUser.userId, isOnline: false, lastSeen: p ? p.last_seen : new Date().toISOString() });
        } else {
          // User still has other active sockets - stay online.
          await pool.query('UPDATE user_presence SET last_seen = NOW() WHERE user_id = $1', [dbUser.userId]);
        }
      } catch (e) {
        console.error('presence update on disconnect failed', e.message);
      }
    });
  } catch (e) {
    console.error('connection setup error', e);
    socket.disconnect();
  }
});

async function getOtherId(msg, myId) {
  if (!msg) return null;
  const convo = (await pool.query('SELECT * FROM conversations WHERE id = $1', [msg.conversation_id])).rows[0];
  if (!convo) return null;
  return convo.user1_id === myId ? convo.user2_id : convo.user1_id;
}

async function getOrCreateConversation(userId, otherUserId) {
  // Always order user IDs consistently to prevent duplicate conversations
  const [user1, user2] = userId < otherUserId ? [userId, otherUserId] : [otherUserId, userId];

  const existing = await pool.query(
    `SELECT * FROM conversations WHERE user1_id = $1 AND user2_id = $2`,
    [user1, user2]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
    [user1, user2]
  );

  if (result.rows.length > 0) return result.rows[0];
  return (await pool.query(
    `SELECT * FROM conversations WHERE user1_id = $1 AND user2_id = $2`,
    [user1, user2]
  )).rows[0];
}

function mockTranscribe(seed) {
  return 'This is a placeholder transcription of the voice message.';
}

if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
  app.get(/^\/(?!api|socket\.io|uploads).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

initDB().then(() => {
  logFcmStartupStatus();
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🟣 Tojey backend running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
});

module.exports = { server, io };
