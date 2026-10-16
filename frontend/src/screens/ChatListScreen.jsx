import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useChat } from '../services/ChatContext';
import { useAuth } from '../services/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { Search, MessageSquarePlus, Trash2, Check, CheckCheck, X } from 'lucide-react';

export default function ChatListScreen({ onOpenChat }) {
  const { theme } = useTheme();
  const { users, conversations, presence, clearConversation } = useChat();
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [clearTarget, setClearTarget] = useState(null);
  const searchInputRef = useRef(null);

  const focusSearch = () => {
    searchInputRef.current?.focus();
  };

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
        isOnCall: !!pres.onCall,
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', background: theme.sidebarBg }}>
      {/* Header — WhatsApp-Web style: title + new-chat action */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 16px',
        background: theme.panelHeader,
        borderBottom: `1px solid ${theme.border}`,
        flexShrink: 0,
      }}>
        <h1 style={{ color: theme.text, fontSize: 20, fontWeight: 700, letterSpacing: 0.2 }}>Chats</h1>
        <button
          onClick={focusSearch}
          title="New chat"
          className="tf-icon-btn"
          style={{ color: theme.textSecondary, padding: 8, display: 'flex', borderRadius: '50%' }}
        >
          <MessageSquarePlus size={20} />
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', flexShrink: 0, background: theme.sidebarBg }}>
        <div style={{
          display: 'flex', alignItems: 'center', background: theme.inputBg,
          borderRadius: 10, padding: '8px 12px', gap: 8,
        }}>
          <Search size={17} color={theme.textSecondary} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or start new chat"
            style={{ flex: 1, background: 'transparent', color: theme.text, fontSize: 14 }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ color: theme.textSecondary, display: 'flex' }}>
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {query.trim() ? (
          searchResults.length > 0 ? (
            searchResults.map(item => (
              <ConversationRow key={item.contact.id} item={item} onPress={() => onOpenChat(item.contact)} onClear={(e) => startClear(item, e)} />
            ))
          ) : (
            <EmptySearch query={query} />
          )
        ) : (
          items.length > 0 ? items.map(item => (
            <ConversationRow key={item.contact.id} item={item} onPress={() => onOpenChat(item.contact)} onClear={(e) => startClear(item, e)} />
          )) : (
            <EmptyChats onStart={focusSearch} />
          )
        )}
      </div>

      {clearTarget && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 50, padding: 24,
        }}>
          <div style={{ background: theme.card, borderRadius: 16, padding: 22, width: '100%', maxWidth: 340, boxShadow: theme.shadow }}>
            <h3 style={{ color: theme.text, fontSize: 17, fontWeight: 700, margin: 0 }}>
              Clear chat with {clearTarget.contact.display_name}?
            </h3>
            <p style={{ color: theme.textSecondary, fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              This will delete this conversation for both users, on all devices and from the server.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button onClick={() => setClearTarget(null)} style={{
                padding: '10px 18px', borderRadius: 10, background: theme.inputBg, color: theme.text, fontWeight: 600,
              }}>Cancel</button>
              <button onClick={() => { clearConversation(clearTarget.contact.id); setClearTarget(null); }} style={{
                padding: '10px 18px', borderRadius: 10, background: '#E53935', color: '#fff', fontWeight: 600,
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
  const { unread } = useChat();
  const { user } = useAuth();
  const { contact, lastMessage, isOnline, lastSeen, isOnCall } = item;
  const [avatarColor] = useState(() => {
    const colors = ['#6C3CE9', '#4E22B8', '#7C4DFF', '#9C6BFF', '#B39DDB'];
    return colors[Math.floor(Math.random() * colors.length)];
  });
  const [hover, setHover] = useState(false);
  const count = unread[contact.id] || 0;

  const initial = contact.display_name ? contact.display_name[0].toUpperCase() : '?';
  let preview = '';
  if (lastMessage) {
    if (lastMessage.type === 'VOICE') preview = '🎤 Voice message';
    else if (lastMessage.type === 'IMAGE') preview = '📷 Photo';
    else if (lastMessage.type === 'VIDEO') preview = '🎬 Video';
    else if (lastMessage.content) preview = lastMessage.content;
    else preview = '📎 Attachment';
  }
  const time = lastMessage ? fmtTime(new Date(lastMessage.created_at)) : '';
  const mine = lastMessage && lastMessage.sender_id === user.id;

  return (
    <div
      onClick={onPress}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 14px',
        background: hover ? theme.rowHover : 'transparent',
        transition: 'background 0.12s',
        position: 'relative', cursor: 'pointer',
      }}
    >
      <div style={{ position: 'relative', marginRight: 13, flexShrink: 0 }}>
        <div style={{
          width: 49, height: 49, borderRadius: 25, background: avatarColor, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 19, fontWeight: 600, overflow: 'hidden',
        }}>
          {contact.profile_pic_url
            ? <img src={contact.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : initial}
        </div>
        {isOnline && (
          <div style={{
            position: 'absolute', bottom: 1, right: 1, width: 12, height: 12, borderRadius: 6,
            background: theme.online, border: `2px solid ${theme.sidebarBg}`,
          }} />
        )}
      </div>

      <div style={{ flex: 1, overflow: 'hidden', borderBottom: `1px solid ${theme.border}`, paddingBottom: 10, marginBottom: -10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ color: theme.text, fontSize: 15.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {contact.display_name}
          </span>
          <span style={{ color: count ? theme.primary : theme.textSecondary, fontSize: 12, flexShrink: 0, fontWeight: count ? 600 : 400 }}>
            {time}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 3, gap: 8 }}>
          <span style={{
            color: isOnCall ? theme.danger : theme.textSecondary,
            fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            fontWeight: isOnCall ? 600 : 400, display: 'flex', alignItems: 'center', gap: 4,
          }}>
            {mine && !isOnCall && (
              <StatusTick status={lastMessage?.status} color={theme.primary} />
            )}
            {isOnCall ? 'In a call…' : (preview || (isOnline ? 'Online' : statusText(lastSeen)))}
          </span>
          {count > 0 ? (
            <span style={{
              minWidth: 20, height: 20, borderRadius: 10, padding: '0 6px',
              background: theme.unreadBg, color: theme.unreadText,
              fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {count > 99 ? '99+' : count}
            </span>
          ) : hover ? (
            <button onClick={onClear} title="Clear chat" style={{
              color: theme.textSecondary, padding: 6, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'transparent', flexShrink: 0,
            }}>
              <Trash2 size={15} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusTick({ status, color }) {
  if (!status) return null;
  if (status === 'READ') return <CheckCheck size={15} color="#53C3FF" />;
  if (status === 'DELIVERED') return <CheckCheck size={15} color={color} />;
  return <Check size={15} color={color} />;
}

function statusText(lastSeen) {
  if (!lastSeen) return 'Offline';
  const d = new Date(lastSeen);
  if (isNaN(d.getTime())) return 'Offline';
  const now = Date.now();
  const mins = Math.floor((now - d.getTime()) / 60000);
  if (mins < 1) return 'Active now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
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

function EmptySearch({ query }) {
  const { theme } = useTheme();
  return (
    <div style={{ textAlign: 'center', padding: 50, color: theme.textSecondary }}>
      <Search size={36} color={theme.textSecondary} />
      <p style={{ marginTop: 14, fontSize: 15 }}>No chats matching “{query}”</p>
    </div>
  );
}

function EmptyChats({ onStart }) {
  const { theme } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', padding: 50, textAlign: 'center' }}>
      <div style={{
        width: 78, height: 78, borderRadius: 24,
        background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18,
      }}>
        <MessageSquarePlus size={34} color="#fff" />
      </div>
      <h2 style={{ color: theme.text, fontSize: 18, fontWeight: 600 }}>Start a conversation</h2>
      <p style={{ color: theme.textSecondary, fontSize: 13, marginTop: 8, maxWidth: 240 }}>
        Message the people who matter to you.
      </p>
      <button onClick={onStart} style={{
        marginTop: 18, padding: '11px 22px', borderRadius: 12,
        background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
        color: '#fff', fontSize: 14, fontWeight: 600,
      }}>
        Start New Chat
      </button>
    </div>
  );
}
