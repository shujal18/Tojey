import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../services/AuthContext';
import { ChatProvider, useChat } from '../services/ChatContext';
import { CallProvider } from '../services/CallContext';
import CallScreen from '../components/CallScreen';
import { createSocket, emitAppVisibility } from '../services/socket';
import { subscribeWebPush, stopWebPush } from '../services/webPush';
import ChatListScreen from './ChatListScreen';
import ContactsScreen from './ContactsScreen';
import SettingsScreen from './SettingsScreen';
import ChatRoomScreen from './ChatRoomScreen';
import ReelsScreen from './ReelsScreen';
import { useTheme } from '../theme/ThemeContext';
import { MessageCircle, Users, Settings, Clapperboard, LogOut } from 'lucide-react';

// Opens the ?chat=<userId> conversation a web-push notification click requested. Waits
// for the users list (loaded by ChatProvider) so the full contact object is available.
function DeepLinkOpener({ targetId, onDone }) {
  const { users, openConversation } = useChat();
  useEffect(() => {
    if (!targetId || !users.length) return;
    const other = users.find((u) => String(u.id) === String(targetId));
    if (other) {
      openConversation({ ...other, online: !!other.online, last_seen: other.last_seen });
      onDone();
    } else {
      onDone();
    }
  }, [targetId, users, openConversation, onDone]);
  return null;
}

export default function HomeLayout() {
  const { user, token, logout } = useAuth();
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState('chats');
  const [openChat, setOpenChat] = useState(null);
  const [socket, setSocket] = useState(null);
  const [reelsRefreshTick, setReelsRefreshTick] = useState(0);
  const [pendingChatId, setPendingChatId] = useState(null);

  const prevTabRef = React.useRef(activeTab);
  const handleTabPress = (key) => {
    if (key === 'reels' && prevTabRef.current === 'reels') {
      setReelsRefreshTick(t => t + 1);
    }
    setActiveTab(key);
    prevTabRef.current = key;
  };

  useEffect(() => {
    const s = createSocket(token);
    setSocket(s);
    window.__socket = s;
    // New tab / reconnect: tell the backend this browser is foreground so messages come
    // over sockets (no duplicate web push for this device).
    s.on('connect', () => emitAppVisibility(s, document.visibilityState === 'visible'));
    // Best-effort web-push subscription (only proceeds if permission was already granted).
    subscribeWebPush(token);
    return () => {
      s.off('connect');
      s.disconnect();
      window.__socket = null;
      stopWebPush(token);
    };
  }, [token]);

  // Foreground/background reporting drives FCM-vs-Socket.IO routing for this browser.
  useEffect(() => {
    if (!socket) return undefined;
    const onVis = () => emitAppVisibility(socket, document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [socket]);

  // Deep link from a web-push click: /?chat=<userId>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const chat = params.get('chat');
    if (chat) {
      setPendingChatId(chat);
      try { window.history.replaceState({}, '', window.location.pathname); } catch (e) {}
    }
  }, []);

  const clearPendingChat = () => setPendingChatId(null);

  const currentUser = useMemo(() => ({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
  }), [user]);

  const tabs = [
    { key: 'chats', label: 'Chats', icon: <MessageCircle size={22} /> },
    { key: 'contacts', label: 'Contacts', icon: <Users size={22} /> },
    { key: 'reels', label: 'Reels', icon: <Clapperboard size={22} /> },
    { key: 'settings', label: 'Settings', icon: <Settings size={22} /> },
  ];

  const handleOpenChat = (otherUser) => {
    setOpenChat(otherUser);
  };

  if (openChat) {
    return (
      <ChatProvider socket={socket} currentUser={currentUser}>
        <CallProvider socket={socket} currentUser={currentUser}>
          <ChatRoomScreen
            otherUser={openChat}
            currentUser={currentUser}
            onBack={() => { setOpenChat(null); setActiveTab('chats'); }}
          />
          <CallScreen />
          <DeepLinkOpener targetId={pendingChatId} onDone={clearPendingChat} />
        </CallProvider>
      </ChatProvider>
    );
  }

  return (
    <ChatProvider socket={socket} currentUser={currentUser}>
      <CallProvider socket={socket} currentUser={currentUser}>
      <div style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: theme.background,
        maxWidth: 480,
        margin: '0 auto',
        position: 'relative',
        boxShadow: '0 0 40px rgba(0,0,0,0.12)',
      }}>
        <div style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {activeTab === 'chats' && <ChatListScreen onOpenChat={handleOpenChat} />}
          {activeTab === 'contacts' && <ContactsScreen onOpenChat={handleOpenChat} />}
          {activeTab === 'reels' && <ReelsScreen token={token} user={currentUser} refreshTick={reelsRefreshTick} onBack={() => { setActiveTab('chats'); prevTabRef.current = 'chats'; }} />}
          {activeTab === 'settings' && <SettingsScreen onLogout={logout} />}
        </div>

        {activeTab !== 'reels' && (
          <div style={{
            display: 'flex',
            background: theme.navBg,
            borderTop: `1px solid ${theme.border}`,
            padding: '6px 0',
            paddingBottom: '10px',
          }}>
            {tabs.map((t) => (
              <button key={t.key} onClick={() => handleTabPress(t.key)} style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                padding: '6px 0',
                color: activeTab === t.key ? theme.primary : theme.textSecondary,
                fontSize: 11,
                fontWeight: activeTab === t.key ? 600 : 500,
                transition: 'color 0.2s',
              }}>
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        )}

        {activeTab !== 'reels' && (
          <button onClick={logout} title="Logout" style={{
            position: 'absolute',
            top: 12,
            right: 12,
            color: theme.textSecondary,
            padding: 8,
            background: theme.card,
            borderRadius: 10,
            boxShadow: theme.shadow,
            zIndex: 10,
          }}>
            <LogOut size={16} />
          </button>
        )}
      </div>
      <CallScreen />
      <DeepLinkOpener targetId={pendingChatId} onDone={clearPendingChat} />
      </CallProvider>
    </ChatProvider>
  );
}
