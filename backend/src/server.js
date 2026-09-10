require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { initDB, pool } = require('./db');
const { signToken, verifyToken, authenticate, authMiddleware } = require('./auth');
const { sendPush, deactivateTokens } = require('./fcm');
const path = require('path');
const { upload } = require('./media');

// Human-friendly one-line summary used as the FCM notification body.
function messageSummary(m) {
  if (!m) return '';
  if (m.is_view_once) {
    if (m.type === 'IMAGE' || m.type === 'VIDEO') return 'Sent you a photo/video (view once)';
    return 'Sent you a view-once message';
  }
  switch (m.type) {
    case 'TEXT':
      return String(m.content || '').slice(0, 160);
    case 'IMAGE':
      return 'Sent you a photo';
    case 'VIDEO':
      return 'Sent you a video';
    case 'VOICE':
      return 'Sent you a voice message';
    case 'FILE':
    case 'DOCUMENT':
      return m.file_name ? `Sent you a file: ${String(m.file_name).slice(0, 80)}` : 'Sent you a file';
    default:
      return 'Sent you a message';
  }
}

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
});

app.get('/', (req, res) => res.json({ app: 'Tojey', status: 'running' }));

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

    const { token } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token is required' });
    }

    await pool.query(
      `UPDATE device_tokens SET is_active = FALSE, updated_at = NOW()
       WHERE fcm_token = $1 AND user_id = $2`,
      [token.trim(), user.id]
    );

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
      // Deliver to every active socket of the receiver. FCM is intentionally NOT used.
      io.to(`user:${receiver.id}`).emit('notification:receive', {
        notification: notif,
        conversationId: convo.id,
        sender: { userId: sender.id, username: sender.username, displayName: sender.display_name, profilePic: sender.profile_pic_url || '' },
      });
      return res.json({ ok: true, notification: notif, deliveryMethod: 'socket', status: notif.status });
    }

    // Offline: send via FCM to every registered device token of the receiver.
    const tokensRes = await pool.query(
      `SELECT fcm_token FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
      [receiver.id]
    );
    const tokens = tokensRes.rows.map((r) => r.fcm_token);

    if (!tokens.length) {
      const updated = (await pool.query(
        `UPDATE notifications SET status = 'failed', delivered_at = NULL WHERE id = $1 RETURNING *`,
        [notif.id]
      )).rows[0];
      return res.json({ ok: true, notification: updated, deliveryMethod: 'fcm', status: 'failed', note: 'receiver has no registered device token' });
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
        receiverId: String(receiver.id),
        conversationId: String(convo.id),
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
      deliveryMethod: 'fcm',
      status: updated.status,
      note: push.success ? (push.invalidTokens.length ? `deactivated ${push.invalidTokens.length} invalid token(s)` : undefined) : (push.note || 'delivery failed'),
    });
  } catch (e) {
    console.error('notifications:send error', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, display_name, bio, profile_pic_url FROM users WHERE username = $1`,
      [req.user.username]
    );
    const u = result.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ id: u.id, username: u.username, displayName: u.display_name, bio: u.bio, profilePic: u.profile_pic_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.json({ ok: true, sent: push.success, tokens: tokens.length, accepted: push.success ? 1 : 0, invalid: push.invalidTokens.length, messageId: push.messageId || null, note: push.note });
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

    socket.on('message:send', async (data, callback = () => {}) => {
      try {
        const { otherUserId, type = 'TEXT', content = '', mediaUrl = '', thumbUrl = '', duration = 0, waveform = '', replyTo = null, isViewOnce = false, transcript = '', fileName = '', fileSize = 0, mediaSize = 0 } = data;

        if (!otherUserId) return callback({ error: 'otherUserId required' });

        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);
        const result = await pool.query(
          `INSERT INTO messages
            (conversation_id, sender_id, reply_to, type, content, media_url, thumb_url,
             duration, waveform, transcript, status, is_view_once, created_at, file_name, media_size)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SENT', $11, NOW(), $12, $13)
           RETURNING *`,
          [convo.id, dbUser.userId, replyTo, type, content, mediaUrl || null, thumbUrl || null,
           duration || 0, waveform || '', transcript || '', isViewOnce || false, fileName || '', fileSize || mediaSize || 0]
        );

        const message = result.rows[0];
        message.reactions = [];
        const dbProfilePic = dbUser.profile_pic_url || '';

        socket.to(`user:${otherUserId}`).emit('message:receive', {
          message,
          sender: { userId: dbUser.userId, displayName: dbUser.displayName, profilePic: dbProfilePic },
          conversationId: convo.id,
        });

        const deliverTo = userSockets(otherUserId).size > 0;
        if (deliverTo) {
          setTimeout(() => {
            io.to(`user:${dbUser.userId}`).emit('message:delivered', {
              messageId: message.id,
              userId: dbUser.userId,
            });
          }, 300);
        } else {
          // Receiver has no active socket (background/terminated/minimized): send a
          // real FCM notification+data push so Android's own client renders the tray
          // notification. Never fall back to JS-wake-up-rendered pushes.
          try {
            const tokensRes = await pool.query(
              `SELECT fcm_token FROM device_tokens WHERE user_id = $1 AND is_active = TRUE AND fcm_token IS NOT NULL`,
              [otherUserId]
            );
            const tokens = tokensRes.rows.map((r) => r.fcm_token);
            if (tokens.length) {
              const banner = messageSummary(message);
              const push = await sendPush({
                tokens,
                notification: {
                  title: dbUser.displayName || dbUser.username,
                  body: banner,
                },
                data: {
                  type: 'tojey_notification',
                  notificationId: String(message.id),
                  id: String(message.id),
                  senderId: String(dbUser.userId),
                  senderUsername: dbUser.username,
                  senderName: dbUser.displayName || dbUser.username,
                  receiverId: String(otherUserId),
                  conversationId: String(convo.id),
                  body: banner,
                },
              });
              console.log(`[FCM] chat push for offline user ${otherUserId}: tokens=${tokens.length} invalid=${push.invalidTokens.length} success=${push.success}`);
              if (push.invalidTokens.length) await deactivateTokens(push.invalidTokens);
            } else {
              console.log(`[FCM] offline user ${otherUserId} has no registered tokens - skipping push`);
            }
          } catch (pushErr) {
            // Never break message delivery because the push failed.
            console.error('[FCM] chat push failed:', pushErr.message);
          }
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

    socket.on('disconnect', async () => {
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
  const PORT = process.env.PORT || 5000;
  server.listen(PORT, () => {
    console.log(`🟣 Tojey backend running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
});

module.exports = { server, io };
