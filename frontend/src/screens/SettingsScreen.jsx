import React, { useState, useRef } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../services/AuthContext';
import { useChat } from '../services/ChatContext';
import { ChevronRight, Moon, Sun, Monitor, Type, Lock, LogOut, Camera, User, IdCard, Image as ImageIcon, Palette } from 'lucide-react';
import { wallpapers, chatColors, getChatColor, setChatColor, shadeColor, quickReactions } from '../theme';

const API = import.meta.env.VITE_API_URL || '';

export default function SettingsScreen({ onLogout }) {
  const { theme, mode, setMode } = useTheme();
  const { user, token, setUser } = useAuth();
  const { wallpaper, setWallpaper } = useChat();
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('tojey-font') || '16'));
  const [showWallpapers, setShowWallpapers] = useState(false);
  const [chatColor, setChatColorState] = useState(getChatColor());
  const fileRef = useRef(null);

  const setFont = (v) => {
    setFontSize(v);
    localStorage.setItem('tojey-font', v);
  };

  const pickColor = (c) => {
    setChatColor(c);
    setChatColorState(c);
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

      <Section title="Chat">
        <button onClick={() => setShowWallpapers(s => !s)} style={{
          width: '100%', display: 'flex', alignItems: 'center',
          padding: '14px 16px', color: theme.text, fontSize: 14,
          borderBottom: `1px solid ${theme.border}`,
          background: 'transparent',
        }}>
          <span style={{ color: theme.primary, marginRight: 12, display: 'flex' }}><ImageIcon size={18} /></span>
          <span style={{ flex: 1, textAlign: 'left' }}>
            Wallpaper
            {wallpaper && <div style={{ fontSize: 12, color: theme.textSecondary, marginTop: 2 }}>{wallpaper.name}</div>}
          </span>
          <span style={{
            width: 44, height: 44, borderRadius: 12, marginLeft: 8,
            background: wallpaper && wallpaper.url.startsWith('linear') ? wallpaper.url
              : wallpaper && wallpaper.url.startsWith('radial') ? wallpaper.url
                : wallpaper && wallpaper.url.includes('background-size') ? wallpaper.url.split(';')[0]
                  : 'linear-gradient(135deg,#6C3CE9,#4E22B8)',
          }} />
        </button>
        {showWallpapers && (
          <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, borderBottom: `1px solid ${theme.border}` }}>
            {wallpapers.map(w => (
              <button key={w.id} onClick={() => { setWallpaper(w); setShowWallpapers(false); }} style={{
                height: 64, borderRadius: 12, overflow: 'hidden',
                background: w.url.startsWith('linear') || w.url.startsWith('radial') ? w.url
                  : w.url.includes('background-size') ? undefined : w.url,
                ...(w.url.includes('background-size') ? { background: w.url.slice(0, w.url.indexOf(';')) } : {}),
                border: wallpaper?.id === w.id ? `2px solid ${theme.primary}` : '2px solid transparent',
                position: 'relative', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 6,
              }}>
                <span style={{ fontSize: 10, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.8)', fontWeight: 600 }}>
                  {w.name}
                </span>
              </button>
            ))}
          </div>
        )}

        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Palette size={18} color={theme.primary} />
            <span style={{ color: theme.text, fontSize: 14 }}>Chat color</span>
            <span style={{ color: theme.textSecondary, fontSize: 12, marginLeft: 'auto' }}>sent bubbles</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {chatColors.map(c => (
              <button key={c} onClick={() => pickColor(c)} style={{
                width: 38, height: 38, borderRadius: 12,
                background: `linear-gradient(135deg, ${c} 0%, ${shadeColor(c, -40)} 100%)`,
                border: chatColor === c ? '3px solid #fff' : '2px solid transparent',
                boxShadow: chatColor === c ? `0 0 0 2px ${c}` : 'none',
              }}>
                {chatColor === c && <span style={{ color: '#fff', fontSize: 16 }}>✓</span>}
              </button>
            ))}
          </div>
        </div>
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
