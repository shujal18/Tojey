import React, { useEffect, useState, useRef, useCallback } from 'react';
import { SafeAreaView, StatusBar, View, Text, TouchableOpacity, Platform, PermissionsAndroid, BackHandler, useWindowDimensions, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard';
import { loadSession, logout, fetchUsers } from './src/services/auth';
import { connect, disconnect, getSocket } from './src/services/socket';
import { loadUsers } from './src/services/cache';
import { Icon } from './src/components/AppIcon';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import ChatRoomScreen from './src/screens/ChatRoomScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { TojeyColors } from './src/theme';
import { ensureMediaPermission, ensureCameraPermission, ensureMicPermission } from './src/services/permissions';
import {
  startPush, stopPush, deactivateToken, onForegroundMessage, checkInitialNotification, onNotificationOpened,
  showSystemNotification, onSystemNotificationPressed, checkInitialSystemNotification,
} from './src/services/notifications';

const APP_LOCK_KEY = '@tojey_app_lock';
const APP_LOCK_PIN_KEY = '@tojey_app_lock_pin';

async function requestStartupPermissions() {
  if (Platform.OS !== 'android') return;
  try {
    await ensureMediaPermission();
    await ensureCameraPermission();
    await ensureMicPermission();
  } catch (e) {
    console.warn('Startup permission request failed:', e);
  }
  if (Platform.Version >= 33) {
    try {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO,
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      console.log('Android 13+ permissions:', granted);
    } catch (e) {
      console.warn('Android 13+ permission request failed:', e);
    }
  }
}

function Shell() {
  const { theme, booted: themeBooted } = useTheme();
  const { width: winW } = useWindowDimensions();
  const keySize = winW < 360 ? 60 : winW < 410 ? 66 : 72;
  const [session, setSession] = useState(null);
  const [booted, setBooted] = useState(false);
  const [initError, setInitError] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [socket, setSocket] = useState(null);
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [appLockPIN, setAppLockPIN] = useState('');
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [lockInput, setLockInput] = useState('');
  const [lockError, setLockError] = useState('');
  const [notifBanner, setNotifBanner] = useState(null);
  const pushStarted = useRef(false);

  // Reference kept fresh so notification listeners (registered once) can always navigate.
  const openFromNotifRef = useRef(null);

  const openFromNotif = useCallback(async (nd) => {
    if (!nd || !nd.senderId) return;
    const ownId = session && session.user ? session.user.id : null;
    // Never open a conversation for a different account on this device.
    if (ownId && nd.receiverId && nd.receiverId !== ownId) return;
    if (activeChat && activeChat.id === nd.senderId) {
      setNotifBanner(null);
      return;
    }
    let contact = null;
    if (ownId) {
      const cached = await loadUsers(ownId);
      contact = cached.find((u) => u.id === nd.senderId) || null;
    }
    if (!contact) {
      const all = await fetchUsers();
      contact = all.find((u) => u.id === nd.senderId) || null;
    }
    if (!contact) return;
    setActiveChat({
      id: contact.id,
      username: contact.username,
      display_name: contact.display_name || contact.displayName || 'User',
      profile_pic_url: contact.profile_pic_url || '',
      online: contact.online ?? contact.is_online ?? false,
      last_seen: contact.last_seen ?? contact.lastSeen ?? null,
      bio: contact.bio || '',
    });
    setNotifBanner(null);
  }, [session, activeChat]);
  openFromNotifRef.current = openFromNotif;

  const handleLockKey = (k) => {
    if (k === '⌫') {
      setLockInput(l => l.slice(0, -1));
      setLockError('');
      return;
    }
    if (lockInput.length >= 4) return;
    const next = lockInput + k;
    setLockInput(next);
    setLockError('');
    if (next.length === 4) {
      if (next === appLockPIN) {
        setShowLockScreen(false);
        setLockInput('');
      } else {
        setLockError('Incorrect PIN. Try again.');
        setLockInput('');
      }
    }
  };

  const handleLogin = (user, token) => {
    setSession({ user, token });
    setSocket(connect(token));
    if (!pushStarted.current) {
      pushStarted.current = true;
      startPush(token).catch(() => {});
    }
  };

  const handleLogout = async () => {
    await logout();
    disconnect();
    stopPush();
    try { await deactivateToken(); } catch (e) { console.warn('logout deactivate failed', e); }
    setSession(null);
    setSocket(null);
    setActiveChat(null);
    setNotifBanner(null);
    setShowSettings(false);
  };

  

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await requestStartupPermissions();
        const s = await loadSession();
        if (!mounted) return;
        setSession(s);
        if (s) {
          setSocket(connect(s.token));
          if (!pushStarted.current) {
            pushStarted.current = true;
            startPush(s.token).catch(() => {});
          }
        }
        const lockEnabled = await AsyncStorage.getItem(APP_LOCK_KEY);
        const pin = await AsyncStorage.getItem(APP_LOCK_PIN_KEY);
        setAppLockEnabled(lockEnabled === 'true');
        setAppLockPIN(pin || '');
        if (lockEnabled === 'true' && pin) {
          setShowLockScreen(true);
        }
      } catch (e) {
        console.error('App initialization failed:', e);
        if (mounted) setInitError(e.message);
      } finally {
        if (mounted) setBooted(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Tell the server whether this app is on-screen or minimized. The backend decides
  // between Socket.IO (foreground -> live chat UI) and FCM (background -> real Android
  // system notification) based on this. Without it, a backgrounded-but-connected app
  // was treated as "online" and no notification was ever sent.
  useEffect(() => {
    if (!session) return undefined;
    const emitAppState = () => {
      const s = getSocket();
      if (!s) return;
      const active = AppState.currentState === 'active';
      s.emit(active ? 'app:foreground' : 'app:background');
    };
    const sendToServer = () => setTimeout(emitAppState, 600);
    const onConnect = () => {
      emitAppState();
    };
    const sub = AppState.addEventListener('change', emitAppState);
    const so = getSocket();
    if (so) so.on('connect', onConnect);
    const t = sendToServer();
    return () => {
      clearTimeout(t);
      sub.remove();
      if (so) so.off('connect', onConnect);
    };
  }, [session, socket]);

  // Online delivery over the socket (no FCM when connected) + foreground push -> in-app banner.
  useEffect(() => {
    if (!socket) return undefined;
    const onNotif = (d) => {
      if (!d || !d.sender) return;
      const payload = {
        senderId: d.sender.userId,
        senderUsername: d.sender.username,
        senderName: d.sender.displayName,
        receiverId: session && session.user ? session.user.id : null,
        conversationId: d.conversationId,
        message: (d.notification && d.notification.message) || '',
        title: d.sender.displayName || 'Tojey',
        notificationId: d.notification && d.notification.id,
      };
      setNotifBanner(payload);
      showSystemNotification(payload);
    };
    socket.on('notification:receive', onNotif);
    const unsubFg = onForegroundMessage((p) => {
      if (!session) return;
      setNotifBanner(p);
      showSystemNotification(p);
    });
    return () => {
      socket.off('notification:receive', onNotif);
      if (unsubFg) unsubFg();
    };
  }, [socket, session]);

  // Tapping a system notification (foreground while running / cold start) opens that conversation.
  useEffect(() => {
    const unsubPressed = onSystemNotificationPressed((p) => {
      if (openFromNotifRef.current) openFromNotifRef.current(p);
    });
    checkInitialSystemNotification().then((p) => {
      if (p && openFromNotifRef.current) openFromNotifRef.current(p);
    });
    return () => {
      if (unsubPressed) unsubPressed();
    };
  }, []);

  // Notification taps: cold start and while running/backgrounded -> open that conversation.
  useEffect(() => {
    const unsubOpened = onNotificationOpened((p) => {
      if (openFromNotifRef.current) openFromNotifRef.current(p);
    });
    checkInitialNotification().then((p) => {
      if (p && openFromNotifRef.current) openFromNotifRef.current(p);
    });
    return () => {
      if (unsubOpened) unsubOpened();
    };
  }, []);

  // Android hardware back: chat → chats, settings → home, else exit
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (activeChat) {
        setActiveChat(null);
        return true;
      }
      if (showSettings) {
        setShowSettings(false);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [activeChat, showSettings]);

  // Show loading screen during initialization
  if (!booted || !themeBooted) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: TojeyColors.primary, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ alignItems: 'center' }}>
          <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
            <Icon name="chatbubbles" size={40} color={TojeyColors.primary} />
          </View>
          <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700' }}>Tojey</Text>
          <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, marginTop: 8 }}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Show error state if initialization failed
  if (initError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={{ alignItems: 'center', padding: 24 }}>
          <Icon name="alert-circle" size={60} color={theme.danger} style={{ marginBottom: 16 }} />
          <Text style={{ fontSize: 18, fontWeight: '700', color: theme.text, textAlign: 'center', marginBottom: 8 }}>Failed to Initialize</Text>
          <Text style={{ color: theme.textSecondary, textAlign: 'center', marginBottom: 24 }}>{initError}</Text>
          <TouchableOpacity onPress={() => { setInitError(null); setBooted(false); }} style={{ backgroundColor: theme.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 }}>
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (showLockScreen) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 320, backgroundColor: theme.card, borderRadius: 20, padding: 24, borderWidth: 1, borderColor: theme.border }}>
          <Icon name="lock-closed" size={60} color={theme.primary} style={{ alignSelf: 'center', marginBottom: 16 }} />
          <Text style={{ fontSize: 22, fontWeight: '700', color: theme.text, textAlign: 'center', marginBottom: 8 }}>App Lock</Text>
          <Text style={{ fontSize: 14, color: theme.textSecondary, textAlign: 'center', marginBottom: 24 }}>Enter your PIN to unlock Tojey</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 16 }}>
            {[1, 2, 3, 4].map((i) => (
              <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: lockInput.length >= i ? theme.primary : theme.border, backgroundColor: lockInput.length >= i ? theme.primary : 'transparent' }} />
            ))}
          </View>
          {lockError ? (
            <Text style={{ color: theme.danger, textAlign: 'center', fontSize: 13, marginBottom: 16 }}>{lockError}</Text>
          ) : null}
          <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 10 }}>
            {['1','2','3','4','5','6','7','8','9','0','⌫'].map((k) => (
              <TouchableOpacity key={k} onPress={() => handleLockKey(k)} style={{ width: keySize, height: keySize, borderRadius: keySize / 2, backgroundColor: theme.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border }}>
                <Text style={{ fontSize: 22, fontWeight: '600', color: theme.text }}>{k}</Text>
              </TouchableOpacity>
            ))}
          </View>
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

  let content;
  if (showSettings) {
    content = (
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
  } else if (activeChat) {
    content = (
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
  } else {
    content = (
      <>
        <StatusBar barStyle={theme.isDark ? 'light-content' : 'dark-content'} backgroundColor={theme.background} />
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.background }}>
          <HomeScreen
            socket={socket}
            user={session.user}
            token={session.token}
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

  return (
    <>
      {content}
      {notifBanner && (
        <NotifBanner
          theme={theme}
          title={notifBanner.title || 'Tojey'}
          message={notifBanner.message}
          onView={() => openFromNotif(notifBanner)}
          onClose={() => setNotifBanner(null)}
        />
      )}
    </>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <RootErrorBoundary>
        <Shell />
      </RootErrorBoundary>
    </ThemeProvider>
  );
}

function NotifBanner({ theme, title, message, onView, onClose }) {
  return (
    <View style={styles.notifBannerWrap} pointerEvents="box-none">
      <View style={[styles.notifBanner, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={{ paddingLeft: 6 }}>
          <Icon name="notifications" size={18} color={theme.primary} style={{ marginRight: 8 }} />
        </View>
        <TouchableOpacity style={{ flex: 1 }} onPress={onView}>
          <Text numberOfLines={1} style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>{title}</Text>
          {!!message && (
            <Text numberOfLines={2} style={{ color: theme.textSecondary, fontSize: 13, marginTop: 2 }}>
              {message}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={{ padding: 6 }} accessibilityLabel="Dismiss notification">
          <Icon name="close" size={16} color={theme.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = {
  notifBannerWrap: {
    position: 'absolute', top: 8, left: 12, right: 12, zIndex: 100,
  },
  notifBanner: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 14, paddingVertical: 8,
    paddingRight: 8, borderWidth: 1, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 }, elevation: 6, gap: 8,
  },
};

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Root crash:', error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = (this.state.error && (this.state.error.message || this.state.error.name)) || String(this.state.error || 'Unknown error');
    const full = (this.state.error && this.state.error.stack) ? String(this.state.error.stack) : '';
    const stack = full.split('\n').slice(0, 8).join('\n');
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#6C3CE9', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View style={{ alignItems: 'center', width: '100%' }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 8 }}>Something went wrong</Text>
          <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 13, textAlign: 'center', marginBottom: 6 }}>
            {msg}
          </Text>
          {!!stack && (
            <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, textAlign: 'center', marginBottom: 8 }}>
              {stack}
            </Text>
          )}
          <TouchableOpacity
            onPress={() => Clipboard.setString(`Tojey error\n\n${msg}\n\n${full}`)}
            style={{ backgroundColor: 'rgba(255,255,255,0.18)', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, marginTop: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>Copy error details</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => this.setState({ error: null })}
            style={{ backgroundColor: '#fff', paddingHorizontal: 26, paddingVertical: 12, borderRadius: 10, marginTop: 8 }}
          >
            <Text style={{ color: '#6C3CE9', fontWeight: '700', fontSize: 15 }}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }
}
