import React, { useEffect, useRef, useState, useCallback, memo, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Keyboard, Linking, Modal, ActivityIndicator, Alert,
  Animated, PanResponder, Dimensions, ScrollView,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { reactionPopRow } from '../theme';
import { emojiSpan } from '../utils/emoji';

// Full reaction set shown when the + on the reaction bar is tapped (reactions only).
const sheetReactions = ['❤️', '😂', '😁', '😮', '😢', '🙏', '🫂', '🎉', '🔥', '😍', '👏', '💯'];
import { absUrl, SERVER_URL, CHAT_BACKGROUND } from '../config';
import Clipboard from '@react-native-clipboard/clipboard';
import RNFetchBlob from 'rn-fetch-blob';
import DocumentPicker, { types as DocTypes } from 'react-native-document-picker';
import { ensureCameraPermission, ensureMediaPermission, ensureMicPermission } from '../services/permissions';
import { loadMessages, saveMessages, clearConversationCache } from '../services/cache';
import MediaViewer from '../components/MediaViewer';
import MediaPreview from '../components/MediaPreview';
import {
  startVoiceRecording, trackVoiceRecording, stopVoiceRecording, deleteVoiceFile,
  playVoice, stopVoicePlayback, resetVoice,
} from '../services/voice';

const { width: APP_W, height: APP_H } = Dimensions.get('window');

// WhatsApp-like fixed incoming bubble color (constant, never tinted by theme/chat color).
const INCOMING_MESSAGE_COLOR = '#1e2529';
// Emoji quick-pick strip used by the composer's emoji button (unique set).
const emojiQuick = ['😁','❤️','😂','😮','😢','🙏','🫂','🎉','🔥','😍','👏','💯','😄','😁','😘','🤗','😅','🙃','🫡','💀','👻','🎂','⚽','🎧','☕','🚗','✌️','🙌','🤝','🥳'];

// Defensive shape guard: every row rendered by MessageRow goes through this, so a
// single malformed/cached/legacy payload can never crash the whole chat screen.
function normalizeMessage(m) {
  const base = (m && typeof m === 'object') ? m : {};
  let reactions = base.reactions;
  if (typeof reactions === 'string') {
    try { reactions = JSON.parse(reactions); } catch (e) { reactions = []; }
  }
  if (!Array.isArray(reactions)) reactions = [];
  return {
    ...base,
    id: base.id || `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: base.type || 'TEXT',
    sender_id: Number(base.sender_id) || 0,
    content: base.content == null ? null : String(base.content),
    media_url: base.media_url || '',
    thumb_url: base.thumb_url || '',
    file_name: base.file_name || '',
    media_size: Number(base.media_size) || 0,
    duration: Number(base.duration) || 0,
    status: base.status || 'SENT',
    reactions,
    created_at: base.created_at || null,
  };
}

// Isolates a single failing row so one bad message can't blank the whole chat.
// Renders a disabled placeholder bubble in its place.
class RowBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error('Chat row render error:', error && error.message);
  }
  componentDidUpdate(prev) {
    if (prev.rowKey !== this.props.rowKey && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) {
      return (
        <View style={[styles.msgRow, { justifyContent: this.props.isSent ? 'flex-end' : 'flex-start' }]}>
          <View style={[styles.bubble, { backgroundColor: INCOMING_MESSAGE_COLOR, opacity: 0.55 }]}>
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12 }}>Message could not be displayed</Text>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function ChatRoomScreen({ socket, currentUser, otherUser, onBack }) {
  const { theme } = useTheme();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [reactionMenu, setReactionMenu] = useState(null);
  const [reactionPop, setReactionPop] = useState(null);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [selMode, setSelMode] = useState(false);
  const [selSet, setSelSet] = useState(new Set());
  const [selMenu, setSelMenu] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [playingVoiceId, setPlayingVoiceId] = useState(null);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const playingIdRef = useRef(null);
  const [showAttach, setShowAttach] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [composerH, setComposerH] = useState(0);
  const [barHeights, setBarHeights] = useState({});
  const setBarH = (k) => (e) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setBarHeights((prev) => (prev[k] === h ? prev : { ...prev, [k]: h }));
  };
  const [presence, setPresence] = useState(null);
  const listRef = useRef(null);
  const voicePathRef = useRef(null);
  const recListenUnsub = useRef(null);
  const inputRef = useRef(null);
  const kbVisibleRef = useRef(Platform.OS === 'ios');
  const focusRetryRef = useRef(false);
  const typingTimer = useRef(null);
  const [mediaViewer, setMediaViewer] = useState(null);
  const [previewAsset, setPreviewAsset] = useState(null);
  const [atBottomNear, setAtBottomNear] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const atBottomRef = useRef(true);
  const atBottomNearRef = useRef(true);
  const scrolledToEndOnMount = useRef(false);
  const uploadTasks = useRef(new Map());
  const normCache = useRef(new WeakMap());
  const getNorm = (item) => {
    if (item && typeof item === 'object') {
      const hit = normCache.current.get(item);
      if (hit) return hit;
      const n = normalizeMessage(item);
      normCache.current.set(item, n);
      return n;
    }
    return normalizeMessage(item);
  };
  const [highlightId, setHighlightId] = useState(null);
  const highlightTimer = useRef(null);

  // Defensive: ensure otherUser has all required properties
  const safeOtherUser = otherUser || { id: 0, display_name: 'Unknown', username: '', profile_pic_url: '', online: false, last_seen: null };
  const otherUserId = safeOtherUser.id;
  const otherUserName = safeOtherUser.display_name || safeOtherUser.username || 'Unknown';
  const otherUsername = safeOtherUser.username || otherUserName;
  const otherUserBio = safeOtherUser.bio || '';
  const otherUserAvatar = safeOtherUser.profile_pic_url || '';
  const otherUserOnline = safeOtherUser.online ?? false;
  const otherUserLastSeen = safeOtherUser.last_seen ?? null;

  const mediaItems = useMemo(
    () => messages.filter((m) =>
      (m.type === 'IMAGE' || m.type === 'VIDEO') &&
      m.media_url &&
      !m._uploading &&
      !m._pending &&
      (m.media_url.startsWith('/uploads/') || m.media_url.startsWith('http'))
    ),
    [messages]
  );

  const openMedia = useCallback((message) => {
    if (!message || !message.media_url) return;
    if (message.type === 'IMAGE' || message.type === 'VIDEO') {
      const idx = mediaItems.findIndex((m) => m.id === message.id);
      if (idx >= 0) {
        setMediaViewer({ items: mediaItems, index: idx });
        return;
      }
      Linking.openURL(absUrl(message.media_url)).catch(() => {});
    } else if (message.type === 'VOICE') {
      Linking.openURL(absUrl(message.media_url)).catch(() => {});
    } else if (message.type === 'FILE' || message.type === 'DOCUMENT') {
      const name = message.file_name || message.content || '';
      if (/\.(mp4|mov|mkv|webm|3gp|m4v|avi|wmv)(\?|#|$)/i.test(name)) {
        setMediaViewer({ items: [{ id: message.id, type: 'VIDEO', media_url: message.media_url, file_name: name, content: name, sender_id: message.sender_id }], index: 0 });
        return;
      }
      downloadAndOpen(message);
    } else {
      Linking.openURL(absUrl(message.media_url)).catch(() => {});
    }
  }, [mediaItems]);

  const handleContentSizeChange = useCallback(() => {
    if ((atBottomRef.current || kbVisibleRef.current) && scrolledToEndOnMount.current) listRef.current?.scrollToEnd({ animated: false });
  }, []);

  const handleScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    const h = e.nativeEvent.layoutMeasurement.height;
    const cs = e.nativeEvent.contentSize.height;
    const nearBottom = y + h >= cs - 50;
    atBottomRef.current = nearBottom;
    if (nearBottom) setPendingCount(0);
    if (nearBottom !== atBottomNearRef.current) {
      atBottomNearRef.current = nearBottom;
      setAtBottomNear(nearBottom);
    }
  }, []);

  const REACTPOP_H = 60;
  const handleLongPress = useCallback((msg, evt) => {
    if (!msg) return;
    const pageX = (evt && evt.nativeEvent && evt.nativeEvent.pageX) || APP_W / 2;
    const pageY = (evt && evt.nativeEvent && evt.nativeEvent.pageY) || 260;
    const popW = 7 * 40 + 22 + 16;
    const left = Math.max(8, Math.min(pageX - popW / 2, APP_W - popW - 8));
    const top = pageY > REACTPOP_H + 70 ? pageY - REACTPOP_H - 20 : Math.min(pageY + 44, APP_H - REACTPOP_H - 12);
    setReactionPop({ msg, left, top, caretX: Math.max(10, Math.min(pageX - left - 7, popW - 20)) });
  }, []);

  const toggleLike = useCallback((msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const mine = (msg.reactions || []).find((r) => r.user_id === currentUser.id);
    reactTo(msg.id, mine && mine.reaction === '❤️' ? '' : '❤️');
  }, [currentUser.id]);

  const replyIndex = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const replyPreviewOf = useCallback((id) => {
    const ref = replyIndex.get(id);
    return ref ? replyPreview(ref) : '…';
  }, [replyIndex]);
  const replyReferentOf = useCallback((id) => replyIndex.get(id) || null, [replyIndex]);

  // Tap on a reply preview → jump to the exact original message (non-animated),
  // temporarily highlight it, and never crash if it's deleted/not loaded.
  const jumpToMessage = useCallback((id) => {
    if (id == null) return;
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    setHighlightId(id);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1800);
    try {
      listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.3, animated: false });
    } catch (e) {
      // On Android, scrollToIndex can throw before rows are measured; the
      // onScrollToIndexFailed fallback on the FlatList retries safely.
    }
  }, [messages]);

  const onScrollToIndexFailed = useCallback(({ index }) => {
    if (!messages.length) return;
    try {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false });
    } catch (e) {
      // Still not measured — estimate a non-animated offset; safe even if imprecise.
      listRef.current?.scrollToOffset({ offset: Math.max(0, index * 64 - 30), animated: false });
    }
  }, [messages]);

  const renderMessage = useCallback(({ item, index }) => {
    const safe = getNorm(item);
    const isSent = safe.sender_id === currentUser.id;
    const prev = index > 0 ? messages[index - 1] : null;
    const grouped = !!prev && (prev.sender_id || 0) === safe.sender_id && !!prev.type && prev.type === safe.type;
    return (
      <RowBoundary isSent={isSent} rowKey={String(safe.id)}>
        <MessageRow
          message={safe}
          isSent={isSent}
          grouped={grouped}
          theme={theme}
          receivedBubble={INCOMING_MESSAGE_COLOR}
          flash={highlightId === safe.id}
          ownId={currentUser.id}
          otherName={otherUserName}
          replyReferentOf={replyReferentOf}
          onLongPress={handleLongPress}
          onOpenMedia={openMedia}
          onRetry={retrySendMedia}
          onReply={setReplyingTo}
          onDoubleTap={toggleLike}
          onJumpToReply={jumpToMessage}
          replyPreviewOf={replyPreviewOf}
          suggestEdit={isSent && safe.type === 'TEXT' && !!safe.content && !safe._pending}
          onEditRow={(m) => doAction('edit', m)}
          onCancelUpload={cancelUpload}
          voicePlaying={playingVoiceId === safe.id}
          voiceProgress={playingVoiceId === safe.id ? voiceProgress : 0}
          onPlayVoice={toggleVoicePlayback}
          selMode={selMode}
          selActive={selSet.has(safe.id)}
          onSelectPress={() => toggleSelect(safe.id)}
          onEnterSelect={() => enterSelect(safe)}
        />
      </RowBoundary>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, theme, handleLongPress, openMedia, toggleLike, replyPreviewOf, replyReferentOf, jumpToMessage, highlightId, otherUserName, cancelUpload, playingVoiceId, voiceProgress, toggleVoicePlayback, selMode, selSet, toggleSelect, enterSelect]);

  const onType = (t) => {
    setText(t);
    if (socket && t.trim()) {
      if (!typingTimer.current) {
        socket.emit('typing:start', { otherUserId });
      }
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        if (socket) socket.emit('typing:stop', { otherUserId });
        typingTimer.current = null;
      }, 1500);
    }
  };

  useEffect(() => {
    if (!socket || !otherUserId || !currentUser?.id) return;

    socket.emit('conversation:open', { otherUserId });

    // Seed UI with offline cache immediately, then server history overwrites
    loadMessages(currentUser.id, otherUserId).then((cached) => {
      if (cached && cached.length) {
        setMessages(cached);
        atBottomRef.current = true;
        atBottomNearRef.current = true;
        setAtBottomNear(true);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
      }
    });

    const hHistory = (msgs) => {
      setMessages(msgs);
      saveMessages(currentUser.id, otherUserId, msgs);
      atBottomNearRef.current = true;
      setAtBottomNear(true);
      setPendingCount(0);
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: false });
        scrolledToEndOnMount.current = true;
      }, 80);
    };
    const hReceive = ({ message }) => {
      // Deduplicate: check if message already exists
      setMessages((prev) => {
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, { ...message, _local: message.sender_id === currentUser.id }];
      });
      if (message.sender_id !== currentUser.id) {
        if (!atBottomRef.current) {
          setPendingCount((n) => n + 1);
        } else {
          setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
        }
        socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
      }
    };
    const hDelivered = ({ messageId }) => updateStatus(messageId, 'DELIVERED');
    const hRead = ({ messageIds }) => {
      setMessages((prev) => prev.map((m) => (messageIds.includes(m.id) ? { ...m, status: 'READ' } : m)));
    };
    const hTyping = ({ userId }) => { if (userId === otherUserId) setTyping(true); };
    const hTypingStop = ({ userId }) => { if (userId === otherUserId) setTyping(false); };
    const hEdited = ({ messageId, content }) =>
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content, is_edited: true } : m)));
    const hDeleted = ({ messageId, mode }) =>
      setMessages((prev) =>
        mode === 'everyone'
          ? prev.map((m) => (m.id === messageId ? { ...m, is_deleted_for_everyone: true, content: null } : m))
          : prev.filter((m) => m.id !== messageId)
      );
    const hReaction = ({ messageId, reactions }) =>
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));

    socket.on('messages:history', hHistory);
    socket.on('message:receive', hReceive);
    socket.on('message:delivered', hDelivered);
    socket.on('message:read', hRead);
    socket.on('typing:start', hTyping);
    socket.on('typing:stop', hTypingStop);
    socket.on('message:edited', hEdited);
    socket.on('message:deleted', hDeleted);
    socket.on('message:reaction', hReaction);
    const hCleared = ({ conversationId }) => { setMessages([]); setShowAttach(false); setReplyingTo(null); setEditing(null); setText(''); clearConversationCache(currentUser.id, otherUserId); };
    socket.on('conversation:cleared', hCleared);
    const hPresence = ({ userId, isOnline, lastSeen }) => {
      if (userId === otherUserId) setPresence({ isOnline, lastSeen });
    };
    socket.on('presence:update', hPresence);

    // Re-emit conversation:open on socket reconnect to ensure message sync
    const onReconnect = () => {
      if (socket && otherUserId) {
        socket.emit('conversation:open', { otherUserId });
      }
    };
    socket.on('connect', onReconnect);
    socket.io?.off('reconnect', onReconnect);
    socket.io?.on('reconnect', onReconnect);

    return () => {
      socket.off('messages:history', hHistory);
      socket.off('message:receive', hReceive);
      socket.off('message:delivered', hDelivered);
      socket.off('message:read', hRead);
      socket.off('typing:start', hTyping);
      socket.off('typing:stop', hTypingStop);
      socket.off('message:edited', hEdited);
      socket.off('message:deleted', hDeleted);
      socket.off('message:reaction', hReaction);
      socket.off('conversation:cleared', hCleared);
      socket.off('presence:update', hPresence);
      socket.off('connect', onReconnect);
      socket.io?.off('reconnect', onReconnect);
    };
  }, [socket, otherUserId, currentUser.id]);

  // Persist messages to offline cache whenever meaningful state changes.
  // Upload progress (_uploadProgress) ticks ~8x/sec; skip those to avoid
  // constant AsyncStorage churn and app-jank while media is sending.
  const persistSigRef = useRef('');
  useEffect(() => {
    if (!currentUser?.id || !otherUserId || !messages.length) return;
    const sig = messages
      .map((m) => [m.id, m.status, m.is_edited ? 1 : 0, m.is_deleted_for_everyone ? 1 : 0, m._uploadError ? 1 : 0, m.content].join('|'))
      .join(';')
      .slice(0, 40000);
    if (sig === persistSigRef.current) return;
    persistSigRef.current = sig;
    saveMessages(currentUser.id, otherUserId, messages);
  }, [messages, otherUserId, currentUser.id]);

  // Keyboard reopen fix: Android stops showing the keyboard on the focused input
  // after a manual dismiss. Track visibility and force a blur+refocus cycle.
  // Also scroll the chat so the newest message sits just above the input box
  // instead of hiding behind the keyboard/composer.
  useEffect(() => {
    const show = () => {
      kbVisibleRef.current = true;
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 140);
    };
    const hide = () => {
      if (Platform.OS !== 'ios') kbVisibleRef.current = false;
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 90);
    };
    const subs = [
      Keyboard.addListener('keyboardDidShow', show),
      Keyboard.addListener('keyboardDidHide', hide),
      Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        if (Platform.OS !== 'ios') return;
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // Blur + refocus (with a fallback retry) so the keyboard reliably returns when the
  // user taps the input after dismissing it. Guarded by the visibility flag.
  const reopenKeyboard = () => {
    if (Platform.OS !== 'android') return;
    const t = inputRef.current;
    if (!t || kbVisibleRef.current) return;
    t.blur();
    setTimeout(() => {
      if (!inputRef.current || inputRef.current !== t) return;
      inputRef.current.focus();
      setTimeout(() => {
        if (kbVisibleRef.current || !inputRef.current || inputRef.current !== t) return;
        inputRef.current.blur();
        setTimeout(() => {
          if (inputRef.current === t && !kbVisibleRef.current) inputRef.current.focus();
        }, 60);
      }, 220);
    }, 50);
  };

  // OPPO/ColorOS safety net: a tap can regain focus without the OS raising the soft
  // keyboard (stale EditText focus after dismiss). If the keyboard is still hidden a
  // moment after focus, force one blur+refocus cycle.
  const ensureKeyboard = () => {
    if (Platform.OS !== 'android') return;
    if (focusRetryRef.current) return;
    focusRetryRef.current = true;
    setTimeout(() => {
      focusRetryRef.current = false;
      const t = inputRef.current;
      if (!t || kbVisibleRef.current) return;
      t.blur();
      setTimeout(() => {
        if (inputRef.current === t && !kbVisibleRef.current) inputRef.current.focus();
      }, 50);
    }, 400);
  };

  useEffect(() => {
    return () => {
      resetVoice().catch(() => {});
    };
  }, []);

  function updateStatus(id, status) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
  }

  const setUploadProgress = useCallback((tempId, p) => {
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _uploadProgress: p } : m)));
  }, []);

  const uploadAsset = useCallback(({ uri, name, type }, onProgress) => {
    return new Promise((resolve, reject) => {
      let done = false;
      const task = RNFetchBlob.fetch('POST', `${SERVER_URL}/api/upload`, {
        'Content-Type': 'multipart/form-data',
        Authorization: `Bearer ${currentUser.token || ''}`,
      }, [
        { name: 'file', filename: name, type, data: RNFetchBlob.wrap(uri) },
      ]).uploadProgress({ interval: 120 }, (sent, total) => {
        if (done || total <= 0) return;
        if (onProgress) onProgress(Math.min(1, sent / total));
      }).then((res) => {
        if (done) return;
        done = true;
        let d = null;
        try { d = res.data ? JSON.parse(res.data) : null; } catch (err) { d = null; }
        if (!d || !d.url) reject(new Error((d && d.error) || 'Upload failed'));
        else resolve(d);
      }).catch((err) => {
        if (done) return;
        done = true;
        reject(err);
      });
      uploadTasks.current.set(name, task);
    });
  }, [currentUser.token]);

  const cancelUpload = useCallback((msg) => {
    if (!msg) return;
    const key = msg._uploadKey;
    if (key) {
      const t = uploadTasks.current.get(key);
      try { if (t && t.cancel) t.cancel(); } catch (e) { console.error('cancel err', e); }
      uploadTasks.current.delete(key);
    }
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
  }, []);

  const sendText = () => {
    const content = text.trim();
    if (!content) return;
    if (editing) {
      socket.emit('message:edit', { messageId: editing.id, content });
      setMessages((prev) => prev.map((m) => (m.id === editing.id ? { ...m, content, is_edited: true } : m)));
      setEditing(null);
      setText('');
      return;
    }
    const tempId = `tmp-${Date.now()}`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'TEXT',
      content,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reply_to: replyingTo?.id || null,
      reactions: [],
      _local: true,
      _pending: true,
    };
    setMessages((prev) => [...prev, localMsg]);
    const payload = {
      otherUserId,
      type: 'TEXT',
      content,
      replyTo: replyingTo?.id || null,
    };
    if (socket) socket.emit('typing:stop', { otherUserId });
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    socket.emit('message:send', payload, (ack) => {
      if (ack?.ok) {
        atBottomRef.current = true;
        setAtBottomNear(true);
        setPendingCount(0);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? ack.message : m)));
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
      }
    });
    setText('');
    setReplyingTo(null);
  };

  const sendReplyText = useCallback((target, content) => {
    const c = (content || '').trim();
    if (!target || !c || !socket) return;
    const tempId = `tmp-${Date.now()}`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'TEXT',
      content: c,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reply_to: target.id || null,
      reactions: [],
      _local: true,
      _pending: true,
    };
    setMessages((prev) => [...prev, localMsg]);
    socket.emit('message:send', { otherUserId, type: 'TEXT', content: c, replyTo: target.id || null }, (ack) => {
      if (ack && ack.ok) {
        atBottomRef.current = true;
        setAtBottomNear(true);
        setPendingCount(0);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? ack.message : m)));
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
      }
    });
  }, [socket, otherUserId, currentUser.id]);

  const sendVoiceMessage = useCallback((filePath, durationSec) => {
    if (!filePath) return;
    const cleanPath = String(filePath).replace(/^file:\/\//, '');
    const tempId = `tmp-${Date.now()}`;
    const fileName = `voice_${Date.now()}.m4a`;
    const waveform = '8,12,7,16,10,14,6,11,9,13,10,8,12,15,7,9,11,6';
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'VOICE',
      content: 'Voice message',
      media_url: cleanPath,
      thumb_url: '',
      duration: durationSec || 1,
      waveform,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    if (atBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    }
    uploadAsset({ uri: cleanPath, name: fileName, type: 'audio/mp4' }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: 'VOICE',
          content: 'Voice message',
          mediaUrl: upData.url,
          duration: durationSec || 1,
          waveform,
        }, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true, _uploading: false } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
            deleteVoiceFile(cleanPath).catch(() => {});
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('voice upload failed:', e);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m)));
      });
  }, [otherUserId, socket, currentUser.id, uploadAsset, setUploadProgress]);

  const startRecording = async () => {
    if (recording) return;
    const ok = await ensureMicPermission();
    if (!ok) {
      alert('Microphone permission is required to record voice messages.');
      return;
    }
    try {
      const { path } = await startVoiceRecording();
      voicePathRef.current = path;
      setRecordTime(0);
      setRecording(true);
      setShowAttach(false);
      recListenUnsub.current = trackVoiceRecording((e) => {
        if (e && e.currentPosition) {
          setRecordTime(Math.max(0, Math.floor(e.currentPosition / 1000)));
        }
      });
    } catch (e) {
      console.error('startRecording failed', e);
      alert('Could not start recording: ' + (e.message || 'Unknown error'));
    }
  };

  const stopRecording = async (cancel) => {
    const path = voicePathRef.current;
    voicePathRef.current = null;
    if (recListenUnsub.current) {
      recListenUnsub.current();
      recListenUnsub.current = null;
    }
    setRecording(false);
    setRecordTime(0);

    let resolvedPath = null;
    try {
      resolvedPath = await stopVoiceRecording();
    } catch (e) {
      console.warn('stopVoiceRecording failed', e);
    }
    const filePath = resolvedPath || path;

    if (cancel || !filePath) {
      await deleteVoiceFile(filePath || path);
      return;
    }

    if (recordTime < 1) {
      await deleteVoiceFile(filePath);
      Alert.alert('Too short', 'Hold a little longer before sending.');
      return;
    }
    sendVoiceMessage(filePath, Math.max(1, Math.round((recordTime * 1000) / 1000)));
  };

  const toggleVoicePlayback = useCallback(async (msg) => {
    if (!msg || !msg.media_url) return;
    if (msg._pending || msg._uploading || msg._uploadError) return;
    const current = playingIdRef.current;
    if (current === msg.id) {
      await stopVoicePlayback();
      playingIdRef.current = null;
      setPlayingVoiceId(null);
      setVoiceProgress(0);
      return;
    }
    try {
      if (current) await stopVoicePlayback();
      setVoiceProgress(0);
      playingIdRef.current = msg.id;
      setPlayingVoiceId(msg.id);
      await playVoice(absUrl(msg.media_url), (e) => {
        const dur = (e && e.duration) || 0;
        const pos = (e && e.currentPosition) || 0;
        setVoiceProgress(dur > 0 ? Math.min(1, pos / dur) : 0);
        if (e && e.isFinished) {
          playingIdRef.current = null;
          setPlayingVoiceId(null);
          setVoiceProgress(0);
        }
      });
    } catch (e) {
      console.error('voice play failed', e);
      playingIdRef.current = null;
      setPlayingVoiceId(null);
      setVoiceProgress(0);
      Alert.alert('Could not play voice note', (e && e.message) || 'Unknown error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reactTo = (id, reaction) => {
    socket.emit('message:react', { messageId: id, reaction });
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const existing = (m.reactions || []).filter((r) => r.user_id !== currentUser.id);
        return { ...m, reactions: reaction ? [...existing, { user_id: currentUser.id, reaction }] : existing };
      })
    );
    setReactionMenu(null);
  };

  const deleteMessage = (message, mode) => {
    if (mode === 'everyone') {
      socket.emit('message:delete', { messageId: message.id, mode: 'everyone' });
    } else {
      socket.emit('message:delete', { messageId: message.id, mode: 'me' });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    }
  };

  const doAction = (action, message) => {
    setReactionMenu(null);
    if (action === 'reply') { setReplyingTo(message); }
    else if (action === 'edit') { setEditing(message); setText(message.content || ''); }
    else if (action === 'deleteMe') { deleteMessage(message, 'me'); }
    else if (action === 'deleteAll') { deleteMessage(message, 'everyone'); }
    else if (action === 'save') { if (message && message.media_url) downloadAndOpen(message); }
  };

  const exitSelect = () => { setSelMode(false); setSelSet(new Set()); };

  const toggleSelect = useCallback((id) => {
    setSelSet((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Tap-to-select: single tap on a TEXT message enters selection mode with it selected.
  const enterSelect = useCallback((m) => {
    setSelMode(true);
    if (m && m.id) {
      setSelSet((prev) => {
        if (prev.has(m.id)) return prev;
        const next = new Set(prev);
        next.add(m.id);
        return next;
      });
    }
  }, []);

  // Leave selection mode automatically once nothing is selected.
  useEffect(() => {
    if (selMode && selSet.size === 0) setSelMode(false);
  }, [selMode, selSet]);

  const clearChatLocal = () => {
    setMessages([]);
    setReplyingTo(null);
    setEditing(null);
    setText('');
    clearConversationCache(currentUser.id, otherUserId);
    setSelMode(false);
    setSelSet(new Set());
  };

  const copySelected = () => {
    const parts = messages
      .filter((m) => selSet.has(m.id) && m.type === 'TEXT' && m.content)
      .map((m) => m.content)
      .join('\n');
    if (parts) Clipboard.setString(parts);
    exitSelect();
  };

  const selectedMsgs = messages.filter((m) => selSet.has(m.id));
  const selOne = selectedMsgs.length === 1 ? selectedMsgs[0] : null;

  const replySelected = () => {
    const last = selectedMsgs[selectedMsgs.length - 1];
    if (last) setReplyingTo(last);
    exitSelect();
  };

  const sendFile = (asset) => {
    if (!asset || !asset.uri) return;
    const fileName = asset.name || `file_${Date.now()}`;
    const fileSize = asset.size || 0;
    const mimeType = asset.type || 'application/octet-stream';
    const tempId = `tmp-${Date.now()}`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'FILE',
      content: fileName,
      file_name: fileName,
      media_size: fileSize,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    if (atBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    }
    uploadAsset({ uri: asset.uri, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: 'FILE',
          content: fileName,
          fileName,
          mediaSize: fileSize,
          mediaUrl: upData.url,
        }, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('sendFile upload failed:', e);
        setMessages((prev) => prev.map((m) =>
          m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m
        ));
      });
  };

  const pickMedia = (kind) => {
    setShowAttach(false);
    if (kind === 'photo' || kind === 'camera') {
      (async () => {
        try {
          const ImagePicker = require('react-native-image-picker');
          if (kind === 'camera') {
            const ok = await ensureCameraPermission();
            if (!ok) {
              alert('Camera permission is required to take photos.');
              return;
            }
            ImagePicker.launchCamera({ mediaType: 'photo' }, (r) => {
              if (r.didCancel) return;
              if (r.errorCode) {
                alert('Failed to open camera: ' + (r.errorMessage || 'Unknown error'));
                return;
              }
              if (r.assets && r.assets.length) openEditor(r.assets[0]);
            });
          } else {
            const ok = await ensureMediaPermission();
            if (!ok) {
              alert('Media permission is required to select photos.');
              return;
            }
            ImagePicker.launchImageLibrary({ mediaType: 'mixed', selectionLimit: 1 }, (r) => {
              if (r.didCancel) return;
              if (r.errorCode) {
                alert('Failed to open gallery: ' + (r.errorMessage || 'Unknown error'));
                return;
              }
              if (r.assets && r.assets.length) openEditor(r.assets[0]);
            });
          }
        } catch (e) {
          console.error('pickMedia error:', e);
          alert('Failed to open media picker: ' + e.message);
        }
      })();
    } else if (kind === 'files') {
      (async () => {
        try {
          const res = await DocumentPicker.pick({
            type: [DocTypes.allFiles],
            copyTo: 'cachesDirectory',
          });
          if (res && res[0]) {
            const asset = res[0];
            const uri = asset.fileCopyUri || asset.uri;
            sendFile({ uri, name: asset.name, size: asset.size, type: asset.type || 'application/octet-stream' });
          }
        } catch (e) {
          if (DocumentPicker.isCancel(e)) return;
          console.error('DocumentPicker error:', e);
          alert('Failed to pick file: ' + (e.message || 'Unknown error'));
        }
      })();
    }
  };

  const toCacheFile = async (uri) => {
    if (!uri || !String(uri).startsWith('content://')) return uri;
    try {
      const { dirs } = RNFetchBlob.fs;
      const ext = String(uri).split('.').pop() || 'img';
      const target = `${dirs.CacheDir}/tojey_pick_${Date.now()}.${ext}`;
      const res = await RNFetchBlob.config({ fileCache: true, path: target }).fetch('GET', uri);
      return res.path();
    } catch (e) {
      console.error('toCacheFile failed:', e.message);
      return uri;
    }
  };

  const openEditor = async (asset) => {
    if (!asset || !asset.uri) return;
    const isVideo = !!(asset.type && asset.type.toLowerCase().startsWith('video'));
    const uri = await toCacheFile(asset.uri);
    setPreviewAsset({
      uri,
      type: isVideo ? 'VIDEO' : 'IMAGE',
      fileName: asset.fileName || (isVideo ? 'video' : 'photo'),
      mimeType: asset.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
    });
  };

  const handlePreviewSend = (out) => {
    if (!out || !out.uri) return;
    const isVideo = previewAsset ? previewAsset.type === 'VIDEO' : false;
    sendMediaAsset({
      uri: out.uri,
      isVideo,
      mimeType: out.mimeType,
      fileName: out.fileName,
      caption: out.caption,
    });
    setPreviewAsset(null);
  };

  const sendMedia = (asset) => {
    if (!asset || !asset.uri) return;
    const isVideo = !!(asset.type && asset.type.toLowerCase().startsWith('video'));
    sendMediaAsset({
      uri: asset.uri,
      isVideo,
      mimeType: asset.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
      fileName: asset.fileName || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`),
      caption: '',
    });
  };

  const sendMediaAsset = (opts) => {
    if (!opts || !opts.uri) return;
    const isVideo = !!opts.isVideo;
    const tempId = `tmp-${Date.now()}`;
    const content = opts.caption && opts.caption.length ? opts.caption : (isVideo ? '🎬 Video' : '📷 Photo');
    const mimeType = opts.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
    const fileName = opts.fileName || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`);
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: isVideo ? 'VIDEO' : 'IMAGE',
      content,
      media_url: opts.uri,
      thumb_url: opts.uri,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    if (atBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
    }
    uploadAsset({ uri: opts.uri, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        const payload = {
          otherUserId,
          type: isVideo ? 'VIDEO' : 'IMAGE',
          content,
          mediaUrl: upData.url,
          thumbUrl: upData.url,
          fileName,
        };
        socket.emit('message:send', payload, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('sendMedia upload failed:', e);
        setMessages((prev) => prev.map((m) =>
          m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m
        ));
      });
  };

  const retrySendMedia = useCallback((msg) => {
    if (!msg || !msg.media_url) return;
    const isFile = msg.type === 'FILE' || msg.type === 'DOCUMENT';
    const isVideo = msg.type === 'VIDEO';
    const isVoice = msg.type === 'VOICE';
    const tempId = `tmp-${Date.now()}-r`;
    const fileName = isFile
      ? (msg.file_name || msg.content || `file_${Date.now()}`)
      : isVoice ? `voice_${Date.now()}.m4a`
      : isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`;
    const mimeType = isFile
      ? (mimeFor(msg) || 'application/octet-stream')
      : isVoice ? 'audio/mp4'
      : isVideo ? 'video/mp4' : 'image/jpeg';
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, id: tempId, _pending: true, _uploading: true, _uploadError: false, _uploadKey: fileName, _uploadProgress: 0 } : m)));
    uploadAsset({ uri: msg.media_url, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: msg.type,
          content: isFile ? fileName : (isVoice ? 'Voice message' : (isVideo ? '🎬 Video' : '📷 Photo')),
          mediaSize: isFile ? (msg.media_size || 0) : 0,
          mediaUrl: upData.url,
          thumbUrl: isFile || isVoice ? '' : upData.url,
          fileName,
          ...(isVoice ? { duration: msg.duration || 1, waveform: msg.waveform || '8,12,7,16,10,14,6,11,9,13' } : {}),
        }, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('retry sendMedia failed:', e);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _pending: false, _uploading: false, _uploadError: true } : m)));
      });
  }, [otherUserId, socket, currentUser.token, uploadAsset, setUploadProgress]);

  const uploadDrawing = useCallback(async (filePath, onDone) => {
    if (!filePath) return;
    const tempId = `tmp-draw-${Date.now()}`;
    const fileName = `drawing_${Date.now()}.png`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'IMAGE',
      content: '🖌️ Drawing',
      media_url: filePath,
      thumb_url: filePath,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    try {
      const upData = await uploadAsset({ uri: filePath, name: fileName, type: 'image/png' }, (p) => setUploadProgress(tempId, p));
      uploadTasks.current.delete(fileName);
      socket.emit('message:send', {
        otherUserId,
        type: 'IMAGE',
        content: '🖌️ Drawing',
        mediaUrl: upData.url,
        thumbUrl: upData.url,
      }, (ack) => {
        if (ack?.ok) {
          setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          if (onDone) onDone();
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
        }
      });
    } catch (e) {
      uploadTasks.current.delete(fileName);
      console.error('uploadDrawing failed:', e);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m)));
    }
  }, [otherUserId, socket, currentUser.token, uploadAsset, setUploadProgress]);

  const downloadAndOpen = useCallback(async (message) => {
    if (!message || !message.media_url) return;
    const mime = mimeFor(message);
    let name = sanitizeFileName(message.file_name) || sanitizeFileName(fileNameFromUrl(message.media_url)) || `tojey_file_${Date.now()}`;
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(name) && mime !== 'application/octet-stream') {
      name = `${name}.${extForMime(mime)}`;
    }
    try {
      const { dirs } = RNFetchBlob.fs;
      const target = `${dirs.DownloadDir}/${name}`;
      const res = await RNFetchBlob.config({
        fileCache: false,
        path: target,
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          path: target,
          description: `Tojey file: ${name}`,
          mime,
        },
      }).fetch('GET', absUrl(message.media_url));
      if (Platform.OS === 'android') {
        if (mime === 'application/octet-stream') {
          Alert.alert('Saved', `Downloaded to Download/${name}\nOpen it from your Files app.`);
        } else {
          try {
            await RNFetchBlob.android.actionViewIntent(res.path(), mime);
          } catch (e) {
            console.error('actionViewIntent failed, no handler for mime', mime, e);
            Alert.alert('Saved', `Downloaded to Download/${name}.\nNo app found to preview it here — open it from your Files app.`);
          }
        }
      } else {
        Linking.openURL(absUrl(message.media_url)).catch(() => {});
      }
    } catch (e) {
      console.error('downloadAndOpen failed:', e);
      alert('Could not download file: ' + (e.message || 'Unknown error'));
    }
  }, []);

