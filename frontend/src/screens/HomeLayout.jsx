import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../services/AuthContext';
import { ChatProvider, useChat } from '../services/ChatContext';
import { CallProvider } from '../services/CallContext';
import CallScreen from '../components/CallScreen';
import { createSocket, emitAppVisibility } from '../services/socket';
import { subscribeWebPush, stopWebPush } from '../services/webPush';
import ChatListScreen from './ChatListScreen';
import ChatRoomScreen from './ChatRoomScreen';
import ReelsScreen from './ReelsScreen';
import YoutubeHomeScreen from './YoutubeHomeScreen';
import SettingsScreen from './SettingsScreen';
import HeadsUpBanner from '../components/HeadsUpBanner';
import { useTheme } from '../theme/ThemeContext';
import {
  MessageCircle, Youtube, PlaySquare, Settings as SettingsIcon, LogOut, Lock,
} from 'lucide-react';

// Opens the ?chat=<userId> conversation a web-push notification click requested. Waits
// for the users list (loaded by ChatProvider) so the full contact object is available,
// then both opens the chat AND records it at the layout level so ChatRoomScreen renders.
function DeepLinkOpener({ targetId, onDone, onOpenChat }) {
  const { users, openConversation } = useChat();
  useEffect(() => {
    if (!targetId || !users.length) return;
    const other = users.find((u) => String(u.id) === String(targetId));
    if (other) {
      const contact = { ...other, is_online: other.is_online, online: !!other.online, last_seen: other.last_seen };
      openConversation(contact);
      if (onOpenChat) onOpenChat(contact);
      onDone();
    } else {
      onDone();
    }
  }, [targetId, users, openConversation, onDone, onOpenChat]);
  return null;
}

