import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { TojeyColors, quickReactions } from '../theme';

export default function ChatRoomScreen({ socket, currentUser, otherUser, onBack }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [reactionMenu, setReactionMenu] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const listRef = useRef(null);
  const recTimer = useRef(null);
  const lastScroll = useRef(0);

  useEffect(() => {
    if (!socket) return;

    socket.emit('conversation:open', { otherUserId: otherUser.id });

    const hHistory = (msgs) => setMessages(msgs);
    const hReceive = ({ message }) => {
      setMessages((prev) => [...prev, { ...message, _local: message.sender_id === currentUser.id }]);
      if (message.sender_id !== currentUser.id) {
        socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
      }
    };
    const hDelivered = ({ messageId }) => updateStatus(messageId, 'DELIVERED');
    const hRead = ({ messageIds }) => {
      setMessages((prev) =>
        prev.map((m) => (messageIds.includes(m.id) ? { ...m, status: 'READ' } : m))
      );
    };
    const hTyping = ({ userId }) => {
      if (userId === otherUser.id) setTyping(true);
    };
    const hTypingStop = ({ userId }) => {
      if (userId === otherUser.id) setTyping(false);
    };
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
    };
  }, [socket, otherUser.id, currentUser.id]);

  function updateStatus(id, status) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
  }

  const sendText = () => {
    if (!text.trim()) return;
    const payload = {
      otherUserId: otherUser.id,
      type: 'TEXT',
      content: text.trim(),
      replyTo: replyingTo?.id || null,
    };
    socket.emit('message:send', payload, (ack) => {
      if (ack?.ok) {
        setMessages((prev) => [...prev, ack.message]);
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
    setRecording(true);
    setRecordTime(0);
    recTimer.current = setInterval(() => setRecordTime((t) => t + 1), 1000);
  };

  const stopRecording = () => {
    clearInterval(recTimer.current);
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
    else if (action === 'edit') { setText(message.content || ''); }
    else if (action === 'deleteMe') {
      socket.emit('message:delete', { messageId: message.id, mode: 'me' });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    } else if (action === 'deleteAll') {
      socket.emit('message:delete', { messageId: message.id, mode: 'everyone' });
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <View style={[styles.avatarSmall, { backgroundColor: otherUser.id === 1 ? TojeyColors.primary : TojeyColors.primaryDeep }]}>
          <Text style={styles.avatarSmallText}>{otherUser.display_name[0].toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerName}>{otherUser.display_name}</Text>
          <Text style={styles.headerStatus}>
            {typing ? 'typing…' : 'online'}
          </Text>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, idx) => String(item.id || `tmp-${idx}`)}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item, index }) => {
          const isSent = item.sender_id === currentUser.id;
          const prev = messages[index - 1];
          const grouped = prev && prev.sender_id === item.sender_id;
          return (
            <MessageRow
              message={item}
              isSent={isSent}
              grouped={grouped}
              themeColors={TojeyColors}
              onLongPress={() => setReactionMenu(item)}
            />
          );
        }}
        contentContainerStyle={styles.messageList}
      />

      {/* Reaction/Action menu */}
      {reactionMenu && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={styles.menuBackdrop} onPress={() => setReactionMenu(null)} />
          <View style={styles.menu}>
            <Text style={styles.menuTitle}>Actions</Text>
            <View style={styles.reactionRow}>
              {quickReactions.map((r) => (
                <TouchableOpacity key={r} onPress={() => reactTo(reactionMenu.id, r)} style={styles.reactionBtn}>
                  <Text style={{ fontSize: 24 }}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Reply" onPress={() => doAction('reply', reactionMenu)} />
              <ActionBtn label="Like" onPress={() => reactTo(reactionMenu.id, '❤️')} />
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Edit" onPress={() => doAction('edit', reactionMenu)} visible={reactionMenu.sender_id === currentUser.id} />
              <ActionBtn label="Copy" onPress={() => { }} />
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Delete for me" onPress={() => doAction('deleteMe', reactionMenu)} danger visible={reactionMenu.sender_id === currentUser.id} />
              <ActionBtn label="Delete for all" onPress={() => doAction('deleteAll', reactionMenu)} danger visible={reactionMenu.sender_id === currentUser.id} />
            </View>
          </View>
        </View>
      )}

      {/* Replying bar */}
      {replyingTo && (
        <View style={styles.replyBar}>
          <View style={styles.replyLine} />
          <View style={{ flex: 1 }}>
            <Text style={styles.replyTitle}>Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUser.display_name}</Text>
            <Text style={styles.replyPreview} numberOfLines={1}>
              {replyingTo.type === 'VOICE' ? '🎤 Voice message' : (replyingTo.content || 'Media message')}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)}>
            <Text style={{ color: TojeyColors.textSecondary }}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Recording UI */}
      {recording && (
        <View style={styles.recBar}>
          <Text style={{ color: TojeyColors.danger }}>●</Text>
          <Text style={{ flex: 1, color: TojeyColors.textLight, marginLeft: 8, fontWeight: '600' }}>
            Recording… 0:{String(recordTime).padStart(2, '0')}
          </Text>
          <TouchableOpacity onPress={stopRecording} style={styles.recStop}>
            <Text style={{ color: '#fff' }}>Send</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Composer */}
      <View style={styles.composer}>
        {recording ? (
          <View style={{ flex: 1, alignItems: 'center' }}>
            <TouchableOpacity onPress={stopRecording} style={styles.micBtnRec}>
              <Text style={styles.micIcon}>■</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.composerRow}>
            <TouchableOpacity style={styles.composerBtn}>
              <Text style={{ fontSize: 18 }}>😊</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.composerBtn}>
              <Text style={{ fontSize: 16 }}>📎</Text>
            </TouchableOpacity>
            <View style={styles.inputWrap}>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Message"
                placeholderTextColor="#9B96A8"
                style={styles.input}
                multiline
              />
            </View>
            <TouchableOpacity style={styles.composerBtn}>
              <Text style={{ fontSize: 18 }}>📷</Text>
            </TouchableOpacity>
            {text.trim() ? (
              <TouchableOpacity style={styles.sendBtn} onPress={sendText}>
                <Text style={styles.sendIcon}>➤</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.micBtn}
                onPressIn={startRecording}
                onPressOut={stopRecording}
              >
                <Text style={styles.micIcon}>🎤</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function ActionBtn({ label, onPress, danger, visible = true }) {
  if (!visible) return null;
  return (
    <TouchableOpacity onPress={onPress} style={styles.actionBtn}>
      <Text style={{ color: danger ? TojeyColors.danger : TojeyColors.primary, fontWeight: '600', fontSize: 13 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function MessageRow({ message, isSent, grouped, themeColors, onLongPress }) {
  return (
    <View style={[styles.msgRow, { justifyContent: isSent ? 'flex-end' : 'flex-start' }]}>
      <TouchableOpacity
        style={[
          styles.bubble,
          isSent ? styles.sentBubble : styles.recvBubble,
          grouped && { borderBottomRightRadius: isSent ? 6 : 14, borderBottomLeftRadius: isSent ? 14 : 6 },
        ]}
        onLongPress={onLongPress}
        delayLongPress={350}
      >
        {message.is_deleted_for_everyone ? (
          <Text style={{ fontStyle: 'italic', opacity: 0.7, color: isSent ? '#fff' : themeColors.textSecondary }}>
            This message was deleted
          </Text>
        ) : message.type === 'VOICE' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 160 }}>
            <Text style={{ fontSize: 18, marginRight: 8, color: isSent ? '#fff' : themeColors.primary }}>▶</Text>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', gap: 2 }}>
                {[4, 8, 12, 6, 14, 10, 7, 12, 6, 9].map((h, i) => (
                  <View key={i} style={{ width: 3, height: h, backgroundColor: isSent ? '#fff' : themeColors.primary, borderRadius: 2 }} />
                ))}
              </View>
              <Text style={{ marginTop: 4, fontSize: 10, color: isSent ? 'rgba(255,255,255,0.8)' : themeColors.textSecondary }}>
                0:{String(message.duration || 26).padStart(2, '0')} · 1×
              </Text>
            </View>
          </View>
        ) : (
          <View>
            {message.reply_to ? (
              <View style={[styles.replyRef, isSent && { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
                <Text style={{ fontWeight: '700', fontSize: 11, color: isSent ? '#fff' : themeColors.primary }}>Reply</Text>
                <Text numberOfLines={1} style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : themeColors.textSecondary }}>preview…</Text>
              </View>
            ) : null}
            <Text style={{ fontSize: 15, color: isSent ? '#fff' : themeColors.textLight }}>{message.content}</Text>
          </View>
        )}

        {!message.is_deleted_for_everyone && (
          <View style={styles.msgMeta}>
            {message.is_view_once && <Text style={{ fontSize: 10, color: isSent ? '#fff' : themeColors.textSecondary }}>🔒</Text>}
            {message.is_edited && <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.7)' }]}>edited</Text>}
            <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.75)' }]}>
              {message.created_at ? timeOf(message.created_at) : ''}
            </Text>
            {isSent && (message.status === 'READ'
              ? <Text style={{ fontSize: 11, color: '#A5D6FF' }}>✓✓</Text>
              : message.status === 'DELIVERED'
                ? <Text style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : themeColors.textSecondary }}>✓✓</Text>
                : <Text style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : themeColors.textSecondary }}>✓</Text>)}
          </View>
        )}
      </TouchableOpacity>

      {message.reactions && message.reactions.length > 0 && (
        <View style={[styles.reactionBadge, isSent ? { alignSelf: 'flex-end' } : { alignSelf: 'flex-start' }]}>
          {message.reactions.map((r, i) => (
            <Text key={i} style={{ fontSize: 11 }}>{r.reaction}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

function timeOf(t) {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8F7FC' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: TojeyColors.border,
  },
  backBtn: { marginRight: 8 },
  backIcon: { fontSize: 34, color: TojeyColors.primaryDeep, lineHeight: 34 },
  avatarSmall: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  avatarSmallText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  headerName: { fontSize: 16, fontWeight: '700', color: TojeyColors.textLight },
  headerStatus: { fontSize: 12, color: TojeyColors.primary },
  messageList: { padding: 14, paddingBottom: 20 },
  msgRow: { flexDirection: 'row', marginVertical: 3 },
  bubble: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14 },
  sentBubble: { backgroundColor: TojeyColors.primary, borderBottomRightRadius: 4 },
  recvBubble: { backgroundColor: '#FFFFFF', borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#F0EDF8' },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 3 },
  metaText: { fontSize: 10, color: '#9B96A8' },
  replyRef: {
    backgroundColor: TojeyColors.primaryLight,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    marginBottom: 4,
    marginLeft: -2,
    borderLeftWidth: 3,
    borderLeftColor: TojeyColors.primary,
  },
  reactionBadge: {
    backgroundColor: TojeyColors.primaryLight,
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: -6,
    marginHorizontal: 8,
  },
  composer: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: TojeyColors.border,
    padding: 10,
    paddingBottom: Platform.OS === 'ios' ? 20 : 12,
  },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  composerBtn: { padding: 4 },
  inputWrap: {
    flex: 1,
    backgroundColor: '#F0EDF8',
    borderRadius: 22,
    paddingHorizontal: 12,
    maxHeight: 100,
  },
  input: { fontSize: 14, color: TojeyColors.textLight, paddingVertical: 8, maxHeight: 100 },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: TojeyColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendIcon: { color: '#fff', fontSize: 18 },
  micBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: TojeyColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micIcon: { fontSize: 18 },
  micBtnRec: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: TojeyColors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: TojeyColors.border,
  },
  recStop: {
    backgroundColor: TojeyColors.primary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: TojeyColors.border,
  },
  replyLine: { width: 3, height: 32, backgroundColor: TojeyColors.primary, borderRadius: 2, marginRight: 10 },
  replyTitle: { fontWeight: '700', fontSize: 12, color: TojeyColors.primary },
  replyPreview: { fontSize: 12, color: TojeyColors.textSecondary },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  menu: {
    position: 'absolute',
    bottom: 90,
    left: 24,
    right: 24,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 8,
  },
  menuTitle: { fontSize: 13, color: TojeyColors.textSecondary, fontWeight: '700' },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 12 },
  reactionBtn: {
    backgroundColor: TojeyColors.primaryLight,
    borderRadius: 14,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRow: { flexDirection: 'row', gap: 8, marginVertical: 3 },
  actionBtn: {
    flex: 1,
    backgroundColor: TojeyColors.primaryLight,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
});
