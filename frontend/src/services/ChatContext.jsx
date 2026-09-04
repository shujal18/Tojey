import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';

const ChatContext = createContext();

export function ChatProvider({ socket, currentUser, children }) {
  const [users, setUsers] = useState([]);
  const [conversation, setConversation] = useState({ id: null, other: null, messages: [], typing: false });
  const [presence, setPresence] = useState({});
  const [conversations, setConversations] = useState([]);
  const [wallpaper, setWallpaper] = useState(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;

  useEffect(() => {
    if (!socket) return;
    fetchUsers();
    socket.emit('conversation:list');
  }, [socket]);

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
      setPresence(prev => ({ ...prev, [userId]: { isOnline, lastSeen: lastSeen || Date.now() } }));
      socket.emit('conversation:list');
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
      socket.off('conversation:list');
      socket.off('conversation:cleared');
      socket.off('typing:start');
      socket.off('typing:stop');
      socket.off('message:receive');
      socket.off('message:delivered');
      socket.off('message:read');
      socket.off('message:edited');
      socket.off('message:deleted');
      socket.off('message:reaction');
      socket.off('messages:history');
      socket.off('conversation:opened');
    };
  }, [socket, currentUser?.id]);

  function openConversation(otherUser) {
    setConversation({ id: null, other: otherUser, messages: [], typing: false });
    if (socket) socket.emit('conversation:open', { otherUserId: otherUser.id });
  }

  function sendMessage(payload) {
    if (!socket) return;
    socket.emit('message:send', payload, (ack) => {
      if (ack && ack.ok && ack.message) {
        const m = { ...ack.message, _local: true };
        setConversation(prev => ({
          ...prev,
          messages: prev.messages.some(x => x._tempId === payload._tempId)
            ? prev.messages.map(x => (x._tempId === payload._tempId ? { ...m, _tempId: undefined } : x))
            : [...prev.messages, m],
        }));
        socket.emit('conversation:list');
      }
    });
  }

  function clearConversation(otherId) {
    if (!socket) return;
    socket.emit('conversation:clear', { otherUserId: otherId });
    setConversations(prev => prev.map(c => (c.other.id === otherId ? { ...c, lastMessage: null } : c)));
  }

  return (
    <ChatContext.Provider value={{ users, conversation, conversations, presence, wallpaper, setWallpaper, openConversation, sendMessage, clearConversation, setConversation, fetchUsers }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  return useContext(ChatContext);
}
