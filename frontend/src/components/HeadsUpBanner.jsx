import React, { useEffect, useRef, useState } from 'react';
import { useChat } from '../services/ChatContext';
import { useTheme } from '../theme/ThemeContext';

const ABS = (u) => (u && u.startsWith('/') ? (import.meta.env.VITE_API_URL || '') + u : u);

// WhatsApp / Facebook-Lite style in-app heads-up banner for the web tab. Shows when a
// chat message arrives while a different screen/chat is open - self-rendered, so it needs
// no browser permission or FCM; the socket already delivered the message.
export default function HeadsUpBanner() {
  const { banner, dismissBanner, openConversation, openChatScreen, users } = useChat();
  const { theme } = useTheme();
  const [visible, setVisible] = useState(null);
  const timer = useRef(null);
  const shownRef = useRef(null);

  useEffect(() => {
    if (!banner) return;
    if (shownRef.current === banner.key) return;
    shownRef.current = banner.key;
    setVisible(banner);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setVisible(null);
      dismissBanner();
    }, 4000);
  }, [banner, dismissBanner]);

  useEffect(() => {
    if (visible && banner && banner.key !== visible.key) {
      // A newer banner arrived while this one was showing - refresh it.
      setVisible(banner);
    }
  }, [banner, visible]);

  if (!visible) return null;

  const name = visible.senderName || 'Tojey';
  const body = visible.preview || 'New message';
  const pic = visible.senderPic ? ABS(visible.senderPic) : null;

  const open = () => {
    const other = (users || []).find((u) => String(u.id) === String(visible.senderId)) || null;
    if (other) {
      openConversation(other);
      if (openChatScreen) openChatScreen(other);
    }
    setVisible(null);
    dismissBanner();
  };

  return (
    <div
      onClick={open}
      style={{
        position: 'fixed',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(96vw, 460px)',
        zIndex: 999,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 14,
        background: 'rgba(28,26,35,0.96)',
        color: '#F2F0F7',
        cursor: 'pointer',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        fontFamily: 'inherit',
        animation: 'tojeyDrop 0.25s ease-out',
      }}
    >
      {pic ? (
        <img src={pic} alt="" style={{ width: 38, height: 38, borderRadius: 19, objectFit: 'cover' }} />
      ) : (
        <div style={{
          width: 38, height: 38, borderRadius: 19, background: theme.primary || '#6C3CE9',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: 16,
        }}>
          {(name || 'T').slice(0, 1).toUpperCase()}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
        <div style={{ color: '#B4AFBD', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{body}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); setVisible(null); dismissBanner(); }}
        style={{
          background: 'none', border: 'none', color: '#8A8691', cursor: 'pointer',
          fontSize: 16, padding: '2px 6px', lineHeight: 1,
        }}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = '@keyframes tojeyDrop { from { opacity: 0; transform: translate(-50%, -16px); } to { opacity: 1; transform: translate(-50%, 0); } }';
  document.head.appendChild(style);
}