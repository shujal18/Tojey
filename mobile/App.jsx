import React, { useEffect, useState } from 'react';
import { SafeAreaView, StatusBar, Alert, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSession, logout } from './src/services/auth';
import { connect, disconnect } from './src/services/socket';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import ChatRoomScreen from './src/screens/ChatRoomScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { TojeyColors } from './src/theme';

const APP_LOCK_KEY = '@tojey_app_lock';
const APP_LOCK_PIN_KEY = '@tojey_app_lock_pin';

function Shell() {
  const { theme } = useTheme();
  const [session, setSession] = useState(null);
  const [booted, setBooted] = useState(false);
  const [activeChat, setActiveChat] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [socket, setSocket] = useState(null);
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [appLockPIN, setAppLockPIN] = useState('');
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [lockInput, setLockInput] = useState('');

  useEffect(() => {
    (async () => {
      const s = await loadSession();
      setSession(s);
      if (s) {
        setSocket(connect(s.token));
      }
      const lockEnabled = await AsyncStorage.getItem(APP_LOCK_KEY);
      const pin = await AsyncStorage.getItem(APP_LOCK_PIN_KEY);
      setAppLockEnabled(lockEnabled === 'true');
      setAppLockPIN(pin || '');
      if (lockEnabled === 'true' && pin) {
        setShowLockScreen(true);
      }
      setBooted(true);
    })();
  }, []);

  const handleLockSubmit = () => {
    if (lockInput === appLockPIN) {
      setShowLockScreen(false);
      setLockInput('');
    } else {
      Alert.alert('Incorrect PIN', 'Please try again.');
      setLockInput('');
    }
  };

  const handleForgotPIN = async () => {
    await AsyncStorage.removeItem(APP_LOCK_KEY);
    await AsyncStorage.removeItem(APP_LOCK_PIN_KEY);
    setAppLockEnabled(false);
    setAppLockPIN('');
    setShowLockScreen(false);
  };

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

  if (showLockScreen) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 320 }}>
          <Icon name="lock-closed" size={60} color={theme.primary} style={{ alignSelf: 'center', marginBottom: 16 }} />
          <Text style={{ fontSize: 22, fontWeight: '700', color: theme.text, textAlign: 'center', marginBottom: 8 }}>App Lock</Text>
          <Text style={{ fontSize: 14, color: theme.textSecondary, textAlign: 'center', marginBottom: 24 }}>Enter your PIN to unlock Tojey</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
            {[1, 2, 3, 4].map((i) => (
              <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: lockInput.length >= i ? theme.primary : theme.border, backgroundColor: lockInput.length >= i ? theme.primary : 'transparent' }} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 10 }}>
            {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k) => (
              <TouchableOpacity key={k} onPress={() => {
                if (k === '⌫') setLockInput(l => l.slice(0, -1));
                else if (k === '') return;
                else if (lockInput.length < 4) setLockInput(l => l + k);
              }} style={{ width: 70, height: 70, borderRadius: 35, backgroundColor: theme.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border }}>
                <Text style={{ fontSize: 24, fontWeight: '600', color: theme.text }}>{k}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity onPress={handleForgotPIN} style={{ marginTop: 16, alignItems: 'center' }}>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Forgot PIN? Reset (clears app lock)</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
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
            appLockEnabled={appLockEnabled}
            appLockPIN={appLockPIN}
            onAppLockChange={async (enabled, newPin) => {
              await AsyncStorage.setItem(APP_LOCK_KEY, enabled ? 'true' : 'false');
              if (newPin) await AsyncStorage.setItem(APP_LOCK_PIN_KEY, newPin);
              setAppLockEnabled(enabled);
              setAppLockPIN(newPin || '');
            }}
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
          activeChatId={activeChat?.id}
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
