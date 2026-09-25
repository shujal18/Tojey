import React, { useState } from 'react';
import { X, Download, ChevronDown, ChevronUp } from 'lucide-react';
import { resolveUrl, isVideoMime, formatBytes } from '../services/upload';
import { useTheme } from '../theme/ThemeContext';

// Full-screen media viewer/lightbox. Mirrors the app's MediaViewer with zoom,
// download, caption + sender info.
export default function MediaViewer({ message, senderName, isSent, onClose }) {
  const { theme } = useTheme();
  const [zoom, setZoom] = useState(1);
  const url = resolveUrl(message.media_url);
  const isVideo = isVideoMime(message.mime_type) || /\.(mp4|webm|mov|mkv)$/i.test(message.media_url || '');
  const cap = message.content;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 3000,
      background: 'rgba(6,5,10,0.95)',
      display: 'flex', flexDirection: 'column',
    }} onClick={onClose}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 16px', color: '#fff',
      }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={{ color: '#fff', padding: 6 }}>
          <X size={24} />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{senderName || 'Media'}</div>
          {(message.created_at || message.duration) && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
              {message.created_at ? new Date(message.created_at).toLocaleString() : ''}
              {message.duration ? `  •  ${Math.round(message.duration)}s` : ''}
            </div>
          )}
        </div>
        <a href={url} download target="_blank" rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ color: '#fff', padding: 6 }}>
          <Download size={22} />
        </a>
      </div>

      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', position: 'relative',
      }}>
        {isVideo ? (
          <video src={url} controls autoPlay style={{
            maxWidth: '100%', maxHeight: '100%', background: '#000', outline: 'none',
          }} onClick={(e) => e.stopPropagation()} />
        ) : (
          <img
            src={url}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              transform: `scale(${zoom})`,
              transition: 'transform 0.2s ease',
              objectFit: 'contain',
              cursor: 'zoom-in',
            }}
            onWheel={(e) => {
              const next = Math.max(1, Math.min(4, zoom + (e.deltaY < 0 ? 0.2 : -0.2)));
              setZoom(next);
            }}
            onDoubleClick={(e) => { e.stopPropagation(); setZoom((z) => (z > 1 ? 1 : 2.2)); }}
          />
        )}
      </div>

      {cap && (
        <div style={{
          padding: '12px 16px', textAlign: 'center',
          color: 'rgba(255,255,255,0.9)', fontSize: 14, maxHeight: 90, overflowY: 'auto',
        }} onClick={(e) => e.stopPropagation()}>
          {cap}
        </div>
      )}

      {!isVideo && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
          padding: '10px 0 16px', color: 'rgba(255,255,255,0.8)', fontSize: 13,
        }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setZoom((z) => Math.min(4, z + 0.5))} style={{ color: '#fff', padding: 6 }}>
            <ChevronUp size={20} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.max(1, z - 0.5))} style={{ color: '#fff', padding: 6 }}>
            <ChevronDown size={20} />
          </button>
        </div>
      )}
    </div>
  );
}