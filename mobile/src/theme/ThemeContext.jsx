import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  receivedBubble: '#FFFFFF',
  receivedText: '#1A1720',
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
  receivedBubble: '#2A2733',
  receivedText: '#F2F0F7',
  composerBg: '#1C1922',
  danger: '#F2555A',
  online: '#7C4DFF',
  readBlue: '#A5D6FF',
};

const THEME_KEY = '@tojey_theme';

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState('light');
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(THEME_KEY);
      if (saved) setMode(saved);
      setBooted(true);
    })();
  }, []);

  const changeMode = (m) => {
    setMode(m);
    AsyncStorage.setItem(THEME_KEY, m).catch(() => {});
  };

  const theme = mode === 'dark' ? darkTheme : lightTheme;

  if (!booted) return null;
  return (
    <ThemeContext.Provider value={{ theme, mode, setMode: changeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
