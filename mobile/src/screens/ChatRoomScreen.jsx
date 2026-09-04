import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Keyboard, Linking, Modal,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { quickReactions } from '../theme';
import { absUrl } from '../config';
import Clipboard from '@react-native-clipboard/clipboard';
import { ensureCameraPermission, ensureMediaPermission, ensureMicPermission } from '../services/permissions';

export default function ChatRoomScreen({ socket, currentUser, otherUser, onBack }) {
  const { theme } = useTheme();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [reactionMenu, setReactionMenu] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [showAttach, setShowAttach] = useState(false);
  const [presence, setPresence] = useState(null);
  const listRef = useRef(null);
  const recTimer = useRef(null);
  const typingTimer = useRef(null);
  const [viewingMedia, setViewingMedia] = useState(null);
  const [atBottomNear, setAtBottomNear] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const atBottomRef = useRef(true);

  const openMedia = (message) => {
    if (!message || !message.media_url) return;
    const uri = absUrl(message.media_url);
    if (message.type === 'VIDEO' || message.type === 'VOICE') {
      Linking.openURL(uri).catch(() => {});
    } else {
      setViewingMedia({ uri, message });
    }
  };

  const onType = (t) => {
    setText(t);
    if (socket && t.trim()) {
      if (!typingTimer.current) {
        socket.emit('typing:start', { otherUserId: otherUser.id });
      }
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        if (socket) socket.emit('typing:stop', { otherUserId: otherUser.id });
        typingTimer.current = null;
      }, 1500);
    }
  };

  useEffect(() => {
    if (!socket) return;

    socket.emit('conversation:open', { otherUserId: otherUser.id });

    const hHistory = (msgs) => setMessages(msgs);
    const hReceive = ({ message }) => {
      setMessages((prev) => [...prev, { ...message, _local: message.sender_id === currentUser.id }]);
      if (message.sender_id !== currentUser.id) {
        if (!atBottomRef.current) {
          setPendingCount((n) => n + 1);
        } else {
          setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
        }
        socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
      }
    };
    const hDelivered = ({ messageId }) => updateStatus(messageId, 'DELIVERED');
    const hRead = ({ messageIds }) => {
      setMessages((prev) => prev.map((m) => (messageIds.includes(m.id) ? { ...m, status: 'READ' } : m)));
    };
    const hTyping = ({ userId }) => { if (userId === otherUser.id) setTyping(true); };
    const hTypingStop = ({ userId }) => { if (userId === otherUser.id) setTyping(false); };
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
    const hCleared = ({ conversationId }) => { setMessages([]); setShowAttach(false); setReplyingTo(null); setEditing(null); setText(''); };
    socket.on('conversation:cleared', hCleared);
    const hPresence = ({ userId, isOnline, lastSeen }) => {
      if (userId === otherUser.id) setPresence({ isOnline, lastSeen });
    };
    socket.on('presence:update', hPresence);

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
    };
  }, [socket, otherUser.id, currentUser.id]);

  function updateStatus(id, status) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
  }

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
      otherUserId: otherUser.id,
      type: 'TEXT',
      content,
      replyTo: replyingTo?.id || null,
    };
    if (socket) socket.emit('typing:stop', { otherUserId: otherUser.id });
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    socket.emit('message:send', payload, (ack) => {
      if (ack?.ok) {
        setMessages((prev) => prev.map((m) => (m.id === tempId ? ack.message : m)));
      }
    });
    setText('');
    setReplyingTo(null);
  };

  const sendVoice = () => {
    socket.emit('message:send', {
      otherUserId: otherUser.id,
      type: 'VOICE',
      content: 'Voice message',
      duration: recordTime || 8,
      waveform: 'waveform',
    });
    setRecording(false);
    setRecordTime(0);
  };

  const startRecording = () => {
    ensureMicPermission();
    setRecording(true);
    setRecordTime(0);
    recTimer.current = setInterval(() => setRecordTime((t) => t + 1), 1000);
  };

  const stopRecording = (cancel) => {
    clearInterval(recTimer.current);
    if (cancel) { setRecording(false); setRecordTime(0); return; }
    setRecording(false);
    sendVoice();
  };

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

  const doAction = (action, message) => {
    setReactionMenu(null);
    if (action === 'reply') { setReplyingTo(message); }
    else if (action === 'edit') { setEditing(message); setText(message.content || ''); }
    else if (action === 'deleteMe') {
      socket.emit('message:delete', { messageId: message.id, mode: 'me' });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    } else if (action === 'deleteAll') {
      socket.emit('message:delete', { messageId: message.id, mode: 'everyone' });
    }
  };

  const pickMedia = (kind) => {
    setShowAttach(false);
    if (kind === 'photo' || kind === 'camera' || kind === 'gallery') {
      try {
        const ImagePicker = require('react-native-image-picker');
        const opts = [];
        if (kind === 'camera') {
          (async () => {
            const ok = await ensureCameraPermission();
            if (!ok) return;
            ImagePicker.launchCamera({ mediaType: 'photo' }, (r) => {
              if (!r.didCancel && r.assets && r.assets[0]) sendMedia(r.assets[0]);
            });
          })();
        } else {
          (async () => {
            await ensureMediaPermission();
            const sel = ImagePicker.launchImageLibrary;
            sel({ mediaType: 'photo', selectionLimit: 1 }, (r) => {
              if (!r.didCancel && r.assets && r.assets[0]) sendMedia(r.assets[0]);
            });
          })();
        }
      } catch (e) {
        socket.emit('message:send', { otherUserId: otherUser.id, type: 'IMAGE', content: '📷 Photo', mediaUrl: '' });
      }
    } else {
      socket.emit('message:send', { otherUserId: otherUser.id, type: 'DOCUMENT', content: '📄 Document', mediaUrl: '' });
    }
  };

  const sendMedia = (asset) => {
    if (!asset || !asset.uri) return;
    socket.emit('message:send', {
      otherUserId: otherUser.id,
      type: 'IMAGE',
      content: '📷 Photo',
      mediaUrl: asset.uri,
      thumbUrl: asset.uri,
    });
  };

  const isOnline = presence !== null ? presence.isOnline : !!otherUser.online;
  const lastSeen = presence !== null ? presence.lastSeen : otherUser.last_seen;
  const headerStatus = typing ? 'typing…' : (isOnline ? 'Online' : lastSeenText(lastSeen));

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="chevron-back" size={28} color={theme.primary} />
        </TouchableOpacity>
        <View style={[styles.avatarSmall, { backgroundColor: otherUser.id === 1 ? theme.primary : theme.primaryDeep }]}>
          {otherUser.profile_pic_url ? (
            <Image source={{ uri: absUrl(otherUser.profile_pic_url) }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarSmallText}>{otherUser.display_name[0].toUpperCase()}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerName, { color: theme.text }]}>{otherUser.display_name}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {typing && <Icon name="pulse" size={12} color={theme.primary} />}
            <Text style={[styles.headerStatus, { color: typing ? theme.primary : (isOnline ? theme.online : theme.textSecondary) }]}>
              {headerStatus}
            </Text>
          </View>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, idx) => String(item.id || `tmp-${idx}`)}
        onContentSizeChange={() => { if (atBottom.current) listRef.current?.scrollToEnd({ animated: true }); }}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          const h = e.nativeEvent.layoutMeasurement.height;
          const cs = e.nativeEvent.contentSize.height;
          const nearBottom = y + h >= cs - 50;
          atBottom.current = nearBottom;
          if (nearBottom) setPendingCount(0);
          setAtBottomNear(nearBottom);
        }}
        scrollEventThrottle={120}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        renderItem={({ item, index }) => {
          const isSent = item.sender_id === currentUser.id;
          const prev = messages[index - 1];
          const grouped = prev && prev.sender_id === item.sender_id;
          return (
            <MessageRow
              message={item}
              isSent={isSent}
              grouped={grouped}
              theme={theme}
              onLongPress={() => setReactionMenu(item)}
              onOpenMedia={openMedia}
            />
          );
        }}
        contentContainerStyle={styles.messageList}
      />

      {!atBottomNear && (
        <TouchableOpacity
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setAtBottomNear(true);
            setPendingCount(0);
          }}
          style={[styles.fab, { backgroundColor: theme.primary }]}
          accessibilityLabel="Scroll to bottom"
        >
          {pendingCount > 0 && (
            <View style={[styles.fabBadge, { backgroundColor: theme.danger }]}>
              <Text style={styles.fabBadgeText}>{pendingCount > 99 ? '99+' : pendingCount}</Text>
            </View>
          )}
          <Icon name="arrow-down" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Action menu */}
      {reactionMenu && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={styles.menuBackdrop} onPress={() => setReactionMenu(null)} />
          <View style={[styles.menu, { backgroundColor: theme.card }]}>
            <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Message actions</Text>
            <View style={styles.reactionRow}>
              {quickReactions.map((r) => (
                <TouchableOpacity key={r} onPress={() => reactTo(reactionMenu.id, r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                  <Text style={{ fontSize: 22 }}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Reply" icon="return-down-back-outline" onPress={() => doAction('reply', reactionMenu)} theme={theme} />
              <ActionBtn label="Like" icon="heart-outline" onPress={() => reactTo(reactionMenu.id, '❤️')} theme={theme} />
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Edit" icon="create-outline" onPress={() => doAction('edit', reactionMenu)} theme={theme} visible={reactionMenu.sender_id === currentUser.id} />
              <ActionBtn label="Copy" icon="copy-outline" onPress={() => { if (reactionMenu.content) Clipboard.setString(reactionMenu.content); }} theme={theme} />
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Delete for me" icon="trash-outline" onPress={() => doAction('deleteMe', reactionMenu)} theme={theme} danger visible={reactionMenu.sender_id === currentUser.id} />
              <ActionBtn label="Delete for all" icon="trash" onPress={() => doAction('deleteAll', reactionMenu)} theme={theme} danger visible={reactionMenu.sender_id === currentUser.id} />
            </View>
          </View>
        </View>
      )}

      {/* Replying bar */}
      {replyingTo && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <View style={[styles.replyLine, { backgroundColor: theme.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyTitle, { color: theme.primary }]}>
              Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUser.display_name}
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreview, { color: theme.textSecondary }]}>
              {replyingTo.type === 'VOICE' ? 'Voice message' : (replyingTo.content || 'Media message')}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)}>
            <Icon name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Editing bar */}
      {editing && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
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
      {recording && (
        <View style={[styles.recBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <View style={[styles.recPill, { backgroundColor: theme.primaryLight }]}>
            <View style={[styles.recDot, { backgroundColor: theme.danger }]} />
            <Icon name="mic" size={15} color={theme.danger} />
            <Text style={[styles.recTime, { color: theme.text }]}>
              0:{String(recordTime).padStart(2, '0')}
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

      {/* Attach options */}
      {showAttach && !recording && (
        <View style={[styles.attachBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <AttachBtn label="Photo" icon="image-outline" color={theme.primary} onPress={() => pickMedia('photo')} theme={theme} />
          <AttachBtn label="Camera" icon="camera-outline" color={theme.primaryDeep} onPress={() => pickMedia('camera')} theme={theme} />
          <AttachBtn label="Gallery" icon="images-outline" color={theme.primary} onPress={() => pickMedia('gallery')} theme={theme} />
          <AttachBtn label="Document" icon="document-outline" color={theme.primaryDeep} onPress={() => pickMedia('document')} theme={theme} />
        </View>
      )}

      {/* Composer */}
      <View style={[styles.composer, { backgroundColor: theme.composerBg, borderTopColor: theme.border }]}>
        {recording ? (
          <View style={{ flex: 1, alignItems: 'center' }}>
            <TouchableOpacity onPress={() => stopRecording(false)} style={[styles.micBtnRec, { backgroundColor: theme.danger }]}>
              <Icon name="stop" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.composerRow}>
            <TouchableOpacity
              style={[styles.composerBtn, { backgroundColor: showAttach ? theme.primary : theme.inputBg }]}
              onPress={() => { Keyboard.dismiss(); setShowAttach(!showAttach); setRecording(false); }}
              accessibilityLabel="Add attachments"
            >
              <Icon name="add" size={24} color={showAttach ? '#fff' : theme.primary} />
            </TouchableOpacity>
            <View style={[styles.inputWrap, { backgroundColor: theme.inputBg }]}>
              <TextInput
                value={text}
                onChangeText={onType}
                placeholder="Type a message"
                placeholderTextColor={theme.textSecondary}
                style={[styles.input, { color: theme.text }]}
                multiline
              />
            </View>
            {text.trim() ? (
              <TouchableOpacity style={[styles.sendBtn, { backgroundColor: theme.primary }]} onPress={sendText} accessibilityLabel="Send message">
                <Icon name="send" size={18} color="#fff" />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.micBtn, { backgroundColor: theme.primary }]}
                onPressIn={startRecording}
                onPressOut={() => stopRecording(false)}
                accessibilityLabel="Record voice message"
              >
                <Icon name="mic" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {viewingMedia && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setViewingMedia(null)}
        >
          <View style={[styles.mediaModal, { backgroundColor: 'rgba(0,0,0,0.95)' }]}>
            <TouchableOpacity style={styles.mediaModalClose} onPress={() => setViewingMedia(null)}>
              <Icon name="close" size={26} color="#fff" />
            </TouchableOpacity>
            <Image
              source={{ uri: viewingMedia.uri }}
              style={styles.mediaModalImg}
              resizeMode="contain"
            />
            <View style={styles.mediaModalHint}>
              <Icon name="download" size={14} color="rgba(255,255,255,0.7)" />
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginLeft: 6 }}>
                Saved in your messages
                {viewingMedia.message && viewingMedia.message.duration ? ` · ${viewingMedia.message.duration}s` : ''}
              </Text>
            </View>
          </View>
        </Modal>
      )}
    </KeyboardAvoidingView>
  );
}

function ActionBtn({ label, icon, onPress, theme, danger, visible = true }) {
  if (!visible) return null;
  return (
    <TouchableOpacity onPress={onPress} style={[styles.actionBtn, { backgroundColor: theme.primaryLight }]}>
      <Icon name={icon} size={16} color={danger ? theme.danger : theme.primary} />
      <Text style={{ color: danger ? theme.danger : theme.primary, fontWeight: '600', fontSize: 13, marginLeft: 6 }}>
        {label}
      </Text>
    </TouchableOpacity>
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

function MessageRow({ message, isSent, grouped, theme, onLongPress, onOpenMedia }) {
  
  const hasMedia = !!(message.media_url || message.thumb_url);
  const statusIcon = message.status === 'READ'
    ? 'checkmark-done' : message.status === 'DELIVERED'
      ? 'checkmark-done' : 'checkmark';
  const statusColor = message.status === 'READ' ? theme.readBlue : (isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary);

  return (
    <View style={[styles.msgRow, { justifyContent: isSent ? 'flex-end' : 'flex-start' }]}>
      <View style={{ maxWidth: '78%' }}>
        <TouchableOpacity
          style={[
            styles.bubble,
            isSent ? [styles.sentBubble, { backgroundColor: theme.sentBubble }] : [styles.recvBubble, { backgroundColor: theme.receivedBubble }],
            grouped && { borderBottomRightRadius: isSent ? 6 : 14, borderBottomLeftRadius: isSent ? 14 : 6 },
          ]}
          onLongPress={onLongPress}
          delayLongPress={350}
        >
          {message.is_deleted_for_everyone ? (
            <Text style={{ fontStyle: 'italic', opacity: 0.7, color: isSent ? '#fff' : theme.textSecondary }}>
              This message was deleted
            </Text>
          ) : message.type === 'IMAGE' || message.type === 'VIDEO' ? (
            <TouchableOpacity onPress={() => onOpenMedia(message)} activeOpacity={0.85}>
              <View>
                <Image
                  source={{ uri: absUrl(message.thumb_url || message.media_url) }}
                  style={[styles.mediaImage, { backgroundColor: isSent ? 'rgba(255,255,255,0.12)' : theme.primaryLight }]}
                  resizeMode="cover"
                />
                {message.type === 'VIDEO' && (
                  <View style={styles.videoPlayWrap}>
                    <View style={[styles.videoPlay, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
                      <Icon name="play" size={26} color="#fff" />
                    </View>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          ) : message.type === 'VOICE' ? (
            <TouchableOpacity onPress={() => onOpenMedia(message)} activeOpacity={0.7} style={{ minWidth: 180 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={[styles.voicePlay, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight }]}>
                  <Icon name="play" size={18} color={isSent ? '#fff' : theme.primary} />
                </View>
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                    {[5, 9, 13, 7, 15, 11, 8, 13, 7, 10].map((h, i) => (
                      <View key={i} style={{ width: 3, height: h, backgroundColor: isSent ? 'rgba(255,255,255,0.9)' : theme.primary, borderRadius: 2 }} />
                    ))}
                  </View>
                  <Text style={{ marginTop: 5, fontSize: 11, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary }}>
                    0:{String(message.duration || 26).padStart(2, '0')} · 1×
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ) : message.type === 'DOCUMENT' ? (
            <TouchableOpacity onPress={() => hasMedia && Linking.openURL(absUrl(message.media_url)).catch(() => {})} activeOpacity={0.7}>
              <View style={[styles.docRow, { backgroundColor: isSent ? 'rgba(255,255,255,0.14)' : theme.primaryLight, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center' }]}>
                <View style={[styles.docIcon, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primary }]}>
                  <Icon name="document" size={18} color="#fff" />
                </View>
                <View style={{ marginLeft: 10 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: isSent ? '#fff' : theme.receivedText }}>
                    {message.content || 'Document'}
                  </Text>
                  {hasMedia && <Text style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.7)' : theme.textSecondary }}>Tap to open</Text>}
                </View>
              </View>
            </TouchableOpacity>
          ) : (
            <View>
              {message.reply_to ? (
                <View style={[styles.replyRef, { backgroundColor: isSent ? 'rgba(255,255,255,0.15)' : theme.primaryLight }]}>
                  <Text style={{ fontWeight: '700', fontSize: 11, color: isSent ? '#fff' : theme.primary }}>Reply</Text>
                  <Text numberOfLines={1} style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary }}>preview…</Text>
                </View>
              ) : null}
              <Text style={{ fontSize: 15, color: isSent ? '#fff' : theme.receivedText }}>{message.content}</Text>
            </View>
          )}

          {!message.is_deleted_for_everyone && (
            <View style={styles.msgMeta}>
              {message.is_view_once && <Icon name="lock-closed" size={10} color={isSent ? '#fff' : theme.textSecondary} />}
              {message.is_edited && <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.7)' }]}>edited</Text>}
              <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.75)' }]}>
                {message.created_at ? timeOf(message.created_at) : ''}
              </Text>
              {isSent && <Icon name={statusIcon} size={13} color={statusColor} />}
            </View>
          )}
        </TouchableOpacity>

        {message.reactions && message.reactions.length > 0 && (
          <View style={[styles.reactionBadge, { backgroundColor: theme.primaryLight }, isSent ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' }]}>
            {message.reactions.map((r, i) => (
              <Text key={i} style={{ fontSize: 11 }}>{r.reaction}</Text>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function timeOf(t) {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  messageList: { padding: 14, paddingBottom: 20 },
  msgRow: { flexDirection: 'row', marginVertical: 3 },
  bubble: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  sentBubble: { borderBottomRightRadius: 4 },
  recvBubble: { borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#F0EDF8' },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 3 },
  metaText: { fontSize: 10, color: '#9B96A8' },
  replyRef: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, marginBottom: 4, marginLeft: -2, borderLeftWidth: 3, borderLeftColor: '#6C3CE9' },
  reactionBadge: { borderRadius: 12, paddingHorizontal: 6, paddingVertical: 2, marginTop: -6, marginHorizontal: 8, flexDirection: 'row' },
  composer: { borderTopWidth: 1, padding: 10, paddingBottom: Platform.OS === 'ios' ? 20 : 12 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  composerBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  attachBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1 },
  attachBtn: { alignItems: 'center', marginRight: 22 },
  attachIcon: { width: 54, height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
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
  menu: { position: 'absolute', bottom: 90, left: 24, right: 24, borderRadius: 18, padding: 14, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 8 },
  menuTitle: { fontSize: 13, fontWeight: '700' },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 12 },
  reactionBtn: { borderRadius: 14, width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  actionRow: { flexDirection: 'row', gap: 8, marginVertical: 3 },
  actionBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  mediaImage: { width: 210, height: 170, borderRadius: 12, marginBottom: 4 },
  fab: { position: 'absolute', right: 16, bottom: 84, width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
  fabBadge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  fabBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoPlayWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 6, alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  voicePlay: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  docRow: {},
  docIcon: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  mediaModal: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mediaModalClose: { position: 'absolute', top: 48, right: 20, zIndex: 10, padding: 8 },
  mediaModalImg: { width: '100%', height: '80%' },
  mediaModalHint: { position: 'absolute', bottom: 40, flexDirection: 'row', alignItems: 'center' },
});
