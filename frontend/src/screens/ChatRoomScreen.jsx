import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useChat } from '../services/ChatContext';
import { useTheme } from '../theme/ThemeContext';
import { ArrowLeft, Search, MoreVertical, Mic, Paperclip, Smile, Camera, Send, X, Reply as ReplyIcon, Copy, Pencil, Trash, Check, CheckCheck, Lock } from 'lucide-react';
import EmojiPicker from 'emoji-picker-react';
import { VoiceBubble } from '../components/MessageBubble';
import { quickReactions, wallpapers } from '../theme';

export default function ChatRoomScreen({ otherUser, currentUser, onBack }) {
  const { theme } = useTheme();
  const { conversation, openConversation, sendMessage, setConversation } = useChat();
  const { messages, typing, wallpaper } = conversation;

  useEffect(() => {
    openConversation(otherUser);
  }, [otherUser?.id]);

  useEffect(() => {
    return () => setConversation({ id: null, other: null, messages: [], typing: false });
  }, []);

  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [reactionBar, setReactionBar] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [lockedRecord, setLockedRecord] = useState(false);
  const listRef = useRef(null);
  const recTimer = useRef(null);
  const holdTimer = useRef(null);

  const myMessages = useMemo(() => messages.filter(m => m.sender_id === currentUser.id), [messages, currentUser.id]);
  void myMessages;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (recording) {
      recTimer.current = setInterval(() => setRecordTime(t => t + 1), 1000);
    } else if (recTimer.current) {
      clearInterval(recTimer.current);
    }
    return () => clearInterval(recTimer.current);
  }, [recording]);

  const sendText = () => {
    if (!text.trim()) return;
    const _tempId = Date.now();
    sendMessage({
      otherUserId: otherUser.id,
      type: 'TEXT',
      content: text.trim(),
      replyTo: replyingTo?.id || null,
      _tempId,
    });
    setText('');
    setReplyingTo(null);
    setShowEmoji(false);
  };

  const sendVoice = () => {
    sendMessage({
      otherUserId: otherUser.id,
      type: 'VOICE',
      duration: recordTime || 8,
      waveform: 'waveform-data',
      content: 'Voice message',
    });
    setRecording(false);
    setLockedRecord(false);
    setRecordTime(0);
  };

  const startRecording = () => {
    setRecording(true);
    setRecordTime(0);
    holdTimer.current = setTimeout(() => setLockedRecord(true), 500);
  };

  const stopRecording = (cancel) => {
    clearTimeout(holdTimer.current);
    if (cancel) {
      setRecording(false);
      setLockedRecord(false);
      setRecordTime(0);
      return;
    }
    if (recordTime < 1) {
      setRecording(false);
      setRecordTime(0);
      return;
    }
    setRecording(false);
    setLockedRecord(false);
    sendVoice();
  };

  const handleHoldEnd = () => {
    if (!lockedRecord) stopRecording(false);
  };

  const handleLongPress = (e, message) => {
    e.preventDefault();
    e.stopPropagation();
    setReactionBar(message);
  };

  const headerText = typing
    ? 'typing…'
    : otherUser.online
      ? 'online'
      : 'last seen recently';

  return (
    <div style={{
      height: '100vh',
      maxWidth: 480,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      background: wallpaper ? parseWallpaper(wallpaper, theme) : theme.background,
      position: 'relative',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 12px',
        background: wallpaper ? 'rgba(28,25,34,0.85)' : theme.navBg,
        backdropFilter: 'blur(8px)',
        borderBottom: `1px solid ${theme.border}`,
        zIndex: 5,
      }}>
        <button onClick={onBack} style={{ color: wallpaper ? '#fff' : theme.text, padding: 6, marginRight: 4 }}>
          <ArrowLeft size={22} />
        </button>
        <div style={{
          width: 40, height: 40, borderRadius: 20, marginRight: 10,
          background: otherUser.id === 1 ? '#6C3CE9' : '#4E22B8',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 16, overflow: 'hidden', flexShrink: 0,
        }}>
          {otherUser.profile_pic_url
            ? <img src={otherUser.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : otherUser.display_name[0].toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: wallpaper ? '#fff' : theme.text, fontSize: 16, fontWeight: 600 }}>
            {otherUser.display_name}
          </div>
          <div style={{ color: typing ? '#7C4DFF' : (wallpaper ? 'rgba(255,255,255,0.7)' : theme.textSecondary), fontSize: 12 }}>
            {typing ? <TypingDots /> : headerText}
          </div>
        </div>
        <button style={{ color: wallpaper ? '#fff' : theme.textSecondary, padding: 6 }}><Search size={20} /></button>
        <button style={{ color: wallpaper ? '#fff' : theme.textSecondary, padding: 6 }}><MoreVertical size={20} /></button>
      </div>

      {/* Messages */}
      <div ref={listRef} style={{
        flex: 1, overflowY: 'auto',
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 40, color: theme.textSecondary }}>
            <Lock size={28} style={{ margin: '0 auto 10px', opacity: 0.5 }} />
            <p style={{ fontSize: 14 }}>Messages are private</p>
            <p style={{ fontSize: 12, opacity: 0.7 }}>Say hello to {otherUser.display_name}</p>
          </div>
        )}

        {messages.map((m, idx) => {
          const isSent = m.sender_id === currentUser.id;
          const prev = messages[idx - 1];
          const grouped = prev && prev.sender_id === m.sender_id;
          return (
            <MessageRow
              key={m.id || idx}
              message={m}
              isSent={isSent}
              grouped={grouped}
              theme={theme}
              wallpaper={!!wallpaper}
              onLongPress={handleLongPress}
              onReply={() => { setReplyingTo(m); setReactionBar(null); }}
              onCopy={() => { if (m.content) navigator.clipboard?.writeText(m.content); setReactionBar(null); }}
              onEdit={() => { setText(m.content || ''); setReactionBar(null); }}
              onDelete={(mode) => { deleteMessage(m.id, mode); setReactionBar(null); }}
              onReact={() => setReactionBar(m)}
            />
          );
        })}
      </div>

      {/* Reactions bar */}
      {reactionBar && (
        <ReactionMenu message={reactionBar} theme={theme} onReact={(r) => { reactTo(reactionBar.id, r); setReactionBar(null); }} onReply={() => { setReplyingTo(reactionBar); setReactionBar(null); }} onCopy={() => { if (reactionBar.content) navigator.clipboard?.writeText(reactionBar.content); setReactionBar(null); }} onEdit={() => { setText(reactionBar.content || ''); setReactionBar(null); }} onDelete={(mode) => { deleteMessage(reactionBar.id, mode); setReactionBar(null); }} isMine={reactionBar.sender_id === currentUser.id} />
      )}

      {/* Replying bar */}
      {replyingTo && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '8px 14px', background: theme.card,
          borderTop: `1px solid ${theme.border}`,
          fontSize: 13,
        }}>
          <div style={{ width: 3, height: 32, background: theme.primary, borderRadius: 2, marginRight: 10 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: theme.primary, fontWeight: 600, fontSize: 12 }}>
              Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUser.display_name}
            </div>
            <div style={{ color: theme.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {replyingTo.type === 'VOICE' ? '🎤 Voice message' : (replyingTo.content || 'Media message')}
            </div>
          </div>
          <button onClick={() => setReplyingTo(null)} style={{ color: theme.textSecondary }}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Recording UI */}
      {recording && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '12px 16px', background: theme.card,
          borderTop: `1px solid ${theme.border}`,
        }}>
          <button onClick={() => stopRecording(true)} style={{ color: theme.danger, marginRight: 12 }}>
            <CircleX2Icon size={22} />
          </button>
          {[5,9,13,18,11,7,15,20,9,14].map((h,i) => (
            <span key={i} className="wave-bar" style={{
              width: 3, height: `${h}px`,
              background: theme.primary, marginRight: 2,
              animationDelay: `${i * 0.08}s`,
            }} />
          ))}
          <span style={{ marginLeft: 'auto', color: theme.text, fontWeight: 600, fontSize: 14 }}>
            0:{String(recordTime).padStart(2, '0')}
          </span>
        </div>
      )}

      {/* Composer */}
      <div style={{
        background: theme.composerBg,
        borderTop: `1px solid ${theme.border}`,
        padding: '8px 10px',
        paddingBottom: 14,
      }}>
        {showEmoji && (
          <div style={{ marginBottom: 8, borderRadius: 12, overflow: 'hidden' }}>
            <EmojiPicker onEmojiClick={(e) => setText(t => t + e.emoji)} width="100%" height={260} theme={theme.isDark ? 'dark' : 'light'} />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconBtn onClick={() => setShowEmoji(!showEmoji)} icon={<Smile size={22} />} theme={theme} active={showEmoji} />
          <IconBtn icon={<Paperclip size={20} />} theme={theme} />

          <div style={{
            flex: 1, display: 'flex', alignItems: 'center',
            background: theme.inputBg, borderRadius: 22, padding: '8px 14px',
          }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendText()}
              placeholder="Message"
              style={{ flex: 1, background: 'transparent', color: theme.text, fontSize: 14 }}
            />
          </div>

          <IconBtn icon={<Camera size={22} />} theme={theme} />

          {text.trim() ? (
            <button onClick={sendText} style={{
              width: 42, height: 42, borderRadius: 21,
              background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 3px 10px rgba(108,60,233,0.4)',
            }}>
              <Send size={18} />
            </button>
          ) : (
            <div style={{ position: 'relative' }}
              onMouseDown={startRecording}
              onMouseUp={handleHoldEnd}
              onMouseLeave={() => recording && !lockedRecord && stopRecording(true)}
            >
              {recording ? (
                <button onClick={() => stopRecording(false)} style={{
                  width: 42, height: 42, borderRadius: 21,
                  background: theme.danger, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  animation: 'splashPulse 1s infinite',
                }}>
                  <Send size={16} />
                </button>
              ) : (
                <button style={{
                  width: 42, height: 42, borderRadius: 21,
                  background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 3px 10px rgba(108,60,233,0.4)',
                }}>
                  <Mic size={18} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  function deleteMessage(id, mode) {
    if (!window.__socket) return;
    window.__socket.emit('message:delete', { messageId: id, mode });
    if (mode === 'everyone') {
      setConversation(prev => ({
        ...prev,
        messages: prev.messages.map(m => (m.id === id ? { ...m, is_deleted_for_everyone: true, content: null, media_url: null } : m)),
      }));
    } else {
      setConversation(prev => ({ ...prev, messages: prev.messages.filter(m => m.id !== id) }));
    }
  }

  function reactTo(id, r) {
    if (!window.__socket) return;
    window.__socket.emit('message:react', { messageId: id, reaction: r });
    setConversation(prev => ({
      ...prev,
      messages: prev.messages.map(m => {
        if (m.id !== id) return m;
        const existing = (m.reactions || []).filter(x => x.user_id !== currentUser.id);
        return { ...m, reactions: r ? [...existing, { user_id: currentUser.id, reaction: r }] : existing };
      }),
    }));
  }
}

function CircleX2Icon({ size }) {
  return <X size={size} />;
}

function parseWallpaper(wp, theme) {
  if (!wp) return theme.background;
  if (wp.url.startsWith('linear') || wp.url.startsWith('radial')) return wp.url;
  return theme.background;
}

function IconBtn({ icon, onClick, theme, active }) {
  return (
    <button onClick={onClick} style={{
      color: active ? theme.primary : theme.textSecondary,
      padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {icon}
    </button>
  );
}

function TypingDots() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      typing{' '}
      {[0, 1, 2].map(i => (
        <span key={i} className="typing-dot" style={{
          background: '#7C4DFF', animationDelay: `${i * 0.2}s`,
          width: 5, height: 5,
        }} />
      ))}
    </span>
  );
}

function MessageRow({ message, isSent, grouped, theme, wallpaper, onLongPress, onReply, onCopy, onEdit, onDelete, onReact }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: isSent ? 'flex-end' : 'flex-start',
      marginTop: grouped ? 2 : 12,
    }}>
      <div style={{
        maxWidth: '75%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isSent ? 'flex-end' : 'flex-start',
      }}>
        <div
          onContextMenu={(e) => onLongPress(e, message)}
          onDoubleClick={(e) => onLongPress(e, message)}
          style={{
            background: isSent
              ? 'linear-gradient(135deg, #6C3CE9 0%, #5A2FD0 100%)'
              : (wallpaper ? 'rgba(255,255,255,0.9)' : theme.receivedBubble),
            color: isSent ? '#fff' : theme.receivedText,
            padding: '7px 11px',
            borderRadius: 14,
            borderBottomRightRadius: isSent ? (grouped ? 6 : 4) : 14,
            borderBottomLeftRadius: isSent ? 14 : (grouped ? 6 : 4),
            boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
            animation: 'message-enter 0.25s ease',
            position: 'relative',
            userSelect: 'text',
          }}
        >
          {message.reply_to && (
            <div style={{
              marginBottom: 4, padding: '4px 8px',
              background: isSent ? 'rgba(255,255,255,0.15)' : theme.primaryLight,
              borderRadius: 6, borderLeft: `3px solid ${theme.primary}`,
              fontSize: 12,
            }}>
              <div style={{ fontWeight: 600, color: isSent ? '#fff' : theme.primary, fontSize: 11 }}>
                {isSent ? 'You' : 'Reply'}
              </div>
              <div style={{ color: isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary, fontSize: 11 }}>
                preview…
              </div>
            </div>
          )}

          {renderContent(message, isSent, theme)}

          {message.media_url && message.type !== 'VOICE' && (
            <img src={message.media_url} alt="" style={{ maxWidth: 220, borderRadius: 8, marginTop: 4, display: 'block' }} />
          )}

          {!message.is_deleted_for_everyone && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 1 }}>
              {message.is_edited && <span style={{ fontSize: 10, opacity: 0.7, color: isSent ? 'rgba(255,255,255,0.7)' : theme.textSecondary }}>edited</span>}
              <span style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.75)' : theme.textSecondary }}>
                {timeOf(message.created_at)}
              </span>
              {isSent && (message.status === 'READ'
                ? <CheckCheck size={14} color={(isSent ? '#A5D6FF' : theme.primary)} />
                : message.status === 'DELIVERED'
                  ? <CheckCheck size={14} color={isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary} />
                  : <Check size={14} color={isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary} />)}
            </div>
          )}

          {message.is_deleted_for_everyone && (
            <div style={{ fontStyle: 'italic', opacity: 0.7, fontSize: 13, color: isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary }}>
              This message was deleted
            </div>
          )}
        </div>

        {message.is_view_once && (
          <div style={{ fontSize: 10, color: theme.textSecondary, marginTop: 2, display: 'flex', gap: 3, alignItems: 'center' }}>
            <Lock size={10} /> View once
          </div>
        )}

        {message.reactions && message.reactions.length > 0 && (
          <div style={{
            background: theme.primaryLight,
            borderRadius: 14, padding: '2px 8px',
            marginTop: -8, position: 'relative',
            fontSize: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          }}>
            {message.reactions.map((r, i) => (
              <span key={i} style={{ marginRight: 4 }}>{r.reaction}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  function renderContent(m, sent, th) {
    switch (m.type) {
      case 'VOICE':
        return <VoiceBubble message={m} isSent={sent} />;
      case 'IMAGE':
        return <div><span style={{ opacity: 0.9 }}>📷 Photo</span>{m.content && <div style={{ marginTop: 3 }}>{m.content}</div>}</div>;
      case 'VIDEO':
        return <div><span style={{ opacity: 0.9 }}>🎬 Video</span>{m.content && <div style={{ marginTop: 3 }}>{m.content}</div>}</div>;
      default:
        return <span style={{ fontSize: 15 }}>{m.content || ''}</span>;
    }
  }
}

function timeOf(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ReactionMenu({ message, theme, onReact, onReply, onCopy, onEdit, onDelete, isMine }) {
  return (
    <div style={{
      position: 'absolute', bottom: 90, left: 0, right: 0,
      display: 'flex', justifyContent: 'center',
      zIndex: 20, animation: 'pop 0.2s ease',
      pointerEvents: 'none',
    }}>
      <div style={{
        background: theme.card, borderRadius: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
        padding: 12, width: 'min(92%, 380px)',
        pointerEvents: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: theme.textSecondary, fontSize: 12 }}>Message actions</span>
          <button onClick={onReact} style={{ color: theme.primary, fontSize: 13, fontWeight: 600 }}>React +</button>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 10 }}>
          {quickReactions.map(r => (
            <button key={r} onClick={() => onReact(r)} style={{
              fontSize: 22, background: theme.primaryLight, borderRadius: 12,
              width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'transform 0.1s',
            }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 6 }}>
          {[
            { icon: <ReplyIcon size={16} />, label: 'Reply', action: onReply },
            { icon: <Copy size={16} />, label: 'Copy', action: onCopy },
            ...(isMine ? [{ icon: <Pencil size={16} />, label: 'Edit', action: onEdit }] : []),
            ...(isMine ? [{ icon: <Trash size={16} />, label: 'Delete for everyone', action: () => onDelete('everyone') }] : []),
            ...(isMine ? [{ icon: <Trash size={16} />, label: 'Delete for me', action: () => onDelete('me') }] : []),
          ].map(item => (
            <button key={item.label} onClick={item.action} style={{
              width: '100%', display: 'flex', alignItems: 'center',
              padding: '8px 10px', borderRadius: 10, color: theme.text,
              fontSize: 14, gap: 10, textAlign: 'left',
            }}>
              <span style={{ color: theme.primary }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
