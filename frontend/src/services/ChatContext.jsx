import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { vibrateNudge, askNotifyPermission, forceNotify } from './nudge';
import { onWebPushForegroundMessage } from './webPush';

const ChatContext = createContext();

const NUDGE_COLORS = ['#7C4DFF', '#FF5252', '#FFB300', '#00C853', '#40C4FF', '#FF4081'];
const HISTORY_LIMIT = 200;

function makeClientId() {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function messageKey(m) {
  if (!m) return null;
  const client = m.client_id || m.clientId || m._clientId;
  if (client != null) return `c:${client}`;
  if (m.id != null) return `s:${m.id}`;
  if (m._tempId != null) return `t:${m._tempId}`;
  return null;
}

function sameMessage(a, b) {
  if (!a || !b) return false;
  const ak = messageKey(a);
  const bk = messageKey(b);
  if (ak && bk && ak === bk) return true;
  if (a.id != null && b.id != null && String(a.id) === String(b.id)) return true;
  if (a._tempId != null && b._tempId != null && String(a._tempId) === String(b._tempId)) return true;
  return false;
}

function dedupeMessages(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach((m) => {
    const key = messageKey(m) || `i:${out.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  });
  return out;
}

function mergeMessage(list, incoming) {
  if (!incoming) return list || [];
  const out = [];
  let merged = false;
  (list || []).forEach((m) => {
    if (!sameMessage(m, incoming)) {
      out.push(m);
      return;
    }
    if (merged) return;
    const next = { ...m, ...incoming };
    if (m.clientId && !incoming.clientId && !incoming.client_id) next.clientId = m.clientId;
    if (m._clientId && !incoming._clientId && !incoming.client_id) next._clientId = m._clientId;
    if (m._tempId != null && incoming._tempId == null) next._tempId = m._tempId;
    if (!next.reactions && m.reactions) next.reactions = m.reactions;
    out.push(next);
    merged = true;
  });
  if (!merged) out.push(incoming);
  return out;
}

function previewFromWeb(data) {
  const t = data.msgType;
  const p = data.msgPreview || data.body || '';
  if (t === 'VOICE') return 'Voice message' + (p ? ': ' + p : '');
  if (t === 'IMAGE') return 'Photo' + (p ? ': ' + p : '');
  if (t === 'VIDEO') return 'Video' + (p ? ': ' + p : '');
  if (t === 'FILE' || t === 'DOCUMENT') return 'File' + (p ? ': ' + p : '');
  return p || 'New message';
}

export function ChatProvider({ socket, currentUser, children, onOpenChat }) {
  const [users, setUsers] = useState([]);
  const [conversation, setConversation] = useState({ id: null, other: null, messages: [], typing: false, hasMore: true });
  const [presence, setPresence] = useState({});
  const [conversations, setConversations] = useState([]);
  const [unread, setUnread] = useState({});
  const [wallpaper, setWallpaper] = useState(null);
  const [toast, setToast] = useState(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const toastTimer = useRef(null);
  const offlineQueueRef = useRef([]);
  const seenIncomingRef = useRef(new Set());
  const loadResolverRef = useRef(null);
  const loadTimerRef = useRef(null);
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

  const applyMessages = useCallback((fn) => {
    setConversation(prev => ({ ...prev, messages: fn(prev.messages || []) }));
  }, []);

  const setMessageStatus = useCallback((ids, status) => {
    const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    applyMessages(list => list.map(m => (m.id != null && wanted.has(String(m.id)) ? { ...m, status } : m)));
  }, [applyMessages]);

  const isActiveChat = useCallback((otherUserId) => {
    const active = conversationRef.current.other?.id;
    return active == null || otherUserId == null || String(active) === String(otherUserId);
  }, []);

  const resolveSend = useCallback((payload, ack) => {
    if (!isActiveChat(payload.otherUserId)) return;
    if (ack && ack.ok && ack.message) {
      applyMessages(list => dedupeMessages(mergeMessage(list, {
        ...ack.message,
        clientId: payload.clientId,
        _local: true,
        _pending: false,
        _queued: false,
      })));
    } else if (ack && ack.error && !payload._fromQueue) {
      applyMessages(list => list.filter(m => !sameMessage(m, { clientId: payload.clientId, _tempId: payload._tempId })));
    }
    socketRef.current?.emit('conversation:list');
  }, [applyMessages, isActiveChat]);

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
            resolveSend(p, ack);
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
  }, [socket, resolveSend]);

  useEffect(() => {
    askNotifyPermission();
  }, []);

  const fetchUsers = useCallback(async () => {
    const API = import.meta.env.VITE_API_URL || '';
    try {
      const res = await fetch(`${API}/api/users`);
      const data = await res.json();
      setUsers(data);
      setPresence(prev => {
        const next = { ...prev };
        data.forEach(u => {
          next[u.id] = {
            ...(next[u.id] || {}),
            isOnline: !!u.is_online,
            lastSeen: u.is_online ? Date.now() : (u.last_seen || next[u.id]?.lastSeen || null),
          };
        });
        return next;
      });
    } catch (e) {}
  }, []);

  useEffect(() => {
    if (!socket) return;

    const receiveMessage = (data) => {
      const message = data && data.message ? data.message : data;
      if (!message) return;
      const key = messageKey(message) || `${message.sender_id || '?'}:${message.created_at || '?'}`;
      if (seenIncomingRef.current.has(key)) return;
      if (conversationRef.current.messages.some(m => sameMessage(m, message))) return;
      seenIncomingRef.current.add(key);
      if (seenIncomingRef.current.size > 500) {
        seenIncomingRef.current = new Set(Array.from(seenIncomingRef.current).slice(-250));
      }
      const isMine = message.sender_id === currentUser?.id;
      if (conversationRef.current.id === message.conversation_id) {
        applyMessages(list => mergeMessage(list, { ...message, status: message.status || 'SENT' }));
      }
      if (!isMine && message.sender_id != null && conversationRef.current.other?.id === message.sender_id) {
        socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
      } else if (!isMine && message.sender_id != null) {
        setUnread(prev => ({ ...prev, [message.sender_id]: (prev[message.sender_id] || 0) + 1 }));
      }
    };

    socket.on('presence:update', ({ userId, isOnline, lastSeen }) => {
      setPresence(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), isOnline, lastSeen: lastSeen || Date.now() } }));
      socket.emit('conversation:list');
    });

    socket.on('video-call:presence', ({ targetUserId, onCall }) => {
      setPresence(prev => ({ ...prev, [targetUserId]: { ...(prev[targetUserId] || {}), onCall: !!onCall } }));
    });

    socket.on('conversation:list', (list) => {
      setConversations(list);
      setPresence(prev => {
        const next = { ...prev };
        (list || []).forEach(c => {
          if (!c || !c.other || !c.other.id) return;
          next[c.other.id] = {
            ...(next[c.other.id] || {}),
            isOnline: next[c.other.id]?.isOnline ?? !!c.other.isOnline,
            lastSeen: next[c.other.id]?.lastSeen || c.other.last_seen || null,
          };
        });
        return next;
      });
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

    socket.on('message:receive', receiveMessage);
    socket.on('message:new', receiveMessage);

    socket.on('nudge', ({ from }) => {
      const name = from?.displayName || from?.username || 'Someone';
      vibrateNudge();
      showToast(`${name} nudged you`);
    });

    socket.on('notification:receive', (d) => {
      if (!d || !d.sender) return;
      if (d.receiverId && currentUser && String(d.receiverId) !== String(currentUser.id)) return;
      const name = d.sender.displayName || d.sender.username || 'Someone';
      const body = (d.notification && (d.notification.title || d.notification.message)) || 'sent you a notification';
      forceNotify(name, body);
    });

    socket.on('message:delivered', ({ messageId }) => setMessageStatus(messageId, 'DELIVERED'));
    socket.on('message:read', ({ messageIds }) => setMessageStatus(messageIds, 'READ'));

    socket.on('message:edited', ({ messageId, content }) => {
      applyMessages(list => list.map(m => (m.id === messageId ? { ...m, content, is_edited: true } : m)));
    });

    socket.on('message:deleted', ({ messageId, mode }) => {
      applyMessages(list => mode === 'everyone'
        ? list.map(m => (m.id === messageId ? { ...m, is_deleted_for_everyone: true, content: null, media_url: null } : m))
        : list.filter(m => m.id !== messageId));
    });

    socket.on('message:reaction', ({ messageId, reactions }) => {
      applyMessages(list => list.map(m => (m.id === messageId ? { ...m, reactions } : m)));
    });

    socket.on('messages:history', (msgs) => {
      const list = Array.isArray(msgs) ? msgs : [];
      setConversation(prev => {
        const pending = (prev.messages || []).filter(m => m._pending || m._queued);
        return { ...prev, messages: dedupeMessages([...list, ...pending]), hasMore: list.length >= HISTORY_LIMIT };
      });
    });

    socket.on('messages:loadMore:result', (result) => {
      if (loadResolverRef.current) loadResolverRef.current(result);
    });

    socket.on('messages:loadMore:error', (error) => {
      if (loadResolverRef.current) loadResolverRef.current({ ok: false, error: error?.error || error?.message || 'Load failed' });
    });

    socket.on('conversation:opened', ({ conversationId, otherUserId }) => {
      setConversation(prev => ({ ...prev, id: conversationId }));
    });

    return () => {
      if (loadTimerRef.current) {
        clearTimeout(loadTimerRef.current);
        loadTimerRef.current = null;
      }
      loadResolverRef.current = null;
      socket.off('presence:update');
      socket.off('video-call:presence');
      socket.off('conversation:list');
      socket.off('conversation:cleared');
      socket.off('typing:start');
      socket.off('typing:stop');
      socket.off('message:receive');
      socket.off('message:new');
      socket.off('nudge');
      socket.off('notification:receive');
      socket.off('message:delivered');
      socket.off('message:read');
      socket.off('message:edited');
      socket.off('message:deleted');
      socket.off('message:reaction');
      socket.off('messages:history');
      socket.off('messages:loadMore:result');
      socket.off('messages:loadMore:error');
      socket.off('conversation:opened');
    };
  }, [socket, currentUser?.id, applyMessages, setMessageStatus]);

  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    onWebPushForegroundMessage((data) => {
      if (cancelled) return;
      if (!currentUser) return;
      if (!data || data.type !== 'tojey_notification') return;
      if (data.receiverId && String(data.receiverId) !== String(currentUser.id)) return;
      const title = data.title || data.senderName || 'Tojey';
      forceNotify(title, previewFromWeb(data) || data.body || '');
    }).then((u) => {
      if (cancelled && typeof u === 'function') u();
      else unsub = u || (() => {});
    });
    return () => { cancelled = true; if (typeof unsub === 'function') unsub(); };
  }, [currentUser?.id, currentUser?.username]);

  function openConversation(otherUser) {
    setConversation({ id: null, other: otherUser, messages: [], typing: false, hasMore: true });
    if (otherUser && otherUser.id != null) {
      setUnread(prev => {
        if (!prev[otherUser.id]) return prev;
        const next = { ...prev };
        delete next[otherUser.id];
        return next;
      });
      setPresence(prev => ({
        ...prev,
        [otherUser.id]: {
          ...(prev[otherUser.id] || {}),
          isOnline: prev[otherUser.id]?.isOnline ?? !!(otherUser.is_online ?? otherUser.online),
          lastSeen: prev[otherUser.id]?.lastSeen || otherUser.last_seen || otherUser.lastSeen || null,
        },
      }));
    }
    if (socket && otherUser) socket.emit('conversation:open', { otherUserId: otherUser.id });
  }

  function optimisticMessage(payload, clientId) {
    return {
      clientId,
      _tempId: payload._tempId || clientId,
      _local: true,
      _pending: true,
      _queued: !!payload._queued,
      id: undefined,
      sender_id: currentUser?.id,
      conversation_id: conversationRef.current.id || null,
      type: payload.type || 'TEXT',
      content: payload.content || '',
      media_url: payload.mediaUrl || '',
      thumb_url: payload.thumbUrl || '',
      file_name: payload.fileName || '',
      media_size: payload.fileSize || payload.mediaSize || 0,
      duration: payload.duration || 0,
      waveform: payload.waveform || '',
      transcript: payload.transcript || '',
      reply_to: payload.replyTo || null,
      status: 'SENT',
      created_at: new Date().toISOString(),
      reactions: [],
    };
  }

  function sendMessage(payload) {
    const s = socketRef.current;
    if (!s) return;
    const clientId = payload.clientId || payload.client_id || makeClientId();
    const outgoing = { ...payload, clientId, _tempId: payload._tempId || clientId };
    const local = optimisticMessage(outgoing, clientId);
    const insertLocal = () => {
      if (!isActiveChat(outgoing.otherUserId)) return;
      applyMessages(list => mergeMessage(list, local));
    };

    if (!s.connected) {
      offlineQueueRef.current.push({ ...outgoing, _queued: true, _fromQueue: true });
      persistQueue();
      insertLocal();
      return;
    }

    insertLocal();
    s.emit('message:send', outgoing, (ack) => resolveSend(outgoing, ack));
  }

  const loadOlderMessages = useCallback(({ otherUserId, beforeId, limit = 40 }) => {
    const s = socketRef.current;
    if (!s || !s.connected || !otherUserId || beforeId == null) return Promise.resolve({ ok: false, error: 'Unavailable' });
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        loadTimerRef.current = null;
        loadResolverRef.current = null;
        const payload = result || { ok: false, error: 'No response' };
        if (isActiveChat(otherUserId)) {
          if (payload.ok && Array.isArray(payload.messages)) {
            setConversation(prev => {
              const existing = prev.messages || [];
              const older = payload.messages.filter(m => !existing.some(x => sameMessage(x, m)));
              if (!older.length) return { ...prev, hasMore: !!payload.hasMore };
              return { ...prev, messages: dedupeMessages([...older, ...existing]), hasMore: !!payload.hasMore };
            });
          } else if (payload.error && !/timeout|no response|offline|disconnect/i.test(payload.error)) {
            setConversation(prev => ({ ...prev, hasMore: false }));
          }
        }
        resolve(payload);
      };
      timer = setTimeout(() => done({ ok: false, error: 'Timed out' }), 10000);
      loadTimerRef.current = timer;
      loadResolverRef.current = done;
      s.emit('messages:loadMore', { otherUserId, beforeId, limit }, done);
    });
  }, [isActiveChat]);

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
    <ChatContext.Provider value={{ users, conversation, conversations, presence, wallpaper, setWallpaper, openConversation, sendMessage, sendNudge, clearConversation, setConversation, fetchUsers, loadOlderMessages, toast, showToast, openChatScreen: onOpenChat, unread, markRead: (id) => setUnread(prev => { if (!prev[id]) return prev; const n = { ...prev }; delete n[id]; return n; }), totalUnread: Object.values(unread).reduce((a, b) => a + b, 0) }}>
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
