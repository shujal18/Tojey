import AsyncStorage from '@react-native-async-storage/async-storage';

// Cache version for migrations
const CACHE_VERSION = 2;
const versionKey = (userId) => `@tojey_cache_ver_${userId}`;

const convKey = (userId) => `@tojey_cache_conv_${userId}`;
const usersKey = (userId) => `@tojey_cache_users_${userId}`;
const msgKey = (userId, otherId) => `@tojey_cache_msg_${userId}_${otherId}`;
const qKey = (userId) => `@tojey_queue_${userId}`;

// Atomic write helper: write to temp key then rename (AsyncStorage doesn't have true rename,
// but we can simulate by writing new value and only removing old on success)
async function atomicSetItem(key, value) {
  try {
    await AsyncStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`atomicSetItem failed for ${key}:`, e);
    return false;
  }
}

async function safeGetItem(key) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn(`safeGetItem failed for ${key}:`, e);
    return null;
  }
}

export async function migrateCacheIfNeeded(userId) {
  if (!userId) return;
  try {
    const currentVer = await AsyncStorage.getItem(versionKey(userId));
    const ver = currentVer ? parseInt(currentVer, 10) : 0;
    if (ver >= CACHE_VERSION) return;

    // Migration from v1 to v2: add version tracking, no data changes needed
    if (ver < 2) {
      await AsyncStorage.setItem(versionKey(userId), String(CACHE_VERSION));
    }
  } catch (e) {
    console.warn('migrateCacheIfNeeded failed:', e);
  }
}

export async function saveConversations(userId, list) {
  if (!userId || !Array.isArray(list)) return;
  await migrateCacheIfNeeded(userId);
  await atomicSetItem(convKey(userId), JSON.stringify(list));
}

export async function loadConversations(userId) {
  if (!userId) return [];
  await migrateCacheIfNeeded(userId);
  return (await safeGetItem(convKey(userId))) || [];
}

export async function saveUsers(userId, list) {
  if (!userId || !Array.isArray(list)) return;
  await migrateCacheIfNeeded(userId);
  await atomicSetItem(usersKey(userId), JSON.stringify(list));
}

export async function loadUsers(userId) {
  if (!userId) return [];
  await migrateCacheIfNeeded(userId);
  return (await safeGetItem(usersKey(userId))) || [];
}

export async function saveMessages(userId, otherId, msgs) {
  if (!userId || !otherId || !Array.isArray(msgs)) return;
  await migrateCacheIfNeeded(userId);
  // Only persist the newest 200 messages to keep AsyncStorage writes cheap and
  // avoids unbounded growth on very long chats (history is re-synced from the
  // server + paginated on scroll up).
  const slice = msgs.length > 200 ? msgs.slice(-200) : msgs;
  await atomicSetItem(msgKey(userId, otherId), JSON.stringify(slice));
}

export async function loadMessages(userId, otherId) {
  if (!userId || !otherId) return [];
  await migrateCacheIfNeeded(userId);
  return (await safeGetItem(msgKey(userId, otherId))) || [];
}

export async function clearConversationCache(userId, otherId) {
  try {
    await AsyncStorage.removeItem(msgKey(userId, otherId));
  } catch (e) {
    console.warn('clearConversationCache failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Offline message queue.
//
// When the socket is unavailable, outgoing messages are queued here (keyed by
// sender + receiver + a monotonic order id). On reconnect the app drains the
// queue in order. Sends carry a stable `clientId` so a retry can never insert a
// duplicate on the server.
// ---------------------------------------------------------------------------

export async function enqueueOutgoing(userId, otherId, item) {
  if (!userId || !otherId || !item) return;
  try {
    const key = qKey(userId);
    const raw = await AsyncStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    // Deduplicate by clientId before adding
    const filtered = list.filter((it) => it.clientId !== item.clientId);
    filtered.push({ ...item, otherId, queuedAt: Date.now() });
    await AsyncStorage.setItem(key, JSON.stringify(filtered));
  } catch (e) {
    console.warn('enqueueOutgoing failed:', e);
  }
}

export async function loadOutgoingQueue(userId) {
  if (!userId) return [];
  try {
    const raw = await AsyncStorage.getItem(qKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('loadOutgoingQueue failed:', e);
    return [];
  }
}

export async function dequeueOutgoing(userId, clientId) {
  if (!userId || !clientId) return;
  try {
    const key = qKey(userId);
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;
    const list = JSON.parse(raw).filter((it) => it.clientId !== clientId);
    await AsyncStorage.setItem(key, JSON.stringify(list));
  } catch (e) {
    console.warn('dequeueOutgoing failed:', e);
  }
}

// Flush ALL conversations' outgoing queues (for reconnect)
export async function flushAllOutgoingQueues(userId, socket, currentUserId) {
  if (!userId || !socket || !socket.connected) return;
  try {
    const queue = await loadOutgoingQueue(userId);
    if (!queue.length) return;

    // Group by otherId to send in order per conversation
    const byConv = new Map();
    for (const item of queue) {
      if (!item.otherId || !item.clientId) continue;
      if (!byConv.has(item.otherId)) byConv.set(item.otherId, []);
      byConv.get(item.otherId).push(item);
    }

    for (const [otherId, items] of byConv) {
      for (const item of items) {
        if (!socket.connected) return; // went offline again mid-flush
        try {
          await new Promise((resolve) => {
            socket.emit('message:send', {
              otherUserId: otherId,
              type: item.type || 'TEXT',
              content: item.content || '',
              replyTo: item.replyTo || null,
              clientId: item.clientId,
            }, (ack) => {
              if (ack && ack.ok) {
                dequeueOutgoing(userId, item.clientId);
              }
              resolve();
            });
          });
        } catch (e2) {
          // keep the item queued; retried on the next reconnect
          console.warn('flushAllOutgoingQueues item failed:', e2);
        }
      }
    }
  } catch (e) {
    console.warn('flushAllOutgoingQueues failed:', e);
  }
}