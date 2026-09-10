import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const CHAT_COLORS = [
  { id: 'default', name: 'Purple', sent: '#6C3CE9' },
  { id: 'teal', name: 'Teal', sent: '#00A884' },
  { id: 'blue', name: 'Ocean', sent: '#0B7FE8' },
  { id: 'green', name: 'Green', sent: '#1FA05B' },
  { id: 'coral', name: 'Coral', sent: '#F24E42' },
  { id: 'orange', name: 'Orange', sent: '#F5811E' },
  { id: 'pink', name: 'Pink', sent: '#E2417D' },
  { id: 'indigo', name: 'Indigo', sent: '#4156D7' },
];

export function hexBlend(a, b, t) {
  const pa = /^#([0-9a-fA-F]{6})$/.exec(a || '');
  const pb = /^#([0-9a-fA-F]{6})$/.exec(b || '');
  if (!pa || !pb) return a;
  const ca = [1, 3, 5].map((i) => parseInt(pa[1].slice(i - 1, i + 1), 16));
  const cb = [1, 3, 5].map((i) => parseInt(pb[1].slice(i - 1, i + 1), 16));
  const m = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const ThemeContext = createContext();

export const lightTheme = {
  isDark: false,
  background: '#F8F7FC',
  card: '#FFFFFF',
  text: '#1A1720',
  textSecondary: '#6B6773',
  primary: '#6C3CE9',
  primaryDeep: '#4E22B8',
  primaryLight: '#EEE8FF',
  border: '#E6E2F0',
  inputBg: '#F0EDF8',
  navBg: '#FFFFFF',
  sentBubble: '#6C3CE9',
  sentText: '#FFFFFF',
  // Incoming (received) bubble color is FIXED, WhatsApp-style dark char. Do NOT
  // tint it with the chat accent color — keep it constant across themes/chats.
  receivedBubble: '#1e2529',
  receivedText: '#E8EAEC',
  composerBg: '#FFFFFF',
  danger: '#E53935',
  online: '#7C4DFF',
  readBlue: '#A5D6FF',
};

export const darkTheme = {
  isDark: true,
  background: '#121116',
  card: '#1C1922',
  text: '#F2F0F7',
  textSecondary: '#9B96A8',
  primary: '#7C4DFF',
  primaryDeep: '#5A2FD0',
  primaryLight: '#241F2E',
  border: '#2E2A38',
  inputBg: '#2B2733',
  navBg: '#1C1922',
  sentBubble: '#6C3CE9',
  sentText: '#FFFFFF',
  receivedBubble: '#1e2529',
  receivedText: '#E8EAEC',
  composerBg: '#1C1922',
  danger: '#F2555A',
  online: '#7C4DFF',
  readBlue: '#A5D6FF',
};

const THEME_KEY = '@tojey_theme';
const CHAT_COLOR_KEY = '@tojey_chatColor';

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState('dark');
  const [chatColorId, setChatColorId] = useState('default');
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [savedMode, savedColor] = await Promise.all([
          AsyncStorage.getItem(THEME_KEY),
          AsyncStorage.getItem(CHAT_COLOR_KEY),
        ]);
        if (savedMode) setMode(savedMode);
        if (savedColor) setChatColorId(savedColor);
      } catch (e) {
        console.warn('theme load failed', e);
      }
      setBooted(true);
    })();
  }, []);

  const changeMode = (m) => {
    setMode(m);
    AsyncStorage.setItem(THEME_KEY, m).catch(() => {});
  };

  const changeChatColor = (id) => {
    setChatColorId(id);
    AsyncStorage.setItem(CHAT_COLOR_KEY, id).catch(() => {});
  };

  const chatColor = CHAT_COLORS.find((c) => c.id === chatColorId) || CHAT_COLORS[0];

  const theme = useMemo(() => {
    const base = mode === 'dark' ? darkTheme : lightTheme;
    return {
      ...base,
      sentBubble: chatColor.sent,
      sentText: '#FFFFFF',
      receivedBubble: '#1e2529',
      receivedText: '#E8EAEC',
    };
  }, [mode, chatColor]);

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode: changeMode, chatColorId, setChatColor: changeChatColor, booted }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) return { theme: lightTheme, mode: 'dark', setMode: () => {}, chatColorId: 'default', setChatColor: () => {}, booted: false };
  return context;
}
