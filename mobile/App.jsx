import React, { useEffect, useState, useRef, useCallback } from 'react';
import { SafeAreaView, StatusBar, View, Text, TouchableOpacity, Platform, BackHandler, useWindowDimensions, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Clipboard from '@react-native-clipboard/clipboard';
import { loadSession, logout, fetchUsers } from './src/services/auth';
import { connect, disconnect, getSocket } from './src/services/socket';
import { loadUsers } from './src/services/cache';
import { storeInvite } from './src/services/videoCall';
import { setAuthToken } from './src/services/downloadsStore';
import { Icon } from './src/components/AppIcon';
import IncomingBanner from './src/components/IncomingBanner';
import WatchTogetherBanner from './src/components/WatchTogetherBanner';
import { WatchTogetherProvider } from './src/services/WatchTogetherContext';
import { CallProvider } from './src/services/CallContext';
import { getNotifPrefs } from './src/services/notifications';
import LoginScreen from './src/screens/LoginScreen';
import HomeScreen from './src/screens/HomeScreen';
import ChatRoomScreen from './src/screens/ChatRoomScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import BatteryGuideScreen from './src/screens/BatteryGuideScreen';
import { isAggressiveOem } from './src/services/battery';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { TojeyColors } from './src/theme';
import {
  startPush, stopPush, deactivateToken, onForegroundMessage, checkInitialNotification, onNotificationOpened,
  showSystemNotification, onSystemNotificationPressed, checkInitialSystemNotification,
  getDeviceId, nextDeviceSeq,
} from './src/services/notifications';

const APP_LOCK_KEY = '@tojey_app_lock';
const APP_LOCK_PIN_KEY = '@tojey_app_lock_pin';
const BATTERY_GUIDE_SEEN_KEY = '@tojey_battery_guide_seen';

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
  const [showBatteryGuide, setShowBatteryGuide] = useState(false);
  // In-app heads-up banner (WhatsApp / Facebook Lite style) for incoming chat messages
  // while the app is OPEN. Shown when a message arrives for a conversation that is not
  // currently open - independent of FCM so it works on every device / OEM.
  const [incomingBanner, setIncomingBanner] = useState(null);
  const [watchRequest, setWatchRequest] = useState(null);

  // Reference kept fresh so notification listeners (registered once) can always navigate.
  const openFromNotifRef = useRef(null);

  // Reference kept fresh so the video-call invite listener can navigate.
  const openConversationWithRef = useRef(null);
  const homeBackRef = useRef(null);
  const registerHomeBack = useCallback((fn) => { homeBackRef.current = fn; }, []);
  const openSettings = useCallback(() => setShowSettings(true), []);
  const openChatFromHome = useCallback((c) => {
    setIncomingBanner(null);
    setActiveChat(c);
  }, []);
  const handleWatchRequestHandled = useCallback(() => setWatchRequest(null), []);
  const updateSessionUser = useCallback((u) => setSession((prev) => (prev ? { ...prev, user: u } : prev)), []);

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
    // A banner can already be on screen when the room opens (e.g. it arrived a
    // moment earlier, or the room was opened from the banner itself). Clear it so
    // nothing lingers over the conversation the user just chose to enter.
    setIncomingBanner(null);
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
    setAuthToken(token);
    setSocket(connect(token));
    startPush(token).catch(() => {});
  };

  // A Watch Together room became active (invitation accepted or reconnect):
  // leave any chat/settings view and ask HomeScreen to open the room's video.
  const handleWatchVideo = useCallback((room) => {
    if (!room || !room.videoId) return;
    setActiveChat(null);
    setShowSettings(false);
    setWatchRequest({
      key: `${room.roomId}:${room.videoId}:${Date.now()}`,
      videoId: room.videoId,
      title: room.title || '',
    });
  }, []);

  const handleLogout = async () => {
    await logout();
    setAuthToken('');
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
          setAuthToken(s.token);
          setSocket(connect(s.token));
          startPush(s.token).catch(() => {});
        }
        const lockEnabled = await AsyncStorage.getItem(APP_LOCK_KEY);
        const pin = await AsyncStorage.getItem(APP_LOCK_PIN_KEY);
        const lockOn = lockEnabled === 'true' && !!pin;
        setAppLockEnabled(lockEnabled === 'true');
        setAppLockPIN(pin || '');
        if (lockOn) {
          setShowLockScreen(true);
        }
        // First time on a phone with an aggressive battery manager (OPPO, realme,
        // vivo, Xiaomi, Huawei...): show the notification/battery setup guide once
        // so closed-app pop-ups actually work. Re-openable anytime from Settings.
        if (s) {
          const seen = await AsyncStorage.getItem(BATTERY_GUIDE_SEEN_KEY);
          if (seen !== '1' && isAggressiveOem()) {
            await AsyncStorage.setItem(BATTERY_GUIDE_SEEN_KEY, '1');
            if (mounted && !lockOn) setShowBatteryGuide(true);
          }
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
    // Foreground heartbeat: re-report while on-screen so the server's per-device
    // freshness window (FOREGROUND_TRUST_MS) never expires for a live app. If the
    // process is later killed (OPPO/OS, network cut) the heartbeat stops and the
    // server falls back to FCM for this device instead of suppressing push forever.
    const heartbeat = setInterval(emitAppState, 30 * 1000);
    return () => {
      clearTimeout(t);
      clearInterval(heartbeat);
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
  // the app is closed/backgrounded) -> while the app is open they pop as an IN-APP
  // heads-up banner (same as a chat message) instead of only landing in the status
  // bar; when the app is backgrounded they fall back to a real system notification.
  // Socket + FCM copies of the same push are deduped by notification id.
  const lastPushHandledRef = useRef({ id: null, at: 0 });
  useEffect(() => {
    if (!socket) return undefined;

    const showPush = async (payload) => {
      const prefs = await getNotifPrefs().catch(() => null);
      if (prefs && prefs.enabled === false) return;
      const id = (payload && payload.notificationId) || '';
      if (id && lastPushHandledRef.current.id === id && Date.now() - lastPushHandledRef.current.at < 4000) return;
      if (id) lastPushHandledRef.current = { id, at: Date.now() };
      if (AppState.currentState === 'active') {
        setIncomingBanner({
          key: `notif-${id || Date.now()}`,
          senderId: payload.senderId,
          senderName: payload.senderName || 'Tojey',
          senderPic: payload.senderPic || '',
          conversationId: payload.conversationId,
          preview: payload.message || 'You have a new notification',
        });
      } else {
        showSystemNotification(payload);
      }
    };

    const onNotif = (d) => {
      if (!d || !d.sender) return;
      showPush({
        senderId: d.sender.userId,
        senderUsername: d.sender.username,
        senderName: d.sender.displayName,
        senderPic: d.sender.profilePic || '',
        receiverId: session && session.user ? session.user.id : null,
        conversationId: d.conversationId,
        message: (d.notification && d.notification.message) || '',
        title: d.sender.displayName || 'Tojey',
        notificationId: d.notification && d.notification.id,
      });
    };
    socket.on('notification:receive', onNotif);
    const unsubFg = onForegroundMessage((p) => {
      if (!session) return;
      if (p && p.data && p.data.type && p.data.type !== 'tojey_notification') return;
      showPush(p);
    });
    return () => {
      socket.off('notification:receive', onNotif);
      if (unsubFg) unsubFg();
    };
  }, [socket, session]);

  const openBanner = () => {
    if (incomingBanner && incomingBanner.senderId) {
      openConversationWith(incomingBanner.senderId);
    }
    setIncomingBanner(null);
  };

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

  const backStateRef = useRef({
    activeChat: null,
    showSettings: false,
    showBatteryGuide: false,
    showLockScreen: false,
    incomingBanner: null,
  });
  backStateRef.current = { activeChat, showSettings, showBatteryGuide, showLockScreen, incomingBanner };

  // Android hardware back always moves through app surfaces; it never closes the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const state = backStateRef.current;
      if (state.showBatteryGuide) {
        setShowBatteryGuide(false);
        return true;
      }
      if (state.showLockScreen) return true;
      if (state.incomingBanner) {
        setIncomingBanner(null);
        return true;
      }
      if (state.activeChat) {
        setActiveChat(null);
        return true;
      }
      if (state.showSettings) {
        setShowSettings(false);
        return true;
      }
      if (homeBackRef.current && homeBackRef.current()) return true;
      return true;
    });
    return () => sub.remove();
  }, []);

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
            onOpenBatteryGuide={() => setShowBatteryGuide(true)}
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
            key={activeChat.id || activeChat.username || 'active-chat'}
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
            setUser={updateSessionUser}
            onOpenChat={openChatFromHome}
            onOpenSettings={openSettings}
            activeChatId={activeChat?.id}
            watchRequest={watchRequest}
            onWatchRequestHandled={handleWatchRequestHandled}
            registerBackHandler={registerHomeBack}
          />
        </SafeAreaView>
      </>
    );
  }

  return (
    <WatchTogetherProvider socket={socket} currentUser={session.user}>
      <CallProvider socket={socket} currentUser={session.user}>
      <View style={{ flex: 1 }}>
        {content}
        {booted && !showLockScreen && !!session && (
          <IncomingBanner
            data={incomingBanner}
            onPress={openBanner}
            onDismiss={() => setIncomingBanner(null)}
          />
        )}
        {!showLockScreen && <WatchTogetherBanner onOpenVideo={handleWatchVideo} />}
        {showBatteryGuide && (
          <View
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.background, zIndex: 50, elevation: 20 }}
          >
            <BatteryGuideScreen onClose={() => setShowBatteryGuide(false)} />
          </View>
        )}
      </View>
      </CallProvider>
    </WatchTogetherProvider>
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
