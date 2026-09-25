import React, { useEffect, useState, useRef, useCallback } from 'react';
import { SafeAreaView, StatusBar, View, Text, TouchableOpacity, Platform, BackHandler, useWindowDimensions, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard';
import { loadSession, logout, fetchUsers } from './src/services/auth';
import { connect, disconnect, getSocket } from './src/services/socket';
import { loadUsers } from './src/services/cache';
import { storeInvite } from './src/services/videoCall';
import { Icon } from './src/components/AppIcon';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import ChatRoomScreen from './src/screens/ChatRoomScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { TojeyColors } from './src/theme';
import {
  startPush, stopPush, deactivateToken, onForegroundMessage, checkInitialNotification, onNotificationOpened,
  showSystemNotification, onSystemNotificationPressed, checkInitialSystemNotification,
  getDeviceId, nextDeviceSeq,
} from './src/services/notifications';

const APP_LOCK_KEY = '@tojey_app_lock';
const APP_LOCK_PIN_KEY = '@tojey_app_lock_pin';

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

  // Reference kept fresh so notification listeners (registered once) can always navigate.
  const openFromNotifRef = useRef(null);

  // Reference kept fresh so the video-call invite listener can navigate.
  const openConversationWithRef = useRef(null);

  const openConversationWith = useCallback(async (userId) => {
    if (!userId) return;
    const ownId = session && session.user ? session.user.id : null;
    if (ownId && String(userId) === String(ownId)) return;
    if (activeChat && activeChat.id === userId) return;
    let contact = null;
    if (ownId) {
      const cached = await loadUsers(ownId);
      contact = cached.find((u) => u.id === userId) || null;
    }
    if (!contact) {
      const all = await fetchUsers();
      contact = all.find((u) => u.id === userId) || null;
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
  }, [session, activeChat]);
  openConversationWithRef.current = openConversationWith;

  const openFromNotif = useCallback(async (nd) => {
    if (!nd || !nd.senderId) return;
    const ownId = session && session.user ? session.user.id : null;
    // Never open a conversation for a different account on this device.
    if (ownId && nd.receiverId && nd.receiverId !== ownId) return;
    await openConversationWith(nd.senderId);
  }, [openConversationWith]);
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
    startPush(token).catch(() => {});
  };

  const handleLogout = async () => {
    await logout();
    disconnect();
    stopPush();
    try { await deactivateToken(); } catch (e) { console.warn('logout deactivate failed', e); }
    setSession(null);
    setSocket(null);
    setActiveChat(null);
    setShowSettings(false);
  };

  

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await loadSession();
        if (!mounted) return;
        setSession(s);
        if (s) {
          setSocket(connect(s.token));
          startPush(s.token).catch(() => {});
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
  // system notification) PER DEVICE based on this. Without it, a backgrounded-but-connected
  // app was treated as "online" and no notification was ever sent. Each report carries the
  // stable deviceId + a monotonic seq so a stale report can never downgrade a newer one.
  useEffect(() => {
    if (!session) return undefined;
    const emitAppState = () => {
      const s = getSocket();
      if (!s) return;
      const active = AppState.currentState === 'active';
      Promise.all([getDeviceId(), nextDeviceSeq()])
        .then(([deviceId, seq]) => {
          const so = getSocket();
          if (!so || !so.connected) return;
          so.emit(active ? 'app:foreground' : 'app:background', { deviceId, seq });
        })
        .catch(() => {});
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

  // Incoming video call (WhatsApp-style auto-open): buffer the invite so the
  // freshly opened ChatRoom screen can pick it up, then navigate to the caller's
  // conversation. Works even when the user is on another chat or the listener in
  // ChatRoom attached after the event was delivered.
  useEffect(() => {
    if (!socket) return undefined;
    const onInvite = (payload) => {
      if (!payload || !payload.callId || !payload.callerId) return;
      storeInvite({ callId: payload.callId, callerId: payload.callerId, caller: payload.caller || null });
      if (openConversationWithRef.current && !(activeChat && activeChat.id === payload.callerId)) {
        openConversationWithRef.current(payload.callerId);
      }
    };
    socket.on('video-call:invite', onInvite);
    return () => socket.off('video-call:invite', onInvite);
  }, [socket, activeChat]);

  // Manual "Send Notification" pushes (socket delivery when online, FCM push when
  // the app is closed/backgrounded) -> a real device system notification. Foreground
  // FCM data pushes (type tojey_notification) are also rendered here.
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
      showSystemNotification(payload);
    };
    socket.on('notification:receive', onNotif);
    const unsubFg = onForegroundMessage((p) => {
      if (!session) return;
      if (p && p.data && p.data.type && p.data.type !== 'tojey_notification') return;
      showSystemNotification(p);
    });
    return () => {
      socket.off('notification:receive', onNotif);
      if (unsubFg) unsubFg();
    };
  }, [socket, session]);

  // Taps on the app's own system notifications (notifee) -> open the conversation.
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

  // Notification taps from FCM: cold start and while running/backgrounded -> open
  // that conversation.
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
    <View style={{ flex: 1 }}>
      {content}
    </View>
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
