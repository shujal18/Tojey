import React, { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../services/AuthContext';
import { ChevronRight, Moon, Sun, Monitor, Bell, Volume2, Vibrate, Image as ImageIcon, Type, Lock } from 'lucide-react';

export default function SettingsScreen() {
  const { theme, mode, setMode } = useTheme();
  const { user } = useAuth();
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('tojey-font') || '16'));
  const [readReceipts, setReadReceipts] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [sound, setSound] = useState(true);
  const [vibration, setVibration] = useState(true);

  const setFont = (v) => {
    setFontSize(v);
    localStorage.setItem('tojey-font', v);
  };

  const themeOptions = [
    { key: 'system', label: 'System Default', icon: <Monitor size={18} /> },
    { key: 'light', label: 'Light', icon: <Sun size={18} /> },
    { key: 'dark', label: 'Dark', icon: <Moon size={18} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <div style={{ padding: '16px 16px 12px' }}>
        <h1 style={{ color: theme.text, fontSize: 24, fontWeight: 700 }}>Settings</h1>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', padding: '16px',
        background: theme.background, marginBottom: 8,
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 28,
          background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24, fontWeight: 600, marginRight: 16,
        }}>
          {user.displayName[0].toUpperCase()}
        </div>
        <div>
          <div style={{ color: theme.text, fontSize: 18, fontWeight: 700 }}>
            {user.displayName}
          </div>
          <div style={{ color: theme.textSecondary, fontSize: 13 }}>
            @{user.username} · online
          </div>
        </div>
      </div>

      <Section title="Appearance">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {themeOptions.map(o => (
            <button key={o.key} onClick={() => setMode(o.key)} style={{
              flex: 1, padding: '10px', borderRadius: 12,
              background: mode === o.key ? theme.primary : theme.inputBg,
              color: mode === o.key ? '#fff' : theme.textSecondary,
              fontSize: 12, fontWeight: 500,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
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

        <Row label="Chat Wallpaper" icon={<ImageIcon size={18} />} />
      </Section>

      <Section title="Privacy">
        <ToggleRow label="Read Receipts" icon={<Lock size={18} />} value={readReceipts} onChange={setReadReceipts} />
      </Section>

      <Section title="Notifications">
        <ToggleRow label="Message Notifications" icon={<Bell size={18} />} value={notifications} onChange={setNotifications} />
        <ToggleRow label="Sound" icon={<Volume2 size={18} />} value={sound} onChange={setSound} />
        <ToggleRow label="Vibration" icon={<Vibrate size={18} />} value={vibration} onChange={setVibration} />
      </Section>

      <div style={{ padding: 24, textAlign: 'center', color: theme.textSecondary, fontSize: 13 }}>
        Tojey · Private Chat · v1.0.0
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

function Row({ label, icon, children, onPress }) {
  const { theme } = useTheme();
  return (
    <button onClick={onPress} style={{
      width: '100%', display: 'flex', alignItems: 'center',
      padding: '14px 16px', color: theme.text, fontSize: 14,
      borderBottom: `1px solid ${theme.border}`,
      background: 'transparent',
    }}>
      <span style={{ color: theme.primary, marginRight: 12, display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      {children && <span style={{ flex: 1, textAlign: 'right' }}>{children}</span>}
      <ChevronRight size={16} color={theme.textSecondary} />
    </button>
  );
}

function ToggleRow({ label, icon, value, onChange }) {
  const { theme } = useTheme();
  return (
    <div style={{
      width: '100%', display: 'flex', alignItems: 'center',
      padding: '14px 16px', color: theme.text, fontSize: 14,
      borderBottom: `1px solid ${theme.border}`,
    }}>
      <span style={{ color: theme.primary, marginRight: 12, display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <button onClick={() => onChange(!value)} style={{
        width: 44, height: 24, borderRadius: 12,
        background: value ? theme.primary : theme.textSecondary,
        position: 'relative', transition: 'background 0.2s',
      }}>
        <div style={{
          position: 'absolute', top: 2,
          left: value ? 22 : 2,
          width: 20, height: 20, borderRadius: 10,
          background: '#fff', transition: 'left 0.2s',
        }} />
      </button>
    </div>
  );
}
