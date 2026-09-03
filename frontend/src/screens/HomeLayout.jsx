import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../services/AuthContext';
import { ChatProvider } from '../services/ChatContext';
import { createSocket } from '../services/socket';
import ChatListScreen from './ChatListScreen';
import ContactsScreen from './ContactsScreen';
import SettingsScreen from './SettingsScreen';
import ChatRoomScreen from './ChatRoomScreen';
import { useTheme } from '../theme/ThemeContext';
import { MessageCircle, Users, Settings, LogOut } from 'lucide-react';

export default function HomeLayout() {
  const { user, token, logout } = useAuth();
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState('chats');
  const [openChat, setOpenChat] = useState(null);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    const s = createSocket(token);
    setSocket(s);
    window.__socket = s;
    return () => {
      s.disconnect();
      window.__socket = null;
    };
  }, [token]);

  const currentUser = useMemo(() => ({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
  }), [user]);

  const tabs = [
    { key: 'chats', label: 'Chats', icon: <MessageCircle size={22} /> },
    { key: 'contacts', label: 'Contacts', icon: <Users size={22} /> },
    { key: 'settings', label: 'Settings', icon: <Settings size={22} /> },
  ];

  const handleOpenChat = (otherUser) => {
    setOpenChat(otherUser);
  };

  if (openChat) {
    return (
      <ChatProvider socket={socket} currentUser={currentUser}>
        <ChatRoomScreen
          otherUser={openChat}
          currentUser={currentUser}
          onBack={() => { setOpenChat(null); setActiveTab('chats'); }}
        />
      </ChatProvider>
    );
  }

  return (
    <ChatProvider socket={socket} currentUser={currentUser}>
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
          {activeTab === 'settings' && <SettingsScreen onLogout={logout} />}
        </div>

        <div style={{
          display: 'flex',
          background: theme.navBg,
          borderTop: `1px solid ${theme.border}`,
          padding: '6px 0',
          paddingBottom: '10px',
        }}>
          {tabs.map((t) => (
            <button key={t.key} onClick={() => setActiveTab(t.key)} style={{
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
      </div>
    </ChatProvider>
  );
}
