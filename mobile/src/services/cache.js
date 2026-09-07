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
    await AsyncStorage.setItem(msgKey(userId, otherId), JSON.stringify(msgs));
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