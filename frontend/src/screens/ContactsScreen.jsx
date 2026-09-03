import React, { useState, useMemo } from 'react';
import { useChat } from '../services/ChatContext';
import { useTheme } from '../theme/ThemeContext';
import { Search } from 'lucide-react';

export default function ContactsScreen({ onOpenChat }) {
  const { theme } = useTheme();
  const { users, presence } = useChat();
  const [query, setQuery] = useState('');

  const contacts = useMemo(
    () => users.filter(u => !query || u.display_name.toLowerCase().includes(query.toLowerCase())),
    [users, query]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 16px 8px' }}>
        <h1 style={{ color: theme.text, fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Contacts</h1>
        <div style={{
          display: 'flex', alignItems: 'center', background: theme.inputBg,
          borderRadius: 12, padding: '10px 14px', gap: 8,
        }}>
          <Search size={18} color={theme.textSecondary} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people"
            style={{ flex: 1, background: 'transparent', color: theme.text, fontSize: 14 }}
          />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {contacts.map(c => (
          <button key={c.id} onClick={() => onOpenChat(c)} style={{
            width: '100%', display: 'flex', alignItems: 'center',
            padding: '10px 16px', background: theme.background,
          }}>
            <div style={{
              width: 46, height: 46, borderRadius: 23,
              background: c.id === 1 ? '#6C3CE9' : '#4E22B8',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, fontWeight: 600, marginRight: 12, overflow: 'hidden', flexShrink: 0,
            }}>
              {c.profile_pic_url
                ? <img src={c.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : c.display_name[0].toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: theme.text, fontSize: 16, fontWeight: 600 }}>{c.display_name}</div>
              <div style={{ color: theme.textSecondary, fontSize: 13 }}>
                {presence[c.id]?.isOnline ? 'online' : 'tap to say hello'}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
