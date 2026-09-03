import React, { useState, useMemo, useEffect } from 'react';
import { useChat } from '../services/ChatContext';
import { useAuth } from '../services/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { Search, MessageSquarePlus, Mic, Camera, ImageIcon } from 'lucide-react';

export default function ChatListScreen({ onOpenChat }) {
  const { theme } = useTheme();
  const { users, conversation, presence } = useChat();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  const contacts = useMemo(
    () => users.filter(u => u.id !== user.id),
    [users, user.id]
  );

  const unread = {
    tombay: 0,
  };

  useEffect(() => {
    if (query.trim()) {
      setSearchResults(contacts.filter(c => c.display_name.toLowerCase().includes(query.toLowerCase())));
    } else {
      setSearchResults([]);
    }
  }, [query, contacts]);

  const previewText = (type) => {
    switch (type) {
      case 'VOICE': return '🎤 Voice message';
      case 'IMAGE': return '📷 Photo';
      case 'VIDEO': return '🎬 Video';
      default: return 'New conversation';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '16px 16px 8px',
        background: theme.background,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h1 style={{ color: theme.text, fontSize: 24, fontWeight: 700 }}>Tojey</h1>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          background: theme.inputBg,
          borderRadius: 12,
          padding: '10px 14px',
          gap: 8,
        }}>
          <Search size={18} color={theme.textSecondary} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations..."
            style={{
              flex: 1,
              background: 'transparent',
              color: theme.text,
              fontSize: 14,
            }}
          />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {query.trim() ? (
          searchResults.length > 0 ? (
            searchResults.map(c => (
              <ConversationRow key={c.id} contact={c} isOnline={presence[c.id]?.isOnline} onPress={() => onOpenChat(c)} />
            ))
          ) : (
            <EmptySearch results={searchResults.length} onFind={fetchSearchResults} />
          )
        ) : (
          <>
            {contacts.length > 0 ? contacts.map(c => (
              <ConversationRow key={c.id} contact={c} isOnline={presence[c.id]?.isOnline} onPress={() => onOpenChat(c)} />
            )) : (
              <EmptyChats onStart={() => {}} />
            )}
          </>
        )}
      </div>

      <button style={{
        position: 'absolute',
        bottom: 76,
        right: 20,
        width: 52,
        height: 52,
        borderRadius: 26,
        background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 16px rgba(108,60,233,0.4)',
      }}>
        <MessageSquarePlus size={24} />
      </button>
    </div>
  );
}

function ConversationRow({ contact, isOnline, onPress }) {
  const { theme } = useTheme();
  const [avatarColor] = useState(() => {
    const colors = ['#6C3CE9', '#4E22B8', '#7C4DFF', '#9C6BFF', '#B39DDB'];
    return colors[Math.floor(Math.random() * colors.length)];
  });

  const initial = contact.display_name ? contact.display_name[0].toUpperCase() : '?';

  return (
    <button onClick={onPress} style={{
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      padding: '10px 16px',
      background: theme.background,
      transition: 'background 0.15s',
    }}>
      <div style={{ position: 'relative', marginRight: 12 }}>
        <div style={{
          width: 50,
          height: 50,
          borderRadius: 25,
          background: avatarColor,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 20,
          fontWeight: 600,
        }}>
          {initial}
        </div>
        {isOnline && (
          <div style={{
            position: 'absolute',
            bottom: 0,
            right: 0,
            width: 12,
            height: 12,
            borderRadius: 6,
            background: '#7C4DFF',
            border: `2px solid ${theme.background}`,
          }} />
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: theme.text, fontSize: 16, fontWeight: 600 }}>
            {contact.display_name}
          </span>
          <span style={{ color: theme.textSecondary, fontSize: 12 }}>10:42 AM</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 }}>
          <span style={{
            color: theme.textSecondary,
            fontSize: 13,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '70%',
            fontWeight: 400,
          }}>
            {isOnline ? 'online' : 'Say hello 👋'}
          </span>
          <div style={{
            background: theme.primary,
            color: '#fff',
            fontSize: 11,
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            padding: '0 5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
          }}>
            0
          </div>
        </div>
      </div>
    </button>
  );
}

function fetchSearchResults() {}

function EmptySearch({ onFind }) {
  const { theme } = useTheme();
  return (
    <div style={{ textAlign: 'center', padding: 60, color: theme.textSecondary }}>
      <Search size={40} color={theme.textSecondary} />
      <p style={{ marginTop: 16, fontSize: 15 }}>No conversations found</p>
      <p style={{ fontSize: 13, marginTop: 4, opacity: 0.7 }}>Try a different name</p>
    </div>
  );
}

function EmptyChats({ onStart }) {
  const { theme } = useTheme();
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
      padding: 60,
      textAlign: 'center',
    }}>
      <div style={{
        width: 80, height: 80, borderRadius: 24,
        background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 20,
      }}>
        <MessageSquarePlus size={36} color="#fff" />
      </div>
      <h2 style={{ color: theme.text, fontSize: 18, fontWeight: 600 }}>Start a conversation</h2>
      <p style={{ color: theme.textSecondary, fontSize: 13, marginTop: 8, maxWidth: 220 }}>
        Message the people who matter to you.
      </p>
      <button onClick={onStart} style={{
        marginTop: 20,
        padding: '12px 24px',
        borderRadius: 12,
        background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
        color: '#fff',
        fontSize: 14,
        fontWeight: 600,
      }}>
        Start New Chat
      </button>
    </div>
  );
}
