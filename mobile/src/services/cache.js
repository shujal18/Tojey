import AsyncStorage from '@react-native-async-storage/async-storage';

const convKey = (userId) => `@tojey_cache_conv_${userId}`;
const usersKey = (userId) => `@tojey_cache_users_${userId}`;
const msgKey = (userId, otherId) => `@tojey_cache_msg_${userId}_${otherId}`;

export async function saveConversations(userId, list) {
  if (!userId || !Array.isArray(list)) return;
  try {
    await AsyncStorage.setItem(convKey(userId), JSON.stringify(list));
  } catch (e) {
    console.warn('saveConversations failed:', e);
  }
}

export async function loadConversations(userId) {
  if (!userId) return [];
  try {
    const raw = await AsyncStorage.getItem(convKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('loadConversations failed:', e);
    return [];
  }
}

export async function saveUsers(userId, list) {
  if (!userId || !Array.isArray(list)) return;
  try {
    await AsyncStorage.setItem(usersKey(userId), JSON.stringify(list));
  } catch (e) {
    console.warn('saveUsers failed:', e);
  }
}

export async function loadUsers(userId) {
  if (!userId) return [];
  try {
    const raw = await AsyncStorage.getItem(usersKey(userId));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('loadUsers failed:', e);
    return [];
  }
}

export async function saveMessages(userId, otherId, msgs) {
  if (!userId || !otherId || !Array.isArray(msgs)) return;
  try {
    // Only persist the newest 200 messages to keep AsyncStorage writes cheap and
    // avoids unbounded growth on very long chats (history is re-synced from the
    // server + paginated on scroll up).
    const slice = msgs.length > 200 ? msgs.slice(-200) : msgs;
    await AsyncStorage.setItem(msgKey(userId, otherId), JSON.stringify(slice));
  } catch (e) {
    console.warn('saveMessages failed:', e);
  }
}

export async function loadMessages(userId, otherId) {
  if (!userId || !otherId) return [];
  try {
    const raw = await AsyncStorage.getItem(msgKey(userId, otherId));
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('loadMessages failed:', e);
    return [];
  }
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
const qKey = (userId) => `@tojey_queue_${userId}`;

export async function enqueueOutgoing(userId, otherId, item) {
  if (!userId || !otherId || !item) return;
  try {
    const key = qKey(userId);
    const raw = await AsyncStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    list.push({ ...item, otherId, queuedAt: Date.now() });
    await AsyncStorage.setItem(key, JSON.stringify(list));
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