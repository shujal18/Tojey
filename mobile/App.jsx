import React, { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar } from 'react-native';
import { loadSession, logout } from './src/services/auth';
import { connect, disconnect } from './src/services/socket';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import ChatRoomScreen from './src/screens/ChatRoomScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { TojeyColors } from './src/theme';

function Shell() {
  const { theme } = useTheme();
  const [session, setSession] = useState(null);
  const [booted, setBooted] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    (async () => {
      const s = await loadSession();
      setSession(s);
      if (s) {
        setSocket(connect(s.token));
      }
      setBooted(true);
    })();
  }, []);

  const handleLogin = (user, token) => {
    setSession({ user, token });
    setSocket(connect(token));
  };

  const handleLogout = async () => {
    disconnect();
    await logout();
    setSession(null);
    setActiveChat(null);
    setShowSettings(false);
    setSocket(null);
  };

  if (!booted) {
    return null;
  }

  if (!session) {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={TojeyColors.primary} />
        <SafeAreaView style={{ flex: 1 }}>
          <LoginScreen onLogin={handleLogin} />
        </SafeAreaView>
      </>
    );
  }

  if (showSettings) {
    return (
      <>
        <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
          <SettingsScreen
            user={session.user}
            token={session.token}
            onBack={() => setShowSettings(false)}
            onLogout={handleLogout}
            setUser={(u) => setSession({ ...session, user: u })}
          />
        </SafeAreaView>
      </>
    );
  }

  if (activeChat) {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={TojeyColors.primaryDeep} />
        <SafeAreaView style={{ flex: 1 }}>
          <ChatRoomScreen
            socket={socket}
            currentUser={session.user}
            otherUser={activeChat}
            onBack={() => setActiveChat(null)}
          />
        </SafeAreaView>
      </>
    );
  }

  return (
    <>
      <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
        <HomeScreen
          socket={socket}
          user={session.user}
          setUser={(u) => setSession({ ...session, user: u })}
          onLogout={handleLogout}
          onOpenChat={setActiveChat}
          onOpenSettings={() => setShowSettings(true)}
        />
      </SafeAreaView>
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
