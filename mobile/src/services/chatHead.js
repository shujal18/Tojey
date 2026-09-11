import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CHAT_HEAD_KEY = '@tojey_chat_head_enabled';
const NUDGE_VIB_KEY = '@tojey_nudge_vibration';

const Mod = NativeModules.TojeyChatHead;

export function supportsChatHead() {
  return !!Mod;
}

export async function getChatHeadEnabled() {
  try {
    return (await AsyncStorage.getItem(CHAT_HEAD_KEY)) === '1';
  } catch (e) {
    return false;
  }
}

export async function setChatHeadEnabled(enabled) {
  try {
    await AsyncStorage.setItem(CHAT_HEAD_KEY, enabled ? '1' : '0');
  } catch (e) {}
  if (!enabled) hideChatHead();
}

export function canDrawOverlay() {
  try {
    return Mod ? !!Mod.canDrawOverlay() : false;
  } catch (e) {
    return false;
  }
}

export function openOverlaySettings() {
  try {
    if (Mod) Mod.openOverlaySettings();
  } catch (e) {}
}

export function showChatHead(avatar, name, unread) {
  try {
    if (Mod) Mod.showChatHead(avatar || '💬', name || '', Number(unread) || 0);
  } catch (e) {}
}

export function hideChatHead() {
  try {
    if (Mod) Mod.hideChatHead();
  } catch (e) {}
}

export async function getNudgeVibrationEnabled() {
  try {
    return (await AsyncStorage.getItem(NUDGE_VIB_KEY)) !== '0';
  } catch (e) {
    return true;
  }
}

export async function setNudgeVibrationEnabled(enabled) {
  try {
    await AsyncStorage.setItem(NUDGE_VIB_KEY, enabled ? '1' : '0');
  } catch (e) {}
}

export const NUDGE_PATTERN = [0, 450, 150, 450, 150, 450, 150, 450, 150, 450];