const isOnline = presence !== null ? presence.isOnline : otherUserOnline;
  const lastSeen = presence !== null ? presence.lastSeen : otherUserLastSeen;
  const headerStatus = typing ? 'typing…' : (isOnline ? 'Online' : lastSeenText(lastSeen));
  const chatBg = theme.isDark ? '#16141C' : '#F2F0F9';
  const composerBg = hexToRgba(theme.composerBg, 0.94);
  // Fully measured bottom stack: every bar below the list + the composer height.
  // The scroll-to-latest FAB floats just above this stack so it never overlaps
  // the composer/mic or hides the newest message.
  const fabBottom =
    (barHeights.rec || 0) + (barHeights.attach || 0)
    + (barHeights.emoji || 0) + (barHeights.reply || 0) + (barHeights.edit || 0)
    + (composerH || 54) + 8;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        {selMode ? (
          <>
            <TouchableOpacity onPress={exitSelect} style={styles.backBtn} accessibilityLabel="Cancel selection">
              <Icon name="close" size={26} color={theme.primary} />
            </TouchableOpacity>
            <Text style={[styles.headerName, { color: theme.text, marginLeft: 4, flex: 1 }]}>
              {selSet.size} selected
            </Text>
            <TouchableOpacity onPress={() => setSelMenu((v) => !v)} style={styles.headerIconBtn} accessibilityLabel="Selected messages options">
              <Icon name="ellipsis-vertical" size={22} color={theme.text} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity onPress={onBack} style={styles.backBtn}>
              <Icon name="chevron-back" size={28} color={theme.primary} />
            </TouchableOpacity>
            <View style={[styles.avatarSmall, { backgroundColor: otherUserId === 1 ? theme.primary : theme.primaryDeep }]}>
              {otherUserAvatar ? (
                <Image source={{ uri: absUrl(otherUserAvatar) }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarSmallText}>{otherUserName[0].toUpperCase()}</Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.headerName, { color: theme.text }]}>{otherUserName}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {typing && <Icon name="pulse" size={12} color={theme.primary} />}
                <Text style={[styles.headerStatus, { color: typing ? theme.primary : (isOnline ? theme.online : theme.textSecondary) }]}>
                  {headerStatus}
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => setHeaderMenu((v) => !v)} style={styles.headerIconBtn} accessibilityLabel="Chat options">
              <Icon name="ellipsis-vertical" size={22} color={theme.text} />
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Action toolbar shown while selecting (long-press a message): reply, edit, delete, unsend */}
      {selMode && (
        <View style={[styles.selToolbar, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            style={[styles.selToolItem, selSet.size !== 1 && styles.selToolItemDisabled]}
            disabled={selSet.size !== 1}
            onPress={replySelected}
            accessibilityLabel="Reply to selected"
          >
            <Icon name="arrow-back" size={18} color={theme.primary} />
            <Text style={[styles.selToolLabel, { color: theme.primary }]}>Reply</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.selToolItem, !(selOne && selOne.sender_id === currentUser.id && selOne.type === 'TEXT' && selOne.content && !selOne._pending) && styles.selToolItemDisabled]}
            disabled={!(selOne && selOne.sender_id === currentUser.id && selOne.type === 'TEXT' && selOne.content && !selOne._pending)}
            onPress={() => { setSelMenu(false); doAction('edit', selOne); exitSelect(); }}
            accessibilityLabel="Edit selected"
          >
            <Icon name="create-outline" size={18} color={theme.primary} />
            <Text style={[styles.selToolLabel, { color: theme.primary }]}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.selToolItem}
            onPress={() => { setSelMenu(false); selectedMsgs.forEach((m) => deleteMessage(m, 'me')); exitSelect(); }}
            accessibilityLabel="Delete for me"
          >
            <Icon name="trash-outline" size={18} color={theme.danger} />
            <Text style={[styles.selToolLabel, { color: theme.danger }]}>Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.selToolItem, !selectedMsgs.some((m) => m.sender_id === currentUser.id) && styles.selToolItemDisabled]}
            disabled={!selectedMsgs.some((m) => m.sender_id === currentUser.id)}
            onPress={() => { setSelMenu(false); selectedMsgs.forEach((m) => { if (m.sender_id === currentUser.id) deleteMessage(m, 'everyone'); }); exitSelect(); }}
            accessibilityLabel="Unsend for everyone"
          >
            <Icon name="archive-outline" size={18} color={theme.danger} />
            <Text style={[styles.selToolLabel, { color: theme.danger }]}>Unsend</Text>
          </TouchableOpacity>
        </View>
      )}

      {selMenu && (
        <View style={styles.headerMenuOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setSelMenu(false)} accessibilityLabel="Close menu" />
          <View style={[styles.headerMenu, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); replySelected(); }} accessibilityLabel="Reply to selected">
              <Icon name="return-down-back-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
              <Text style={{ color: theme.text, fontSize: 15 }}>Reply</Text>
            </TouchableOpacity>
            {selOne && selOne.sender_id === currentUser.id && selOne.type === 'TEXT' && (
              <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); doAction('edit', selOne); exitSelect(); }} accessibilityLabel="Edit selected">
                <Icon name="create-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.text, fontSize: 15 }}>Edit</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); copySelected(); }} accessibilityLabel="Copy selected">
              <Icon name="copy-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
              <Text style={{ color: theme.text, fontSize: 15 }}>Copy</Text>
            </TouchableOpacity>
            {selOne && selOne.media_url && (
              <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); downloadAndOpen(selOne); exitSelect(); }} accessibilityLabel="Save selected">
                <Icon name="download-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.text, fontSize: 15 }}>Save</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.headerMenuItem}
              onPress={() => { setSelMenu(false); selectedMsgs.forEach((m) => deleteMessage(m, 'me')); exitSelect(); }}
              accessibilityLabel="Delete for me"
            >
              <Icon name="trash-outline" size={18} color={theme.danger} style={{ marginRight: 12 }} />
              <Text style={{ color: theme.danger, fontSize: 15 }}>Delete for me</Text>
            </TouchableOpacity>
            {selectedMsgs.some((m) => m.sender_id === currentUser.id) && (
              <TouchableOpacity
                style={styles.headerMenuItem}
                onPress={() => { setSelMenu(false); selectedMsgs.forEach((m) => { if (m.sender_id === currentUser.id) deleteMessage(m, 'everyone'); }); exitSelect(); }}
                accessibilityLabel="Unsend for everyone"
              >
                <Icon name="arrow-undo-outline" size={18} color={theme.danger} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.danger, fontSize: 15 }}>Unsend</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {headerMenu && (
        <View style={styles.headerMenuOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setHeaderMenu(false)} accessibilityLabel="Close menu" />
          <View style={[styles.headerMenu, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <TouchableOpacity
              style={styles.headerMenuItem}
              onPress={() => {
                setHeaderMenu(false);
                Alert.alert('Clear chat', 'Remove all messages from this device only? They stay on the server and for the other person.', [
                  { text: 'Clear', style: 'destructive', onPress: clearChatLocal },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
              accessibilityLabel="Clear chat"
            >
              <Icon name="trash-outline" size={18} color={theme.danger} style={{ marginRight: 12 }} />
              <Text style={{ color: theme.danger, fontSize: 15 }}>Clear chat</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Messages */}
      <View style={[styles.msgArea, { backgroundColor: chatBg }]}>
        {CHAT_BACKGROUND && (
          <Image
            source={{ uri: CHAT_BACKGROUND }}
            style={StyleSheet.absoluteFill}
            resizeMode="repeat"
            fadeDuration={0}
          />
        )}
        <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, idx) => String(item.id || `tmp-${idx}`)}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        onScrollToIndexFailed={onScrollToIndexFailed}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        updateCellsBatchingPeriod={30}
        windowSize={11}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
        style={{ backgroundColor: 'transparent' }}
      />
      </View>

      {!atBottomNear && !selMode && !recording && (
        <TouchableOpacity
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: false });
            atBottomRef.current = true;
            setAtBottomNear(true);
            setPendingCount(0);
          }}
          style={[styles.fab, { backgroundColor: theme.primary, bottom: fabBottom }]}
          accessibilityLabel="Scroll to latest message"
        >
          {pendingCount > 0 && (
            <View style={[styles.fabBadge, { backgroundColor: theme.danger }]}>
              <Text style={styles.fabBadgeText}>{pendingCount > 99 ? '99+' : pendingCount}</Text>
            </View>
          )}
          <View style={styles.fabChevrons}>
            <Icon name="chevron-down" size={15} color="#fff" style={{ marginBottom: -7 }} />
            <Icon name="chevron-down" size={15} color="#fff" />
          </View>
        </TouchableOpacity>
      )}

      {/* More emojis (reached via the + on the reaction bar). Reactions only. */}
      {reactionMenu && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={styles.menuBackdrop} onPress={() => setReactionMenu(null)} />
          <View style={[styles.menu, { backgroundColor: theme.card }]}>
            <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Reactions</Text>
            <View style={styles.reactionRow}>
              {sheetReactions.map((r) => (
                <TouchableOpacity key={r} onPress={() => reactTo(reactionMenu.id, r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                  <Text style={{ fontSize: 22 }}>{emojiSpan(r)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}

      {/* WhatsApp-style floating reaction bar (intelligently kept on-screen) */}
      {reactionPop && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={styles.menuBackdrop} onPress={() => setReactionPop(null)} />
          <View
            style={[
              styles.reactionPop,
              { backgroundColor: theme.card, borderColor: theme.border, left: reactionPop.left, top: reactionPop.top },
            ]}
          >
            {reactionPopRow.map((e) => (
              <TouchableOpacity
                key={e}
                onPress={() => { reactTo(reactionPop.msg.id, e); setReactionPop(null); }}
                style={styles.reactionPopBtn}
                accessibilityLabel={`React ${e}`}
              >
                <Text style={{ fontSize: 23 }}>{emojiSpan(e)}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              onPress={() => { setReactionMenu(reactionPop.msg); setReactionPop(null); }}
              style={styles.reactionPopBtn}
              accessibilityLabel="Show all options"
            >
              <Icon name="add" size={20} color={theme.primary} />
            </TouchableOpacity>
            <View style={[styles.reactionPopCaret, { backgroundColor: theme.card, left: reactionPop.caretX }]} />
          </View>
        </View>
      )}

      {/* Replying bar */}
      {replyingTo && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('reply')}>
          <View style={[styles.replyLine, { backgroundColor: theme.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyTitle, { color: theme.primary }]}>
              Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUserName}
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreview, { color: theme.textSecondary }]}>
              {emojiSpan(replyPreview(replyingTo))}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)}>
            <Icon name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Editing bar */}
      {editing && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('edit')}>
          <View style={[styles.replyLine, { backgroundColor: theme.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyTitle, { color: theme.primary }]}>
              Editing message
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreview, { color: theme.textSecondary }]}>
              {editing.content || ''}
            </Text>
          </View>
          <TouchableOpacity onPress={() => { setEditing(null); setText(''); }}>
            <Icon name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Recording UI */}
      {recording && !selMode && (
        <View style={[styles.recBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('rec')}>
          <View style={[styles.recPill, { backgroundColor: theme.primaryLight }]}>
            <View style={[styles.recDot, { backgroundColor: theme.danger }]} />
            <Icon name="mic" size={15} color={theme.danger} />
            <Text style={[styles.recTime, { color: theme.text }]}>
              {fmtDur(recordTime)}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => stopRecording(true)} style={styles.recCancel} accessibilityLabel="Cancel recording">
            <Icon name="trash-outline" size={18} color={theme.danger} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => stopRecording(false)}
            style={[styles.recSend, { backgroundColor: theme.primary }]}
            accessibilityLabel="Send voice message"
          >
            <Icon name="send" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {/* Attach options: Photo · Camera · Files */}
      {showAttach && !recording && !selMode && (
        <View style={[styles.attachBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('attach')}>
          <AttachBtn label="Photo" icon="image-outline" color={theme.primary} onPress={() => pickMedia('photo')} theme={theme} />
          <AttachBtn label="Camera" icon="camera-outline" color={theme.primaryDeep} onPress={() => pickMedia('camera')} theme={theme} />
          <AttachBtn label="Files" icon="folder-open-outline" color={theme.primary} onPress={() => pickMedia('files')} theme={theme} />
        </View>
      )}

      {/* Emoji quick-pick strip (WhatsApp-style emoji button) */}
      {showEmoji && !recording && !selMode && (
        <View style={[styles.attachBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('emoji')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {emojiQuick.map((e) => (
              <TouchableOpacity
                key={e}
                style={styles.emojiPickBtn}
                onPress={() => {
                  setText((prev) => prev + e);
                  inputRef.current?.focus();
                }}
                accessibilityLabel={`Emoji ${e}`}
              >
                <Text style={{ fontSize: 26 }}>{emojiSpan(e)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Composer: [emoji] [input…………] [attachment] [mic/send] (camera lives in the attachment menu) */}
      {!recording && !selMode && (
        <View
          style={[styles.composer, { backgroundColor: composerBg, borderTopColor: theme.border }]}
          onLayout={(e) => setComposerH(Math.round(e.nativeEvent.layout.height))}
        >
          <View style={styles.composerRow}>
            <TouchableOpacity
              style={[styles.composerBtn, { backgroundColor: showEmoji ? theme.primary : theme.inputBg }]}
              onPress={() => { if (showAttach) setShowAttach(false); setShowEmoji(!showEmoji); inputRef.current?.focus(); }}
              accessibilityLabel="Add emoji"
            >
              <Icon name="happy-outline" size={22} color={showEmoji ? '#fff' : theme.primary} />
            </TouchableOpacity>
            <View style={[styles.inputWrap, { backgroundColor: theme.inputBg }]}>
              <TextInput
                ref={inputRef}
                value={text}
                onChangeText={onType}
                placeholder="Type a message"
                placeholderTextColor={theme.textSecondary}
                style={[styles.input, { color: theme.text }]}
                multiline
                onPressIn={reopenKeyboard}
                onFocus={ensureKeyboard}
              />
            </View>
            <TouchableOpacity
              style={[styles.composerBtn, { backgroundColor: showAttach ? theme.primary : theme.inputBg }]}
              onPress={() => { if (showEmoji) setShowEmoji(false); setShowAttach(!showAttach); }}
              accessibilityLabel="Add attachments"
            >
              <Icon name="attach-outline" size={20} color={showAttach ? '#fff' : theme.primary} />
            </TouchableOpacity>
            {text.trim() ? (
              <TouchableOpacity style={[styles.sendBtn, { backgroundColor: theme.primary }]} onPress={sendText} accessibilityLabel="Send message">
                <Icon name="send" size={18} color="#fff" />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[styles.micBtn, { backgroundColor: theme.primary }]} onPress={startRecording} accessibilityLabel="Record voice message">
                <Icon name="mic" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {mediaViewer && (
        <MediaViewer
          items={mediaViewer.items}
          startIndex={mediaViewer.index}
          headerText={otherUserName}
          currentUserId={currentUser.id}
          theme={theme}
          onClose={() => setMediaViewer(null)}
          onReact={reactTo}
          onReply={(item) => setReplyingTo(item)}
          onSendReplyMessage={sendReplyText}
          onDelete={(item, mode) => deleteMessage(item, mode)}
          onSendDrawing={uploadDrawing}
        />
      )}

      {previewAsset && (
        <MediaPreview
          uri={previewAsset.uri}
          type={previewAsset.type}
          fileName={previewAsset.fileName}
          mimeType={previewAsset.mimeType}
          theme={theme}
          onCancel={() => setPreviewAsset(null)}
          onSend={handlePreviewSend}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function AttachBtn({ label, icon, color, onPress, theme }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.attachBtn}>
      <View style={[styles.attachIcon, { backgroundColor: theme.inputBg }]}>
        <Icon name={icon} size={24} color={color} />
      </View>
      <Text style={[styles.attachLabel, { color: theme.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function lastSeenText(ts) {
  if (!ts) return 'Offline';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'Offline';
  const now = new Date();
  const mins = Math.floor((now - d) / 60000);
  if (mins < 1) return 'Active now';
  if (mins < 60) return `Last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last seen today at ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Last seen ${d.getDate()}/${d.getMonth() + 1}`;
}

function replyPreview(m) {
  if (!m) return '';
  if (m.is_deleted_for_everyone) return 'This message was deleted';
  if (m.type === 'IMAGE') return '📷 Photo';
  if (m.type === 'VIDEO') return '🎬 Video';
  if (m.type === 'VOICE') return 'Voice message';
  if (m.type === 'FILE' || m.type === 'DOCUMENT') return '📄 ' + (m.content || 'File');
  return emojiSpan(m.content || 'Message');
}

function mimeFor(m) {
  if (m.type === 'VIDEO') return 'video/mp4';
  if (m.type === 'IMAGE') return 'image/jpeg';
  if (m.type === 'VOICE') return 'audio/mp4';
  const n = (m.content || m.file_name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z')) return 'application/zip';
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (n.endsWith('.m4a')) return 'audio/mp4';
  if (n.endsWith('.ogg')) return 'audio/ogg';
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.3gp')) return 'video/3gpp';
  if (n.endsWith('.mkv')) return 'video/x-matroska';
  if (n.endsWith('.avi')) return 'video/x-msvideo';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.doc') || n.endsWith('.docx')) return 'application/msword';
  if (n.endsWith('.xls') || n.endsWith('.xlsx')) return 'application/vnd.ms-excel';
  if (n.endsWith('.ppt') || n.endsWith('.pptx')) return 'application/vnd.ms-powerpoint';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function fileNameFromUrl(url) {
  if (!url) return null;
  const parts = url.split('/');
  const last = parts[parts.length - 1];
  return last ? last.split(/[?#]/)[0] : null;
}

function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return null;
  const base = name.split(/[?#]/)[0];
  return (base.replace(/[^\w.\- ]+/g, '_') || null).slice(0, 120);
}

function extForMime(mime) {
  if (!mime) return 'bin';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/zip') return 'zip';
  if (mime.startsWith('text/')) return 'txt';
  if (mime.includes('word') || mime.includes('msword')) return 'doc';
  if (mime.includes('excel') || mime.includes('sheet')) return 'xls';
  if (mime.includes('powerpoint')) return 'ppt';
  if (mime.startsWith('image/')) return 'img';
  return 'bin';
}

function formatBytes(b) {
  if (!b || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function dedupeReactions(reactions) {
  const map = new Map();
  (reactions || []).forEach((r) => {
    if (!r || !r.reaction) return;
    map.set(r.reaction, (map.get(r.reaction) || 0) + 1);
  });
  return Array.from(map.entries()).map(([emoji, count]) => ({ emoji, count }));
}

function MessageRowFn({ message, isSent, grouped, theme, receivedBubble, flash, ownId, otherName, replyReferentOf, onLongPress, onOpenMedia, onRetry, onReply, onDoubleTap, onJumpToReply, replyPreviewOf, suggestEdit, onEditRow, onCancelUpload, voicePlaying, voiceProgress, onPlayVoice, selMode, selActive, onSelectPress, onEnterSelect }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const revealOpacity = useRef(new Animated.Value(0)).current;
  const translateRef = useRef(0);
  const swipeDirection = isSent ? -1 : 1; // sent bubbles swipe right→left, received left→right
  const replied = useRef(false);

  const swipeAction = (m) => (suggestEdit && onEditRow ? onEditRow(m) : onReply(m));

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && Math.abs(g.dx) < 200,
    onPanResponderMove: (_, g) => {
      let v = swipeDirection === 1 ? Math.max(0, g.dx) : Math.min(0, g.dx);
      translateX.setValue(Math.max(-110, Math.min(110, v)));
      revealOpacity.setValue(1);
    },
    onPanResponderRelease: (_, g) => {
      const trigger = swipeDirection === 1 ? g.dx > 70 : g.dx < -70;
      if (trigger) {
        replied.current = true;
        Animated.spring(translateX, { toValue: swipeDirection * 110, useNativeDriver: true, bounciness: 0, speed: 30 }).start(() => {
          swipeAction(message);
          replied.current = false;
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          Animated.timing(revealOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        });
      } else {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 30 }).start();
        Animated.timing(revealOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      Animated.timing(revealOpacity, { toValue: 0, duration: 120, useNativeDriver: true }).start();
    },
  })).current;

  const hasMedia = !!(message.media_url || message.thumb_url);
  const voicePct = `${Math.min(100, Math.max(0, Math.round((voiceProgress || 0) * 100)))}%`;
  const statusIcon = message.status === 'READ'
    ? 'checkmark-done' : message.status === 'DELIVERED'
      ? 'checkmark-done' : 'checkmark';
  const statusColor = message.status === 'READ' ? theme.readBlue : (isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary);

  const singleEmoji = message.type === 'TEXT' && isSingleEmoji(message.content);
  const mediaBase = Math.min(APP_W * 0.62, 250);
  const mw = message.media_width;
  const mh = message.media_height;
  const mediaRatio = (mw && mh) ? Math.min(Math.max(mh / mw, 0.5), 2.2) : 0.81;
  const mediaW = mediaBase;
  const mediaH = mediaBase * mediaRatio;

  // Double-tap ↔ single-tap detection (WhatsApp style)
  const lastTap = useRef(0);
  const singleTimer = useRef(null);
  const handlePress = () => {
    if (selMode) {
      onSelectPress && onSelectPress(message);
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 300) {
      clearTimeout(singleTimer.current);
      lastTap.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTap.current = now;
    clearTimeout(singleTimer.current);
    singleTimer.current = setTimeout(() => {
      tapAction(message);
    }, 290);
  };

  const tapAction = (m) => {
    if (m._uploadError && onRetry) {
      onRetry(m);
      return;
    }
    if (m.type === 'IMAGE' || m.type === 'VIDEO' || m.type === 'FILE' || m.type === 'DOCUMENT') {
      onOpenMedia(m);
      return;
    }
    // Single tap on a TEXT message enters selection mode (media keeps tap-to-open).
    if (m.type === 'TEXT' && onEnterSelect) {
      onEnterSelect(m);
    }
  };

  const replyRevealStyle = isSent ? styles.revealRight : styles.revealLeft;

  const refMsg = message.reply_to && replyReferentOf ? replyReferentOf(message.reply_to) : null;
  const refName = refMsg
    ? (refMsg.sender_id === ownId ? 'You' : (refMsg.sender_name || refMsg.sender_username || otherName || 'Message'))
    : 'Message';

  return (
    <View style={[styles.msgRow, { justifyContent: isSent ? 'flex-end' : 'flex-start' }]}>
      <View style={{ maxWidth: '80%', position: 'relative' }}>
        {/* Swipe affordance revealed behind the bubble (reply, or edit for your own text) */}
        <Animated.View style={[styles.swipeReveal, replyRevealStyle, { backgroundColor: isSent ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)', opacity: revealOpacity }]}>
          <Icon name={suggestEdit ? 'create-outline' : 'arrow-back'} size={14} color="#fff" />
        </Animated.View>
        <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
            <TouchableOpacity
              style={[
                styles.bubble,
                isSent ? [styles.sentBubble, { backgroundColor: theme.sentBubble }] : [styles.recvBubble, { backgroundColor: receivedBubble, borderColor: 'rgba(255,255,255,0.07)' }],
                grouped && { borderBottomRightRadius: isSent ? 6 : 14, borderBottomLeftRadius: isSent ? 14 : 6 },
                flash && { backgroundColor: 'rgba(124,77,255,0.34)' },
                selActive && !singleEmoji && { backgroundColor: isSent ? mixWhite(theme.sentBubble, 0.35) : mixWhite(receivedBubble, 0.3) },
              ]}
              onPress={handlePress}
              onLongPress={() => { if (selMode) return; clearTimeout(singleTimer.current); onLongPress(message); onEnterSelect && onEnterSelect(message); }}
              delayLongPress={350}
            >
              {message.is_deleted_for_everyone ? (
                <Text style={{ fontStyle: 'italic', opacity: 0.7, color: isSent ? '#fff' : theme.textSecondary }}>
                  This message was deleted
                </Text>
              ) : message.type === 'IMAGE' || message.type === 'VIDEO' ? (
                <View>
                  <Image
                    source={{ uri: absUrl(message.thumb_url || message.media_url) }}
                    style={[styles.mediaImage, { width: mediaW, height: mediaH, backgroundColor: isSent ? 'rgba(255,255,255,0.12)' : theme.primaryLight }]}
                    resizeMode="cover"
                  />
                  {(message.type === 'VIDEO' || message._uploading) && (
                    <View style={styles.videoPlayWrap}>
                      {message.type === 'VIDEO' && !message._pending && !message._uploading ? (
                        <View style={styles.videoPlay}>
                          <Icon name="play" size={26} color="#fff" />
                        </View>
                      ) : message._uploading ? (
                        <UploadOverlay progress={message._uploadProgress} onCancel={onCancelUpload ? () => onCancelUpload(message) : null} />
                      ) : null}
                    </View>
                  )}
                  {message._uploadError && (
                    <TouchableOpacity
                      style={[StyleSheet.absoluteFillObject, styles.mediaError, { backgroundColor: 'rgba(0,0,0,0.35)' }]}
                      onPress={() => (onRetry ? onRetry(message) : null)}
                    >
                      <Icon name="alert-circle-outline" size={26} color="#fff" />
                      <Text style={{ color: '#fff', fontSize: 12, marginTop: 4, fontWeight: '600' }}>
                        Tap to retry
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : message.type === 'VOICE' ? (
                <TouchableOpacity onPress={() => (onPlayVoice ? onPlayVoice(message) : onOpenMedia(message))} activeOpacity={0.7} style={{ minWidth: 180 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.voicePlay, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight }]}>
                      <Icon name={voicePlaying ? 'pause' : 'play'} size={18} color={isSent ? '#fff' : theme.primary} />
                    </View>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                        {[5, 9, 13, 7, 15, 11, 8, 13, 7, 10].map((h, i) => (
                          <View
                            key={i}
                            style={{
                              width: 3, height: h, borderRadius: 2,
                              backgroundColor: isSent ? 'rgba(255,255,255,0.9)' : theme.primary,
                              opacity: i / 10 <= (voiceProgress || 0) ? 1 : (isSent ? 0.45 : 0.35),
                            }}
                          />
                        ))}
                      </View>
                      <View style={{ height: 2, marginTop: 5, borderRadius: 1, overflow: 'hidden', backgroundColor: isSent ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.12)' }}>
                        <View style={{ width: voicePct, height: 2, backgroundColor: isSent ? '#fff' : theme.primary }} />
                      </View>
                      <Text style={{ marginTop: 5, fontSize: 11, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary }}>
                        {voicePlaying
                          ? fmtDur(Math.min(message.duration || 0, (voiceProgress || 0) * (message.duration || 0)))
                          : fmtDur(message.duration || 26)} · 1×
                      </Text>
                    </View>
                  </View>
                  {message._uploading && (
                    <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'center' }}>
                      <ArcProgress size={28} thickness={3} progress={message._uploadProgress} color={isSent ? '#fff' : theme.primary} track={isSent ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.1)'} />
                      <Text style={{ marginLeft: 6, fontSize: 10, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary, fontWeight: '600' }}>
                        {Math.round((message._uploadProgress || 0) * 100)}%
                      </Text>
                    </View>
                  )}
                  {message._uploadError && (
                    <Text style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.85)' : theme.danger, marginTop: 4 }}>
                      Upload failed · tap to retry
                    </Text>
                  )}
                </TouchableOpacity>
              ) : message.type === 'FILE' || message.type === 'DOCUMENT' ? (
                <View style={[styles.docRow, { backgroundColor: isSent ? 'rgba(255,255,255,0.14)' : theme.primaryLight, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center', minWidth: 200 }]}>
                  <View style={[styles.docIcon, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primary }]}>
                    <Icon name="document" size={18} color="#fff" />
                  </View>
                  <View style={{ marginLeft: 10, flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: isSent ? '#fff' : theme.receivedText, maxWidth: 150 }}>
                      {(message.file_name || message.content || 'Document')}
                    </Text>
                    <Text style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.7)' : theme.textSecondary, marginTop: 2 }}>
                      {formatBytes(message.media_size || 0) || 'File'}
                    </Text>
                    {message._uploading ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                        <ArcProgress size={30} thickness={3} progress={message._uploadProgress} color={isSent ? '#fff' : theme.primary} track={isSent ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.1)'} />
                        <Text style={{ fontSize: 10, marginLeft: 6, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary, fontWeight: '600' }}>
                          {Math.round((message._uploadProgress || 0) * 100)}%
                        </Text>
                        {onCancelUpload && (
                          <TouchableOpacity onPress={() => onCancelUpload(message)} style={{ marginLeft: 8, padding: 3 }} accessibilityLabel="Cancel upload">
                            <Icon name="close" size={14} color={isSent ? '#fff' : theme.textSecondary} />
                          </TouchableOpacity>
                        )}
                      </View>
                    ) : null}
                    {message._uploadError && (
                      <Text style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.85)' : theme.danger, marginTop: 2 }}>
                        Upload failed · tap to retry
                      </Text>
                    )}
                  </View>
                </View>
              ) : (
                <View>
                  {singleEmoji ? (
                    <View style={styles.msgEmojiWrap}>
                      {message.reply_to && (
                        <TouchableOpacity
                          activeOpacity={0.65}
                          onPress={() => { if (onJumpToReply) onJumpToReply(message.reply_to); }}
                          style={[styles.replyRef, { backgroundColor: isSent ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)' }]}
                        >
                          <Text numberOfLines={1} style={{ fontWeight: '700', fontSize: 11, color: isSent ? '#fff' : '#9C86F5' }}>
                            {refName}
                          </Text>
                          <Text numberOfLines={2} style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : 'rgba(232,234,236,0.85)' }}>
                            {replyPreviewOf ? emojiSpan(replyPreviewOf(message.reply_to)) : '…'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      <Text style={[styles.msgEmojiSingle, flash && { backgroundColor: 'rgba(124,77,255,0.28)', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 4 }]}>
                        {emojiSpan(message.content)}
                      </Text>
                    </View>
                  ) : (
                    <View>
                      {message.reply_to && (
                        <TouchableOpacity
                          activeOpacity={0.65}
                          onPress={() => { if (onJumpToReply) onJumpToReply(message.reply_to); }}
                          style={[styles.replyRef, { backgroundColor: isSent ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)' }]}
                        >
                          <Text numberOfLines={1} style={{ fontWeight: '700', fontSize: 11, color: isSent ? '#fff' : '#9C86F5' }}>
                            {refName}
                          </Text>
                          <Text numberOfLines={2} style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : 'rgba(232,234,236,0.85)' }}>
                            {replyPreviewOf ? emojiSpan(replyPreviewOf(message.reply_to)) : '…'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      <Text
                        style={[
                          styles.msgText,
                          { color: isSent ? '#fff' : theme.receivedText },
                        ]}
                      >
                        {emojiSpan(message.content)}
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {!message.is_deleted_for_everyone && (
                <View style={[
                  styles.msgMeta,
                  singleEmoji && { justifyContent: isSent ? 'flex-end' : 'flex-start' },
                  singleEmoji && styles.msgMetaPill,
                  singleEmoji && { alignSelf: isSent ? 'flex-end' : 'flex-start' },
                  singleEmoji && selActive && { backgroundColor: 'rgba(124,77,255,0.45)' },
                ]}>
                  {message.is_view_once && <Icon name="lock-closed" size={10} color={isSent ? '#fff' : theme.textSecondary} />}
                  {message.is_edited && <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.7)' }]}>edited</Text>}
                  <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.75)' }, singleEmoji && !isSent && { color: 'rgba(255,255,255,0.85)' }]}>
                    {message.created_at ? timeOf(message.created_at) : ''}
                  </Text>
                  {isSent && <Icon name={statusIcon} size={13} color={statusColor} />}
                </View>
              )}
            </TouchableOpacity>
          </Animated.View>

        {message.reactions && message.reactions.length > 0 && (
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => onLongPress(message)}
            style={[
              styles.reactionBadge,
              { backgroundColor: selMode ? 'rgba(255,255,255,0.5)' : theme.card, borderColor: theme.border },
            ]}
          >
            {dedupeReactions(message.reactions).map(({ emoji, count }, i) => (
              <View key={i} style={styles.reactionBadgeItem}>
                <Text style={{ fontSize: 12 }}>{emojiSpan(emoji)}</Text>
                {count > 1 ? <Text style={[styles.reactionBadgeCount, { color: theme.textSecondary }]}>{count}</Text> : null}
              </View>
            ))}
          </TouchableOpacity>
        )}
        </View>
      </View>
  );
}

const MessageRow = memo(MessageRowFn);

function ArcProgress({ size = 56, thickness = 4, progress, color = '#fff', track = 'rgba(255,255,255,0.3)' }) {
  const p = Math.min(Math.max(progress || 0, 0), 1);
  const deg = p * 360 - 90;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: thickness, borderColor: track }} />
      <View
        style={{
          position: 'absolute', width: size, height: size, borderRadius: size / 2,
          borderWidth: thickness,
          borderColor: color, borderTopColor: 'transparent', borderLeftColor: 'transparent',
          transform: [{ rotate: `${deg}deg` }],
        }}
      />
      <Text style={{ color: '#fff', fontSize: Math.max(10, Math.round(size * 0.22)), fontWeight: '700' }}>{Math.round(p * 100)}</Text>
    </View>
  );
}

function UploadOverlay({ progress, onCancel }) {
  return (
    <View style={styles.uploadOverlay}>
      <ArcProgress size={54} thickness={4} progress={progress} />
      <View style={{ height: 4 }} />
      {onCancel && (
        <TouchableOpacity onPress={onCancel} style={styles.uploadCancel} accessibilityLabel="Cancel upload">
          <Icon name="close" size={14} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

function timeOf(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Voice durations as m:ss (rolls over at 60s instead of showing "0:61").
function fmtDur(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// True only for a SINGLE emoji (WhatsApp-style big-emoji message). Multi-emoji
// or text+emoji falls back to the normal bubble at default text size.
// Hermes-safe: no \p{...} property escapes, just mark-stripping + code-point count.
function isSingleEmoji(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t || /[A-Za-z0-9]/.test(t)) return false;
  const stripped = t
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\u20E3/g, '');
  return Array.from(stripped).length === 1 && /[^\x00-\x7F]/.test(stripped);
}

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string') return hex;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Lighten a hex color toward white (used for the selection highlight tint).
function mixWhite(hex, amt) {
  if (!hex || typeof hex !== 'string') return hex;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  const m = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${m((n >> 16) & 255)}, ${m((n >> 8) & 255)}, ${m(n & 255)})`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  backBtn: { marginRight: 8 },
  avatarSmall: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 10, overflow: 'hidden' },
  avatarSmallText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  avatarImg: { width: '100%', height: '100%' },
  headerName: { fontSize: 16, fontWeight: '700' },
  headerStatus: { fontSize: 12, marginLeft: 4 },
  selToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: 6, borderBottomWidth: 1 },
  selToolItem: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 4, minWidth: 64 },
  selToolItemDisabled: { opacity: 0.35 },
  selToolLabel: { fontSize: 11, marginTop: 2, fontWeight: '600' },
  messageList: { padding: 14, paddingBottom: 18 },
  msgArea: { flex: 1, overflow: 'hidden' },
  msgRow: { flexDirection: 'row', marginVertical: 3 },
  bubble: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, overflow: 'hidden' },
  sentBubble: { borderBottomRightRadius: 4 },
  recvBubble: { borderBottomLeftRadius: 4, borderWidth: 1 },
  msgText: { fontSize: 15, lineHeight: 21 },
  msgEmojiWrap: { paddingVertical: 2 },
  msgEmoji: { fontSize: 30, lineHeight: 36, paddingHorizontal: 10, paddingVertical: 4 },
  msgEmojiSingle: { fontSize: 30, lineHeight: 36, paddingHorizontal: 4, opacity: 1 },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 3 },
  msgMetaPill: { backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  metaText: { fontSize: 10, color: '#9B96A8' },
  replyRef: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, marginBottom: 4, marginLeft: -2, borderLeftWidth: 3, borderLeftColor: '#6C3CE9' },
  reactionBadge: { alignSelf: 'flex-end', marginTop: -8, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, zIndex: 5, elevation: 3, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
  reactionBadgeItem: { flexDirection: 'row', alignItems: 'center' },
  reactionBadgeCount: { fontSize: 10, marginLeft: 2 },
  headerIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  headerMenuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 25, justifyContent: 'flex-start' },
  headerMenu: { alignSelf: 'flex-end', marginTop: 62, marginRight: 8, borderRadius: 14, minWidth: 200, paddingVertical: 6, borderWidth: StyleSheet.hairlineWidth, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
headerMenuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  composer: { borderTopWidth: 1, padding: 10, paddingBottom: Platform.OS === 'ios' ? 20 : 12 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  composerBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  emojiPickBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  attachBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1 },
  attachBtn: { alignItems: 'center', marginRight: 20 },
  attachIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: 12, marginTop: 6 },
  inputWrap: { flex: 1, borderRadius: 22, paddingHorizontal: 12, maxHeight: 100, justifyContent: 'center' },
  input: { fontSize: 14, paddingVertical: 8, maxHeight: 100 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#6C3CE9', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  micBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#6C3CE9', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  micBtnRec: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', elevation: 5, shadowColor: '#E53935', shadowOpacity: 0.35, shadowRadius: 7, shadowOffset: { width: 0, height: 3 } },
  recBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1 },
  recCancel: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(229,57,53,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  recSend: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  recPill: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  recDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  recTime: { fontSize: 14, fontWeight: '700', marginLeft: 6, fontVariant: ['tabular-nums'] },
  replyBar: { flexDirection: 'row', alignItems: 'center', padding: 10, borderTopWidth: 1 },
  replyLine: { width: 3, height: 32, borderRadius: 2, marginRight: 10 },
  replyTitle: { fontWeight: '700', fontSize: 12 },
  replyPreview: { fontSize: 12 },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  reactionPop: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    paddingHorizontal: 7,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  reactionPopBtn: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 21 },
  reactionPopCaret: {
    position: 'absolute',
    bottom: -6,
    width: 12,
    height: 12,
    transform: [{ rotate: '45deg' }],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menu: { position: 'absolute', bottom: 90, left: 24, right: 24, borderRadius: 18, padding: 14, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 8 },
  menuTitle: { fontSize: 13, fontWeight: '700' },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10, marginVertical: 12 },
  reactionBtn: { borderRadius: 14, width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  mediaImage: { width: Math.min(APP_W * 0.62, 250), height: Math.min(APP_W * 0.62, 250) * 0.81, borderRadius: 12, marginBottom: 4 },
  uploadOverlay: { alignItems: 'center', justifyContent: 'center', padding: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.35)' },
  uploadCancel: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 16, width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, zIndex: 30 },
  fabChevrons: { alignItems: 'center', justifyContent: 'center' },
  fabBadge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  fabBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoPlayWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 6, alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  mediaError: { alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginBottom: 4 },
  voicePlay: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  docIcon: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  swipeReveal: { position: 'absolute', top: 6, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', zIndex: 0 },
  revealLeft: { left: 2 },
  revealRight: { right: 2 },
});