import AsyncStorage from '@react-native-async-storage/async-storage';
import { SERVER_URL } from '../config';

const TOKEN_KEY = '@tojey_token';
const USER_KEY = '@tojey_user';

export async function login(username, password) {
  try {
    const res = await fetch(`${SERVER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error || 'Login failed' };
    }
    await AsyncStorage.setItem(TOKEN_KEY, data.token);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(data.user));
    return { ok: true, token: data.token, user: data.user };
  } catch (e) {
    return { ok: false, error: 'Cannot reach server. Check SERVER_URL in src/config.js' };
  }
}

export async function loadSession() {
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    const userRaw = await AsyncStorage.getItem(USER_KEY);
    if (token && userRaw) {
      return { token, user: JSON.parse(userRaw) };
    }
    return null;
  } catch (e) {
    return null;
  }
}

export async function logout() {
  await AsyncStorage.removeItem(TOKEN_KEY);
  await AsyncStorage.removeItem(USER_KEY);
}

export async function fetchUsers() {
  try {
    const res = await fetch(`${SERVER_URL}/api/users`);
    const data = await res.json();
    return data;
  } catch (e) {
    return [];
  }
}
