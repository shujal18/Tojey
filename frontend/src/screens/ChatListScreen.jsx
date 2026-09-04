import React, { useState, useMemo, useEffect } from 'react';
import { useChat } from '../services/ChatContext';
import { useAuth } from '../services/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { Search, MessageSquarePlus, Trash2 } from 'lucide-react';

export default function ChatListScreen({ onOpenChat }) {
  const { theme } = useTheme();
  const { users, conversations, presence, clearConversation } = useChat();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [clearTarget, setClearTarget] = useState(null);

  const contacts = useMemo(
    () => users.filter(u => u.id !== user.id),
    [users, user.id]
  );

  const convoMap = useMemo(() => {
    const m = {};
    conversations.forEach(c => { m[c.other.id] = c; });
    return m;
  }, [conversations]);

  const items = useMemo(() => {
    const list = contacts.map(c => {
      const conv = convoMap[c.id];
      const pres = presence[c.id] || {};
      return {
        contact: c,
        lastMessage: conv?.lastMessage || null,
        isOnline: pres.isOnline,
        lastSeen: pres.lastSeen,
      };
    });
    list.sort((a, b) => {
      const ta = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0;
      const tb = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0;
      return tb - ta;
    });
    return list;
  }, [contacts, convoMap, presence]);

  useEffect(() => {
    if (query.trim()) {
      setSearchResults(items.filter(i => i.contact.display_name.toLowerCase().includes(query.toLowerCase())));
    } else {
      setSearchResults([]);
    }
  }, [query, items]);

  const startClear = (item, e) => {
    e.stopPropagation();
    setClearTarget(item);
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
            searchResults.map(item => (
              <ConversationRow key={item.contact.id} item={item} onPress={() => onOpenChat(item.contact)} onClear={(e) => startClear(item, e)} />
            ))
          ) : (
            <EmptySearch />
          )
        ) : (
          items.length > 0 ? items.map(item => (
            <ConversationRow key={item.contact.id} item={item} onPress={() => onOpenChat(item.contact)} onClear={(e) => startClear(item, e)} />
          )) : (
            <EmptyChats onStart={() => {}} />
          )
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

      {clearTarget && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 50,
          padding: 24,
        }}>
          <div style={{
            background: theme.card,
            borderRadius: 16,
            padding: 22,
            width: '100%',
            maxWidth: 340,
            boxShadow: theme.shadow,
          }}>
            <h3 style={{ color: theme.text, fontSize: 17, fontWeight: 700, margin: 0 }}>
              Clear chat with {clearTarget.contact.display_name}?
            </h3>
            <p style={{ color: theme.textSecondary, fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              This will delete this conversation for both users, on all devices and from the server.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button onClick={() => setClearTarget(null)} style={{
                padding: '10px 18px',
                borderRadius: 10,
                background: theme.inputBg,
                color: theme.text,
                fontWeight: 600,
              }}>Cancel</button>
              <button onClick={() => { clearConversation(clearTarget.contact.id); setClearTarget(null); }} style={{
                padding: '10px 18px',
                borderRadius: 10,
                background: '#E53935',
                color: '#fff',
                fontWeight: 600,
              }}>Clear</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ConversationRow({ item, onPress, onClear }) {
  const { theme } = useTheme();
  const { contact, lastMessage, isOnline, lastSeen } = item;
  const [avatarColor] = useState(() => {
    const colors = ['#6C3CE9', '#4E22B8', '#7C4DFF', '#9C6BFF', '#B39DDB'];
    return colors[Math.floor(Math.random() * colors.length)];
  });

  const initial = contact.display_name ? contact.display_name[0].toUpperCase() : '?';
  const preview = lastMessage
    ? (lastMessage.content ? lastMessage.content : (lastMessage.type === 'VOICE' ? '🎤 Voice message' : '📎 Media'))
    : (isOnline ? 'Online' : statusText(lastSeen));
  const time = lastMessage ? fmtTime(new Date(lastMessage.created_at)) : '';

  return (
    <div onClick={onPress} style={{
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      padding: '10px 16px',
      background: theme.background,
      transition: 'background 0.15s',
      position: 'relative',
      cursor: 'pointer',
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
          overflow: 'hidden',
        }}>
          {contact.profile_pic_url
            ? <img src={contact.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : initial}
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
          {time && <span style={{ color: theme.textSecondary, fontSize: 12 }}>{time}</span>}
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
            {preview}
          </span>
          <button onClick={onClear} title="Clear chat" style={{
            color: theme.textSecondary,
            padding: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
          }}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function statusText(lastSeen) {
  if (!lastSeen) return 'Offline';
  const d = new Date(lastSeen);
  if (isNaN(d.getTime())) return 'Offline';
  const now = Date.now();
  const mins = Math.floor((now - d.getTime()) / 60000);
  if (mins < 1) return 'Active now';
  if (mins < 60) return `last seen ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h`;
  return `last seen ${d.getDate()}/${d.getMonth() + 1}`;
}

function fmtTime(d) {
  const now = Date.now();
  const diff = (now - d.getTime()) / 60000;
  if (diff < 1) return 'now';
  if (diff < 60) return `${Math.floor(diff)}m`;
  if (diff < 1440) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function EmptySearch() {
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
