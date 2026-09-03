import React, { createContext, useContext, useState, useEffect } from 'react';
import { getTheme, lightTheme, darkTheme } from '../theme';

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => localStorage.getItem('tojey-theme') || 'system');

  useEffect(() => {
    localStorage.setItem('tojey-theme', mode);
  }, [mode]);

  const theme = getTheme(mode);

  useEffect(() => {
    const handler = () => {
      if (mode === 'system') {
        const t = getTheme('system');
        document.documentElement.style.colorScheme = t.isDark ? 'dark' : 'light';
        document.body.style.background = t.background;
      }
    };
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', handler);
    handler();
    return () => window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', handler);
  }, [mode]);

  useEffect(() => {
    document.body.style.background = theme.background;
    document.documentElement.style.colorScheme = theme.isDark ? 'dark' : 'light';
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, mode, setMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
