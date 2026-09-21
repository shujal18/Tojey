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

    // FCM is sent to every device that is NOT currently foreground-with-socket, so a
    // backgrounded second device of a connected user still gets its popup (multi-device).
    const tokensRes = await pool.query(
      `SELECT fcm_token, device_id FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
      [receiver.id]
    );
    const { tokens } = tokensNeedingFcm(tokensRes.rows, receiver.id, online);

    if (!tokens.length) {
      if (online) {
        return res.json({ ok: true, notification: notif, deliveryMethod: 'socket', status: notif.status });
      }
      const updated = (await pool.query(
        `UPDATE notifications SET status = 'failed', delivered_at = NULL WHERE id = $1 RETURNING *`,
        [notif.id]
      )).rows[0];
      return res.json({ ok: true, notification: updated, deliveryMethod: 'fcm', status: 'failed', note: 'receiver has no registered device token', fcmNote: 'no-token' });
    }

    const push = await sendPush({
      tokens,
      // Notification + data: the `notification` payload lets Android's FCM client
      // render the tray notification itself when the app is backgrounded/terminated,
      // so we never depend on React Native JS waking up to show it. The `data`
      // payload carries conversationId/senderId for open-chat navigation on tap.
      notification: {
        title: `${sender.display_name || sender.username} • Tojey`,
        body,
      },
      data: {
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
      },
    });
    console.log(`[FCM] offline push to user ${receiver.id}: tokens=${tokens.length} invalid=${push.invalidTokens.length} success=${push.success}`);

    if (push.invalidTokens.length) {
      await deactivateTokens(push.invalidTokens);
    }

    const status = push.success ? 'sent' : 'failed';
    const updated = (await pool.query(
      `UPDATE notifications SET status = $1, delivered_at = $2, fcm_message_id = $3 WHERE id = $4 RETURNING *`,
      [status, push.success ? new Date() : null, push.messageId || null, notif.id]
    )).rows[0];

    return res.json({
      ok: true,
      notification: updated,
      deliveryMethod: online ? 'socket' : 'fcm',
      status: updated.status,
      note: push.success ? (push.invalidTokens.length ? `deactivated ${push.invalidTokens.length} invalid token(s)` : undefined) : (push.note || 'delivery failed'),
      fcmNote: push.note, // 'fcm-unconfigured', 'fcm-rejected', 'fcm-error' - helps client distinguish failure type
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

// Reels feed endpoint - returns short video metadata from YouTube via backend proxy
app.get('/api/reels/feed', authMiddleware, async (req, res) => {
  try {
    const { category = 'trending', refresh = 'false', pageToken } = req.query;
    const validCategories = [
      'trending', 'love', 'comedy', 'funny', 'education',
      'motivation', 'nepali', 'hindi', 'foreign', 'music', 'memes'
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
      { id: 'trending', label: 'Trending' },
      { id: 'love', label: 'Love' },
      { id: 'comedy', label: 'Comedy' },
      { id: 'funny', label: 'Funny' },
      { id: 'education', label: 'Education' },
      { id: 'motivation', label: 'Motivation' },
      { id: 'nepali', label: 'Nepali' },
      { id: 'hindi', label: 'Hindi' },
      { id: 'foreign', label: 'Foreign' },
      { id: 'music', label: 'Music' },
      { id: 'memes', label: 'Memes' },
    ];
    res.json({ categories });
  } catch (e) {
    console.error('reels:categories error', e.message);
    res.status(500).json({ error: 'Server error' });
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
function deviceIsForeground(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return false;
  const sockets = deviceSockets.get(deviceId);
  if (!sockets || sockets.size === 0) return false;
  const st = deviceStateMap.get(deviceId);
  return !st || st.state === 'foreground';
}

// Record a device's foreground/background report with out-of-order protection.
// Each device sends a monotonic seq (persisted across app restarts) so a stale
// duplicate (reconnect echo, two processes) can never downgrade a newer report.
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
  deviceStateMap.set(deviceId, { state, seq, ts: now });
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
  let legacySkip = 0;
  for (const r of rows) {
    if (!r || !r.fcm_token) continue;
    if (r.device_id) {
      if (deviceIsForeground(r.device_id)) { phoneForeground += 1; continue; }
      tokens.push(r.fcm_token);
    } else {
      // Legacy rows: keep the old behavior - skip FCM only when the whole user is
      // foreground (a live socket + an on-screen report on some device).
      if (legacyHasSocket && isUserForeground(userId)) { legacySkip += 1; continue; }
      tokens.push(r.fcm_token);
    }
  }
  return { tokens, phoneForeground, legacySkip };
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
    let dbUser = (await pool.query('SELECT id, username, display_name, profile_pic_url FROM users WHERE username = $1', [username])).rows[0];
    if (!dbUser) {
      socket.emit('error', { message: 'User not found' });
      socket.disconnect();
      return;
    }
    dbUser = { userId: dbUser.id, username: dbUser.username, displayName: dbUser.display_name };

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

        // Chat routing is driven by the receiver's EXPLICIT app state (reported via
        // app:foreground / app:background socket events), never by socket presence alone.
        // With multi-device support the decision is PER DEVICE:
        //   foreground + socket        -> live chat UI is on screen: Socket.IO only (no popup)
        //   minimized (socket alive)   -> app backgrounded: real FCM popup (notification+data)
        //   terminated / offline       -> no socket at all: real FCM popup rendered natively
        // A minimized-but-connected device was previously treated as "online" and silently
        // missed every chat message. The socket delivery below still runs for backgrounded
        // devices so the message persists when the UI returns (deduped by id on receipt).
        const receiverHasSocket = userSockets(otherUserId).size > 0;
        const socketOnly = receiverHasSocket && isUserForeground(otherUserId);
        try {
          const tokensRes = await pool.query(
            `SELECT fcm_token, device_id FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
            [otherUserId]
          );
          const { tokens, phoneForeground, legacySkip } = tokensNeedingFcm(tokensRes.rows, otherUserId, receiverHasSocket);
          if (tokens.length) {
            const msgPreview = String(content || '')
              || (type === 'VOICE' ? 'Voice message'
                : type === 'IMAGE' ? 'Photo'
                : type === 'VIDEO' ? 'Video'
                : (type === 'FILE' || type === 'DOCUMENT') ? 'File'
                : '');
            // notification+data: when the process is backgrounded or dead, Android's FCM
            // client renders the tray popup itself (no dependence on JS waking up), and the
            // `data` payload carries the ids the app needs to open the exact conversation
            // on tap. `body` stays as the raw content so a foreground data handler (race
            // only) can render without the auto-tray duplicate.
            const push = await sendPush({
              tokens,
              notification: {
                title: `${dbUser.displayName || dbUser.username} • Tojey`,
                body: msgPreview,
              },
              data: {
                type: 'tojey_chat',
                conversationId: String(convo.id),
                messageId: String(message.id),
                senderId: String(dbUser.userId),
                senderUsername: dbUser.username,
                senderName: dbUser.displayName || dbUser.username,
                senderPic: dbProfilePic || '',
                receiverId: String(otherUserId),
                msgType: String(type),
                msgPreview,
                body: String(content || ''),
              },
            });
            console.log(`[FCM] chat push to user ${otherUserId}: devices=${tokens.length} fg-skipped=${phoneForeground} legacy-skipped=${legacySkip} invalid=${push.invalidTokens.length} success=${push.success}`);
            if (push.invalidTokens.length) await deactivateTokens(push.invalidTokens);
          } else {
            console.log(`[DELIVERY] chat to user ${otherUserId}: no FCM needed (fg-phones=${phoneForeground} legacy-skipped=${legacySkip}) socketOnly=${socketOnly}`);
          }
        } catch (pushErr) {
          console.error('[FCM] chat push failed:', pushErr.message);
        }

        if (receiverHasSocket) {
          setTimeout(() => {
            io.to(`user:${dbUser.userId}`).emit('message:delivered', {
              messageId: message.id,
              userId: dbUser.userId,
            });
          }, 300);
        }

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
    // Works online (socket) AND offline (real FCM push so the tray notification
    // vibrates even when the app is closed).
    socket.on('nudge', async ({ otherUserId }) => {
      if (!otherUserId || String(otherUserId) === String(dbUser.userId)) return;
      const from = {
        userId: dbUser.userId,
        username: dbUser.username,
        displayName: dbUser.displayName,
        profilePic: dbUser.profile_pic_url || '',
      };
      socket.to(`user:${otherUserId}`).emit('nudge', { from });

      // Only recipients who are online AND on-screen get the socket nudge alone.
      // Backgrounded/offline devices get a real FCM notification (with vibration).
      const hasSocket = userSockets(otherUserId).size > 0;
      if (hasSocket && isUserForeground(otherUserId)) return;

      try {
        const tokensRes = await pool.query(
          `SELECT fcm_token, device_id FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
          [otherUserId]
        );
        const { tokens } = tokensNeedingFcm(tokensRes.rows, otherUserId, hasSocket);
        if (!tokens.length) return;
        // Carry the conversation id (if one exists) so tapping the nudge notification
        // can open the exact chat instead of falling back to the sender.
        const convo = (await pool.query(
          `SELECT id FROM conversations
           WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
          [dbUser.userId, otherUserId]
        )).rows[0];
        const banner = '👋 nudged you!';
        const push = await sendPush({
          tokens,
          // Deliberately DATA-ONLY (no `notification` payload). Android renders any
          // `notification` payload in the tray by itself and never invokes the app's
          // headless JS handler - which is exactly where the strong nudge vibrate
          // pattern + chat head bubble run. Data-only FCM reaches the background
          // handler even when the app is minimized / screen off, so the nudge always
          // buzzes with the real pattern instead of a generic tray vibration.
          data: {
            type: 'tojey_nudge',
            id: `nudge-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
            senderId: String(dbUser.userId),
            senderUsername: dbUser.username,
            senderName: dbUser.displayName || dbUser.username,
            senderPic: dbUser.profile_pic_url || '',
            receiverId: String(otherUserId),
            conversationId: convo ? String(convo.id) : undefined,
            title: dbUser.displayName || dbUser.username,
            body: banner,
            nudge: '1',
          },
        });
        console.log(`[FCM] nudge push for user ${otherUserId}: tokens=${tokens.length} invalid=${push.invalidTokens.length} success=${push.success}`);
        if (push.invalidTokens.length) await deactivateTokens(push.invalidTokens);
      } catch (pushErr) {
        console.error('[FCM] nudge push failed:', pushErr.message);
      }
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
      callback({ ok: true, callId: id });
    });

    socket.on('video-call:accept', ({ targetUserId, callId }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id) return;
      relayVideo('video-call:accept', target, { callId: id, calleeId: dbUser.userId });
    });

    socket.on('video-call:reject', ({ targetUserId, callId }) => {
      const target = Number(targetUserId);
      if (!validTarget(target)) return;
      const id = String(callId || '');
      if (!id) return;
      relayVideo('video-call:reject', target, { callId: id, calleeId: dbUser.userId });
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
