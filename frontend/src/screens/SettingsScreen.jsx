import React, { useState, useRef } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../services/AuthContext';
import { ChevronRight, Moon, Sun, Monitor, Type, Lock, LogOut, Camera, User, IdCard } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || '';

export default function SettingsScreen({ onLogout }) {
  const { theme, mode, setMode } = useTheme();
  const { user, token, setUser } = useAuth();
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('tojey-font') || '16'));
  const fileRef = useRef(null);

  const setFont = (v) => {
    setFontSize(v);
    localStorage.setItem('tojey-font', v);
  };

  const themeOptions = [
    { key: 'system', label: 'System', icon: <Monitor size={18} /> },
    { key: 'light', label: 'Light', icon: <Sun size={18} /> },
    { key: 'dark', label: 'Dark', icon: <Moon size={18} /> },
  ];

  const uploadProfilePic = async (file) => {
    if (!file) return;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const up = await fetch(`${API}/api/upload`, { method: 'POST', body: fd });
      const upData = await up.json();
      if (!upData.url) throw new Error('Upload failed');
      const res = await fetch(`${API}/api/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profilePic: upData.url }),
      });
      const data = await res.json();
      if (data.user) setUser(data.user);
    } catch (e) {
      alert('Could not update profile picture: ' + e.message);
    }
  };

  const profilePic = user.profilePic || '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <div style={{ padding: '16px 16px 12px' }}>
        <h1 style={{ color: theme.text, fontSize: 24, fontWeight: 700 }}>Settings</h1>
      </div>

      {/* Profile */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 16px',
        background: theme.background, marginBottom: 8,
      }}>
        <button
          onClick={() => fileRef.current?.click()}
          style={{
            position: 'relative', width: 84, height: 84, borderRadius: 42, border: 'none', cursor: 'pointer',
            background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 34, fontWeight: 600, overflow: 'hidden',
          }}
        >
          {profilePic ? (
            <img src={profilePic} alt="profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            user.displayName[0].toUpperCase()
          )}
          <span style={{
            position: 'absolute', right: 0, bottom: 0, width: 28, height: 28, borderRadius: 14,
            background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Camera size={14} color="#fff" />
          </span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => uploadProfilePic(e.target.files?.[0])} />
        <div style={{ color: theme.text, fontSize: 18, fontWeight: 700, marginTop: 12 }}>
          {user.displayName}
        </div>
        <div style={{ color: theme.textSecondary, fontSize: 13, marginTop: 2 }}>
          @{user.username} · online
        </div>
      </div>

      <Section title="Appearance">
        <div style={{ display: 'flex', gap: 8, padding: '12px 16px' }}>
          {themeOptions.map(o => (
            <button key={o.key} onClick={() => setMode(o.key)} style={{
              flex: 1, padding: '10px', borderRadius: 12,
              background: mode === o.key ? theme.primary : theme.inputBg,
              color: mode === o.key ? '#fff' : theme.textSecondary,
              fontSize: 12, fontWeight: 500,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              cursor: 'pointer', border: 'none',
            }}>
              {o.icon} {o.label}
            </button>
          ))}
        </div>
        <Row label={`Font Size: ${fontSize}px`} icon={<Type size={18} />}>
          <input type="range" min="12" max="22" value={fontSize}
            onChange={(e) => setFont(parseInt(e.target.value))}
            style={{ width: '100%', accentColor: theme.primary }} />
        </Row>
      </Section>

      <Section title="Privacy">
        <Row label="Last seen & online" icon={<User size={18} />} chevron={false}
          desc="Choose who can see your online status" />
      </Section>

      <div style={{ padding: 24, textAlign: 'center' }}>
        <button onClick={onLogout} style={{
          width: '100%', padding: '14px', borderRadius: 12, cursor: 'pointer', border: 'none',
          color: theme.danger, fontSize: 15, fontWeight: 700,
          background: 'rgba(229,57,53,0.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <LogOut size={18} /> Log Out
        </button>
        <div style={{ color: theme.textSecondary, fontSize: 13, marginTop: 20 }}>
          Tojey · Private Chat · v1.1.0
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  const { theme } = useTheme();
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, color: theme.primary }}>
        {title}
      </div>
      <div style={{ background: theme.card, margin: '0 12px', borderRadius: 16, overflow: 'hidden', boxShadow: theme.shadow }}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, icon, children, onPress, chevron = true, desc }) {
  const { theme } = useTheme();
  return (
    <button onClick={onPress} style={{
      width: '100%', display: 'flex', alignItems: 'center',
      padding: '14px 16px', color: theme.text, fontSize: 14,
      borderBottom: `1px solid ${theme.border}`,
      background: 'transparent', cursor: 'pointer',
    }}>
      <span style={{ color: theme.primary, marginRight: 12, display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1, textAlign: 'left' }}>
        {label}
        {desc && <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{desc}</div>}
      </span>
      {children && <span style={{ flex: 1, textAlign: 'right' }}>{children}</span>}
      {chevron && <ChevronRight size={16} color={theme.textSecondary} />}
    </button>
  );
}