// Tailwind-free responsive flag: the shell is a two-pane WhatsApp-style layout on
// desktop and a single-pane stack on phones.
function useIsDesktop(minWidth = 900) {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= minWidth);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`);
    const onChange = () => setIsDesktop(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [minWidth]);
  return isDesktop;
}

export default function HomeLayout() {
  const { user, token, logout } = useAuth();
  const { theme } = useTheme();
  const isDesktop = useIsDesktop();
  const [section, setSection] = useState('chats');
  const [openChat, setOpenChat] = useState(null);
  const [socket, setSocket] = useState(null);
  const [shortsRefreshTick, setShortsRefreshTick] = useState(0);
  const [homeRefreshTick, setHomeRefreshTick] = useState(0);
  const [pendingChatId, setPendingChatId] = useState(null);

  const prevSectionRef = useRef(section);
  const goSection = (key) => {
    if (prevSectionRef.current === key) {
      if (key === 'youtube') setHomeRefreshTick((t) => t + 1);
      else if (key === 'shorts') setShortsRefreshTick((t) => t + 1);
    }
    setSection(key);
    prevSectionRef.current = key;
    if (key !== 'chats') setOpenChat(null);
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

  const handleOpenChat = (otherUser) => {
    setSection('chats');
    prevSectionRef.current = 'chats';
    setOpenChat(otherUser);
  };

  // var()s let the plain CSS :hover rules in styles.css follow the active theme.
  const shellVars = {
    '--tf-row-hover': theme.rowHover,
    '--tf-row-active': theme.rowActive,
  };

  return (
    <ChatProvider socket={socket} currentUser={currentUser} onOpenChat={handleOpenChat}>
      <CallProvider socket={socket} currentUser={currentUser}>
        <div
          style={{
            height: '100vh',
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            background: theme.shellBg,
            ...shellVars,
          }}
        >
          <div style={{
            width: '100%',
            maxWidth: isDesktop ? 1600 : '100%',
            height: '100%',
            display: 'flex',
            background: theme.background,
            boxShadow: isDesktop ? theme.frameShadow : 'none',
            overflow: 'hidden',
          }}>
            <NavRail
              section={section}
              onSelect={goSection}
              user={user}
              onLogout={logout}
            />

            <div style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
              {section === 'chats' && (
                <>
                  {(isDesktop || !openChat) && (
                    <ChatListPane isDesktop={isDesktop} onOpenChat={handleOpenChat} />
                  )}
                  {(isDesktop || openChat) && (
                    <div style={{ flex: 1, display: 'flex', minWidth: 0, overflow: 'hidden' }}>
                      {openChat ? (
                        <ChatRoomScreen
                          otherUser={openChat}
                          currentUser={currentUser}
                          onBack={() => setOpenChat(null)}
                        />
                      ) : (
                        <EmptyConversation />
                      )}
                    </div>
                  )}
                </>
              )}

              {section === 'youtube' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                  <YoutubeHomeScreen
                    token={token}
                    refreshTick={homeRefreshTick}
                    onOpenChats={() => goSection('chats')}
                    onOpenSettings={() => goSection('settings')}
                    onChangeToShorts={() => goSection('shorts')}
                  />
                </div>
              )}

              {section === 'shorts' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                  <ReelsScreen
                    token={token}
                    user={currentUser}
                    refreshTick={shortsRefreshTick}
                    onBack={() => goSection('youtube')}
                  />
                </div>
              )}

              {section === 'settings' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                  <SettingsScreen onLogout={logout} onBack={() => goSection('chats')} />
                </div>
              )}
            </div>
          </div>
        </div>

        <CallScreen />
        <DeepLinkOpener targetId={pendingChatId} onDone={clearPendingChat} onOpenChat={handleOpenChat} />
        <HeadsUpBanner />
      </CallProvider>
    </ChatProvider>
  );
}

function NavRail({ section, onSelect, user, onLogout }) {
  const { theme } = useTheme();
  const { totalUnread } = useChat();

  const items = [
    { key: 'chats', label: 'Chats', icon: MessageCircle, badge: totalUnread },
    { key: 'youtube', label: 'YouTube', icon: Youtube },
    { key: 'shorts', label: 'Shorts', icon: PlaySquare },
  ];

  const initial = (user.displayName || user.username || '?')[0].toUpperCase();

  return (
    <div style={{
      width: 68,
      flexShrink: 0,
      background: theme.railBg,
      borderRight: `1px solid ${theme.border}`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '12px 0',
      gap: 6,
      zIndex: 3,
    }}>
      <button
        onClick={() => onSelect('settings')}
        title="Your profile & settings"
        style={{
          width: 44, height: 44, borderRadius: 22, marginBottom: 10, overflow: 'hidden', flexShrink: 0,
          background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 17, fontWeight: 700, border: section === 'settings' ? `2px solid ${theme.primary}` : '2px solid transparent',
        }}
      >
        {user.profilePic
          ? <img src={user.profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : initial}
      </button>

      {items.map((it) => {
        const Icon = it.icon;
        const active = section === it.key;
        return (
          <button
            key={it.key}
            onClick={() => onSelect(it.key)}
            title={it.label}
            className="tf-nav-hover"
            style={{
              position: 'relative',
              width: 48, height: 48, borderRadius: 14,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
              color: active ? theme.primary : theme.textSecondary,
              background: active ? theme.primaryLight : 'transparent',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <Icon size={22} />
            <span style={{ fontSize: 9, fontWeight: active ? 700 : 500 }}>{it.label}</span>
            {!!it.badge && (
              <span style={{
                position: 'absolute', top: 5, right: 5, minWidth: 17, height: 17, padding: '0 4px',
                borderRadius: 9, background: theme.unreadBg, color: theme.unreadText,
                fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `2px solid ${theme.railBg}`,
              }}>
                {it.badge > 99 ? '99+' : it.badge}
              </span>
            )}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <button
        onClick={() => onSelect('settings')}
        title="Settings"
        className="tf-nav-hover"
        style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: section === 'settings' ? theme.primary : theme.textSecondary,
          background: section === 'settings' ? theme.primaryLight : 'transparent',
        }}
      >
        <SettingsIcon size={22} />
      </button>
      <button
        onClick={onLogout}
        title="Log out"
        className="tf-nav-hover"
        style={{
          width: 48, height: 48, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: theme.danger,
        }}
      >
        <LogOut size={22} />
      </button>
    </div>
  );
}

function ChatListPane({ isDesktop, onOpenChat }) {
  const { theme } = useTheme();
  return (
    <div style={{
      width: isDesktop ? 380 : '100%',
      flexShrink: 0,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: theme.sidebarBg,
      borderRight: isDesktop ? `1px solid ${theme.border}` : 'none',
      overflow: 'hidden',
    }}>
      <ChatListScreen onOpenChat={onOpenChat} />
    </div>
  );
}

function EmptyConversation() {
  const { theme } = useTheme();
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      padding: 40,
      background: theme.panelBg,
      borderBottom: `6px solid ${theme.primary}`,
    }}>
      <div style={{
        width: 92, height: 92, borderRadius: 46,
        background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 12px 30px rgba(108,60,233,0.35)',
      }}>
        <Lock size={44} color="#fff" />
      </div>
      <h1 style={{ color: theme.text, fontSize: 30, fontWeight: 300, marginTop: 26 }}>Tojey Web</h1>
      <p style={{ color: theme.textSecondary, fontSize: 14, marginTop: 12, maxWidth: 460, lineHeight: 1.6 }}>
        Send and receive private messages without keeping your phone online.
        Select a conversation on the left to start chatting, or open YouTube and Shorts.
      </p>
      <div style={{ color: theme.textSecondary, fontSize: 13, marginTop: 30, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Lock size={14} /> End-to-end private · Your conversations stay yours
      </div>
    </div>
  );
}
