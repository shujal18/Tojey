require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { initDB, pool } = require('./db');
const { signToken, verifyToken, authenticate, authMiddleware } = require('./auth');
const path = require('path');
const { upload } = require('./media');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

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
    const relative = `/uploads/${req.file.path.split('uploads')[1].replace(/\\/g, '/')}`;
    res.json({
      url: relative,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

const socketUserMap = {};

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
    let dbUser = (await pool.query('SELECT id, username, display_name FROM users WHERE username = $1', [username])).rows[0];
    if (!dbUser) {
      socket.emit('error', { message: 'User not found' });
      socket.disconnect();
      return;
    }
    dbUser = { userId: dbUser.id, username: dbUser.username, displayName: dbUser.display_name };

    socketUserMap[dbUser.userId] = socket.id;

    await pool.query(
      `INSERT INTO user_presence (user_id, is_online, last_seen, socket_id)
       VALUES ($1, TRUE, NOW(), $2)
       ON CONFLICT (user_id) DO UPDATE SET is_online = TRUE, last_seen = NOW(), socket_id = $2`,
      [dbUser.userId, socket.id]
    );

    socket.join(`user:${dbUser.userId}`);
    io.emit('presence:update', { userId: dbUser.userId, isOnline: true, displayName: dbUser.displayName });

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
        const { otherUserId, type = 'TEXT', content = '', mediaUrl = '', thumbUrl = '', duration = 0, waveform = '', replyTo = null, isViewOnce = false, transcript = '' } = data;

        if (!otherUserId) return callback({ error: 'otherUserId required' });

        const convo = await getOrCreateConversation(dbUser.userId, otherUserId);
        const result = await pool.query(
          `INSERT INTO messages
            (conversation_id, sender_id, reply_to, type, content, media_url, thumb_url,
             duration, waveform, transcript, status, is_view_once, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SENT', $11, NOW())
           RETURNING *`,
          [convo.id, dbUser.userId, replyTo, type, content, mediaUrl || null, thumbUrl || null,
           duration || 0, waveform || '', transcript || '', isViewOnce || false]
        );

        const message = result.rows[0];
        message.reactions = [];

        socket.to(`user:${otherUserId}`).emit('message:receive', {
          message,
          sender: { userId: dbUser.userId, displayName: dbUser.displayName },
          conversationId: convo.id,
        });

        const deliverTo = socketUserMap[otherUserId];
        if (deliverTo) {
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
      delete socketUserMap[dbUser.userId];
      await pool.query(
        `UPDATE user_presence SET is_online = FALSE, last_seen = NOW(), typing_to = NULL WHERE user_id = $1`,
        [dbUser.userId]
      );
      io.emit('presence:update', { userId: dbUser.userId, isOnline: false });
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
  const existing = await pool.query(
    `SELECT * FROM conversations
     WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
    [userId, otherUserId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING *`,
    [userId, otherUserId]
  );

  if (result.rows.length > 0) return result.rows[0];
  return (await pool.query(
    `SELECT * FROM conversations
     WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)`,
    [userId, otherUserId]
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
