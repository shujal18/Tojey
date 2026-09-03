const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  bio TEXT DEFAULT '',
  profile_pic_url TEXT DEFAULT '',
  status VARCHAR(50) DEFAULT 'offline',
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  user1_id INTEGER NOT NULL REFERENCES users(id),
  user2_id INTEGER NOT NULL REFERENCES users(id),
  wallpaper_url TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user1_id, user2_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  reply_to INTEGER REFERENCES messages(id),
  type VARCHAR(20) DEFAULT 'TEXT',
  content TEXT,
  media_url TEXT,
  thumb_url TEXT,
  media_width INTEGER,
  media_height INTEGER,
  media_size BIGINT,
  duration INTEGER,
  waveform TEXT,
  transcript TEXT,
  status VARCHAR(20) DEFAULT 'SENT',
  is_view_once BOOLEAN DEFAULT FALSE,
  is_edited BOOLEAN DEFAULT FALSE,
  is_deleted_for_everyone BOOLEAN DEFAULT FALSE,
  reaction TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS message_reactions (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reaction VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);

CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL,
  url TEXT NOT NULL,
  thumb_url TEXT,
  original_url TEXT,
  size BIGINT,
  mime_type VARCHAR(100),
  quality VARCHAR(20) DEFAULT 'STANDARD',
  is_view_once BOOLEAN DEFAULT FALSE,
  viewed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voice_messages (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  duration INTEGER NOT NULL,
  waveform TEXT,
  transcript TEXT,
  size BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  is_online BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  socket_id TEXT,
  typing_to INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  fcm_token TEXT UNIQUE,
  platform VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS read_receipts (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  read_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  theme VARCHAR(20) DEFAULT 'system',
  font_size INTEGER DEFAULT 16,
  last_seen_privacy VARCHAR(20) DEFAULT 'everyone',
  read_receipts BOOLEAN DEFAULT TRUE,
  wallpaper_url TEXT DEFAULT '',
  wallpapers TEXT DEFAULT '{}',
  notifications_enabled BOOLEAN DEFAULT TRUE,
  sound_enabled BOOLEAN DEFAULT TRUE,
  vibration_enabled BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
`;

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    console.log('✓ Database initialized');
    await seedUsers(client);
  } finally {
    client.release();
  }
}

const { hashSync } = require('bcryptjs');

async function seedUsers(client) {
  const users = [
    { username: 'tom', password: 'tom18', display_name: 'Tom' },
    { username: 'jerry', password: 'jerry22', display_name: 'Jerry' },
  ];

  for (const u of users) {
    const exists = await client.query('SELECT id FROM users WHERE username = $1', [u.username]);
    if (exists.rows.length === 0) {
      const passwordHash = hashSync(u.password, 10);
      await client.query(
        'INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3)',
        [u.username, passwordHash, u.display_name]
      );
      console.log(`✓ Account created: ${u.username}`);
    }
  }

  const res = await client.query('SELECT id, username FROM users');
  const userMap = {};
  res.rows.forEach(r => { userMap[r.username] = r.id; });

  if (userMap.tom && userMap.jerry) {
    await client.query(
      'INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userMap.tom, userMap.jerry]
    );
    console.log('✓ Tom-Jerry conversation created');
  }
}

module.exports = { pool, initDB };
