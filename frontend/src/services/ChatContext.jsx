import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { vibrateNudge, askNotifyPermission, showSystemNotification } from './nudge';
import { onWebPushForegroundMessage } from './webPush';

const ChatContext = createContext();

const NUDGE_COLORS = ['#7C4DFF', '#FF5252', '#FFB300', '#00C853', '#40C4FF', '#FF4081'];

function previewFromWeb(data) {
  const t = data.msgType;
  const p = data.msgPreview || data.body || '';
  if (t === 'VOICE') return 'Voice message' + (p ? ': ' + p : '');
  if (t === 'IMAGE') return 'Photo' + (p ? ': ' + p : '');
  if (t === 'VIDEO') return 'Video' + (p ? ': ' + p : '');
  if (t === 'FILE' || t === 'DOCUMENT') return 'File' + (p ? ': ' + p : '');
  return p || 'New message';
}

export function ChatProvider({ socket, currentUser, children }) {
  const [users, setUsers] = useState([]);
  const [conversation, setConversation] = useState({ id: null, other: null, messages: [], typing: false });
  const [presence, setPresence] = useState({});
  const [conversations, setConversations] = useState([]);
  const [wallpaper, setWallpaper] = useState(null);
  const [toast, setToast] = useState(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const toastTimer = useRef(null);
  const offlineQueueRef = useRef([]);
  const OFFLINE_KEY = 'tojey_offline_queue';

  useEffect(() => {
    try {
      const raw = localStorage.getItem(OFFLINE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) offlineQueueRef.current = parsed;
      }
    } catch (e) {}
  }, []);

  const persistQueue = () => {
    try {
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(offlineQueueRef.current));
    } catch (e) {}
  };

  const acceptAck = (tempId, message) => {
    const m = { ...message, _local: true };
    setConversation(prev => ({
      ...prev,
      messages: prev.messages.some(x => x._tempId === tempId)
        ? prev.messages.map(x => (x._tempId === tempId ? { ...m, _tempId: undefined } : x))
        : (prev.messages.some(x => x.id === message.id) ? prev : [...prev.messages, m]),
    }));
    socketRef.current?.emit('conversation:list');
  };

  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  useEffect(() => {
    if (!socket) return;
    fetchUsers();
    socket.emit('conversation:list');

    socket.on('connect', () => {
      const q = offlineQueueRef.current;
      if (q.length) {
        q.forEach(p => {
          socket.emit('message:send', p, (ack) => {
            if (ack && ack.ok) acceptAck(p._tempId, ack.message);
          });
        });
        offlineQueueRef.current = [];
        persistQueue();
        showToast(`Sent ${q.length} queued message${q.length > 1 ? 's' : ''}`);
      }
      socket.emit('conversation:list');
    });

    return () => {
      socket.off('connect');
    };
  }, [socket]);

  useEffect(() => {
    askNotifyPermission();
  }, []);

  const fetchUsers = useCallback(async () => {
    const API = import.meta.env.VITE_API_URL || '';
    try {
      const res = await fetch(`${API}/api/users`);
      const data = await res.json();
      setUsers(data);
    } catch (e) {}
  }, []);

  useEffect(() => {
    if (!socket) return;

    socket.on('presence:update', ({ userId, isOnline, lastSeen }) => {
      setPresence(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), isOnline, lastSeen: lastSeen || Date.now() } }));
      socket.emit('conversation:list');
    });

    socket.on('video-call:presence', ({ targetUserId, onCall }) => {
      setPresence(prev => ({ ...prev, [targetUserId]: { ...(prev[targetUserId] || {}), onCall: !!onCall } }));
    });

    socket.on('conversation:list', (list) => {
      setConversations(list);
    });

    socket.on('conversation:cleared', ({ conversationId }) => {
      setConversation(prev => (prev.id === conversationId ? { ...prev, messages: [] } : prev));
      setConversations(prev => prev.map(c =>
        c.conversationId === conversationId ? { ...c, lastMessage: null } : c
      ));
    });

    socket.on('typing:start', ({ userId }) => {
      setConversation(prev => (prev.other && prev.other.id === userId ? { ...prev, typing: true } : prev));
    });

    socket.on('typing:stop', ({ userId }) => {
      setConversation(prev => (prev.other && prev.other.id === userId ? { ...prev, typing: false } : prev));
    });

    socket.on('message:receive', ({ message }) => {
      const isMine = message.sender_id === currentUser?.id;
      setConversation(prev => {
        if (prev.id !== message.conversation_id) return prev;
        if (isMine) return prev;
        if (socket) socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
        return { ...prev, messages: [...prev.messages, { ...message, status: 'SENT' }] };
      });
      if (!isMine) {
        const viewing = conversationRef.current?.other?.id === message.sender_id;
        const sender = users.find(u => u.id === message.sender_id);
        const senderName = sender?.display_name || sender?.username || 'Someone';
        const preview = message.type === 'VOICE' ? '🎤 Voice message' : (message.content || 'Media message');
        if (!viewing) {
          showSystemNotification(senderName, preview);
        }
      }
    });

    socket.on('nudge', ({ from }) => {
      const name = from?.displayName || from?.username || 'Someone';
      vibrateNudge();
      showToast(`${name} nudged you`);
      showSystemNotification('Tojey', `${name} nudged you 👋`);
    });

    socket.on('message:delivered', ({ messageId }) => {
      setConversation(prev => ({
        ...prev,
        messages: prev.messages.map(m => (m.id === messageId ? { ...m, status: 'DELIVERED' } : m)),
      }));
    });

    socket.on('message:read', ({ messageIds }) => {
      setConversation(prev => ({
        ...prev,
        messages: prev.messages.map(m => (messageIds.includes(m.id) ? { ...m, status: 'READ' } : m)),
      }));
    });

    socket.on('message:edited', ({ messageId, content }) => {
      setConversation(prev => ({
        ...prev,
        messages: prev.messages.map(m => (m.id === messageId ? { ...m, content, is_edited: true } : m)),
      }));
    });

    socket.on('message:deleted', ({ messageId, mode }) => {
      setConversation(prev => ({
        ...prev,
        messages: mode === 'everyone'
          ? prev.messages.map(m => (m.id === messageId ? { ...m, is_deleted_for_everyone: true, content: null, media_url: null } : m))
          : prev.messages.filter(m => m.id !== messageId),
      }));
    });

    socket.on('message:reaction', ({ messageId, reactions }) => {
      setConversation(prev => ({
        ...prev,
        messages: prev.messages.map(m => (m.id === messageId ? { ...m, reactions } : m)),
      }));
    });

    socket.on('messages:history', (msgs) => {
      setConversation(prev => ({ ...prev, messages: msgs }));
    });

    socket.on('conversation:opened', ({ conversationId, otherUserId }) => {
      setConversation(prev => ({ ...prev, id: conversationId }));
    });

    return () => {
      socket.off('presence:update');
      socket.off('video-call:presence');
      socket.off('conversation:list');
      socket.off('conversation:cleared');
      socket.off('typing:start');
      socket.off('typing:stop');
      socket.off('message:receive');
      socket.off('nudge');
      socket.off('message:delivered');
      socket.off('message:read');
      socket.off('message:edited');
      socket.off('message:deleted');
      socket.off('message:reaction');
      socket.off('messages:history');
      socket.off('conversation:opened');
    };
  }, [socket, currentUser?.id, users]);

  // Foreground FCM web pushes (data-only). These normally arrive instead of socket
  // delivery only in edge cases (the backend routes sockets while a device is
  // foreground, so tojey_chat duplicates are avoided the same way as the Android app).
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    onWebPushForegroundMessage((data) => {
      if (cancelled) return;
      if (!currentUser) return;
      if (data.type && data.type !== 'tojey_chat' && data.type !== 'tojey_nudge' && data.type !== 'tojey_notification') return;
      if (data.receiverId && String(data.receiverId) !== String(currentUser.id)) return;
      if (data.type === 'tojey_chat') {
        const otherId = Number(data.senderId);
        if (conversationRef.current?.other?.id === otherId) return;
      }
      const title = data.title || data.senderName || 'Tojey';
      const body = data.type === 'tojey_nudge'
        ? (data.senderName ? data.senderName + ' nudged you' : 'Someone nudged you')
        : previewFromWeb(data);
      showSystemNotification('nudge' in data ? 'Tojey' : title, body);
    }).then((u) => {
      if (cancelled && typeof u === 'function') u();
      else unsub = u || (() => {});
    });
    return () => { cancelled = true; if (typeof unsub === 'function') unsub(); };
  }, [currentUser?.id, currentUser?.username]);

  function openConversation(otherUser) {
    setConversation({ id: null, other: otherUser, messages: [], typing: false });
    if (socket) socket.emit('conversation:open', { otherUserId: otherUser.id });
  }

  function sendMessage(payload) {
    if (!socket) return;

    const doSend = (p) => {
      socket.emit('message:send', p, (ack) => {
        if (ack && ack.ok && ack.message) {
          acceptAck(p._tempId, ack.message);
        }
        if (ack && ack.error && !p._fromQueue) {
          showToast(ack.error === 'otherUserId required' ? 'Could not send message' : ack.error);
          setConversation(prev => ({ ...prev, messages: prev.messages.filter(x => x._tempId !== p._tempId) }));
        }
      });
    };

    if (!socket.connected) {
      offlineQueueRef.current.push({ ...payload, _queued: true });
      persistQueue();
      showToast('Offline — message queued');
      setConversation(prev =>
        prev.other && prev.other.id === payload.otherUserId
          ? {
              ...prev,
              messages: [...prev.messages, {
                _tempId: payload._tempId,
                _queued: true,
                sender_id: currentUser?.id,
                type: payload.type || 'TEXT',
                content: payload.content || '',
                media_url: payload.mediaUrl || null,
                file_name: payload.fileName || '',
                media_size: payload.fileSize || 0,
                duration: payload.duration || 0,
                status: 'SENT',
                created_at: new Date().toISOString(),
                reactions: [],
              }],
            }
          : prev
      );
      return;
    }

    doSend(payload);
  }

  function sendNudge(otherUserId, otherName) {
    if (!socket) return;
    socket.emit('nudge', { otherUserId });
    setConversation(prev => ({ ...prev, nudgePulse: Date.now() }));
    showToast(`You nudged ${otherName || 'them'} 👋`);
  }

  function clearConversation(otherId) {
    if (!socket) return;
    socket.emit('conversation:clear', { otherUserId: otherId });
    setConversations(prev => prev.map(c => (c.other.id === otherId ? { ...c, lastMessage: null } : c)));
  }

  return (
    <ChatContext.Provider value={{ users, conversation, conversations, presence, wallpaper, setWallpaper, openConversation, sendMessage, sendNudge, clearConversation, setConversation, fetchUsers, toast, showToast }}>
      {children}
      {toast && (
        <div style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 110,
          zIndex: 2000,
          maxWidth: 'min(92vw, 380px)',
          background: 'rgba(20,16,30,0.92)',
          color: '#fff',
          border: '1px solid rgba(124,77,255,0.45)',
          boxShadow: '0 10px 34px rgba(0,0,0,0.45)',
          padding: '11px 18px',
          borderRadius: 14,
          fontSize: 14,
          fontWeight: 600,
          textAlign: 'center',
          animation: 'nudgeToastPop 0.28s cubic-bezier(.2,1.4,.4,1)',
          backdropFilter: 'blur(8px)',
          pointerEvents: 'none',
        }}>
          {toast}
        </div>
      )}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
