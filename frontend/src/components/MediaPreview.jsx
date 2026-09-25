import React, { useState } from 'react';
import { X, FileText, Camera, Send, Pencil, Mic, Play, Trash2 } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext';
import { formatBytes, isVideoMime, isAudioMime } from '../services/upload';

// Pending-media strip shown above the composer before sending. Items are
// uploaded + sent together with a shared caption.
export default function MediaPreview({ items, isSending, onRemove, onDraw, onCaption, caption, onSend, onCancel }) {
  const { theme } = useTheme();
  const [showCaption, setShowCaption] = useState(true);

  if (!items || items.length === 0) return null;

  return (
    <div style={{
      background: theme.composerBg,
      borderTop: `1px solid ${theme.border}`,
      padding: '10px 14px',
      maxHeight: 320,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: theme.text, fontSize: 13, fontWeight: 600 }}>
          {items.length} {items.length === 1 ? 'attachment' : 'attachments'}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onCancel} style={{ color: theme.textSecondary, fontSize: 13 }}>Cancel</button>
      </div>

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6, minHeight: 74 }}>
        {items.map((item) => (
          <div key={item.id} style={{ position: 'relative', flexShrink: 0 }}>
            {item.kind === 'image' ? (
              <div style={{ position: 'relative', width: 64, height: 64, borderRadius: 10, overflow: 'hidden', background: '#1C1922' }}>
                <img src={item.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <button
                  onClick={() => onDraw(item)}
                  title="Open drawing"
                  style={{
                    position: 'absolute', right: 2, bottom: 2,
                    background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: 8,
                    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <Pencil size={13} />
                </button>
              </div>
            ) : item.kind === 'video' ? (
              <div style={{ width: 64, height: 64, borderRadius: 10, overflow: 'hidden', background: '#000', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <video src={item.preview} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                <Play size={18} color="#fff" style={{ position: 'absolute' }} />
              </div>
            ) : (
              <div style={{
                width: 64, height: 64, borderRadius: 10, background: theme.inputBg,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                padding: 4, gap: 2,
              }}>
                <FileText size={20} color={theme.primary} />
                <span style={{ fontSize: 9, color: theme.textSecondary, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.fileName || 'file'}
                </span>
              </div>
            )}
            <button onClick={() => onRemove(item.id)} style={{
              position: 'absolute', top: -6, right: -6,
              background: theme.danger, color: '#fff', borderRadius: 10,
              width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
            }}>
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {showCaption && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            value={caption}
            onChange={(e) => onCaption(e.target.value)}
            placeholder="Add a caption…"
            style={{
              flex: 1, background: theme.inputBg, borderRadius: 12, padding: '8px 12px',
              color: theme.text, fontSize: 13,
            }}
          />
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
        <button onClick={() => setShowCaption(s => !s)} style={{ color: theme.primary, fontSize: 12, fontWeight: 600 }}>
          {showCaption ? 'Hide caption' : 'Add caption'}
        </button>
        <button
          onClick={onSend}
          disabled={isSending}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
            color: '#fff', padding: '9px 18px', borderRadius: 20,
            fontWeight: 700, fontSize: 13, boxShadow: '0 3px 10px rgba(108,60,233,0.4)',
            opacity: isSending ? 0.6 : 1,
          }}
        >
          {isSending ? <Trash2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={15} />}
          {isSending ? 'Sending…' : `Send ${items.filter(i => i.kind !== 'voice').length || ''}`}
        </button>
      </div>
    </div>
  );
}