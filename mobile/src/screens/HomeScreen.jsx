import React, { useEffect, useState, memo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, StyleSheet, FlatList, Image, Modal, Platform,
} from 'react-native';
import { fetchUsers } from '../services/auth';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { absUrl } from '../config';
import ContactsScreen from './ContactsScreen';

export default function HomeScreen({ socket, user, setUser, onLogout, onOpenChat, onOpenSettings, activeChatId }) {
  const { theme } = useTheme();
  const [tab, setTab] = useState('chats');
  const [users, setUsers] = useState([]);
  const [presence, setPresence] = useState({});
  const [conversations, setConversations] = useState([]);
  const [unread, setUnread] = useState({});
  const [query, setQuery] = useState('');
  const [clearTarget, setClearTarget] = useState(null);

  useEffect(() => {
    fetchUsers().then((data) => {
      setUsers(data.filter((u) => u.id !== user.id));
    });

    if (socket) {
      const refreshList = () => socket.emit('conversation:list');
      const hList = (list) => {
        setConversations(list.map((c) => ({
          conversationId: c.conversationId,
          other: c.other,
          lastMsg: c.lastMessage ? { content: c.lastMessage.content, type: c.lastMessage.type, time: new Date(c.lastMessage.created_at) } : null,
        })));
        setPresence((prev) => {
          const next = { ...prev };
          list.forEach((c) => {
            if (c.other) {
              next[c.other.id] = { isOnline: c.other.isOnline, lastSeen: c.other.last_seen };
            }
          });
          return next;
        });
      };
      socket.on('conversation:list', hList);
      socket.on('presence:update', ({ userId, isOnline, lastSeen }) => {
        setPresence((prev) => ({ ...prev, [userId]: { isOnline, lastSeen } }));
        refreshList();
      });
      socket.on('message:receive', ({ message, sender, conversationId }) => {
        setConversations((prev) => {
          const mine = prev.filter((c) => c.other.id !== sender.userId);
          return [
            {
              conversationId,
              other: { id: sender.userId, display_name: sender.displayName, profile_pic_url: sender.profilePic || '' },
              lastMsg: { content: message.content || '📎 Media', type: message.type, time: new Date(message.created_at) },
            },
            ...mine,
          ];
        });
        if (sender.userId !== activeChatId) {
          setUnread((u) => ({ ...u, [sender.userId]: (u[sender.userId] || 0) + 1 }));
        }
      });
      socket.on('conversation:cleared', ({ conversationId }) => {
        setConversations((prev) => prev.map((c) =>
          c.conversationId === conversationId ? { ...c, lastMsg: null } : c
        ));
      });

      refreshList();

      return () => {
        socket.off('conversation:list', hList);
        socket.off('presence:update');
        socket.off('message:receive');
        socket.off('conversation:cleared');
      };
    }
  }, [socket, user.id]);

  const clearChat = (contact) => {
    if (socket) socket.emit('conversation:clear', { otherUserId: contact.id });
    setConversations((prev) => prev.map((c) => (c.other.id === contact.id ? { ...c, lastMsg: null } : c)) || []);
    setClearTarget(null);
  };

  const openChat = (contact) => {
    setUnread((u) => { const n = { ...u }; delete n[contact.id]; return n; });
    // Ensure contact has all required properties for ChatRoomScreen
    const normalizedContact = {
      id: contact.id,
      username: contact.username,
      display_name: contact.display_name,
      profile_pic_url: contact.profile_pic_url || '',
      online: contact.online ?? contact.is_online ?? false,
      last_seen: contact.last_seen ?? contact.lastSeen ?? null,
      bio: contact.bio || '',
    };
    onOpenChat(normalizedContact);
  };

  const filtered = users.filter(
    (u) => !query || u.display_name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {tab === 'chats' && (
        <View style={styles.screenWrap}>
          <View style={[styles.header, { backgroundColor: theme.background }]}>
            <Text style={[styles.title, { color: theme.primaryDeep }]}>Tojey</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <TouchableOpacity onPress={onOpenSettings} style={styles.headerBtn}>
                <Icon name="settings-outline" size={22} color={theme.primary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={onLogout} style={[styles.headerBtn, { marginLeft: 4 }]}>
                <Icon name="log-out-outline" size={22} color={theme.danger} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.searchBox, { backgroundColor: theme.inputBg }]}>
            <Icon name="search-outline" size={18} color={theme.textSecondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search conversations"
              placeholderTextColor={theme.textSecondary}
              style={[styles.searchInput, { color: theme.text }]}
            />
          </View>

          {conversations.length === 0 && users.length > 0 ? (
            <FlatList
              data={users}
              keyExtractor={(item) => String(item.id)}
              initialNumToRender={15}
              maxToRenderPerBatch={10}
              windowSize={11}
              removeClippedSubviews={Platform.OS === 'android'}
              renderItem={({ item }) => {
                const contact = {
                  id: item.id,
                  username: item.username,
                  display_name: item.display_name,
                  profile_pic_url: item.profile_pic_url || '',
                  online: presence[item.id]?.isOnline ?? item.is_online ?? false,
                  last_seen: presence[item.id]?.lastSeen ?? item.last_seen ?? null,
                  bio: item.bio || '',
                };
                return (
                  <ConversationRow
                    contact={contact}
                    isOnline={contact.online}
                    lastSeen={contact.last_seen}
                    unread={unread[item.id]}
                    theme={theme}
                    onPress={() => openChat(contact)}
                    onLongPress={() => setClearTarget(contact)}
                  />
                );
              }}
              contentContainerStyle={styles.list}
            />
          ) : conversations.length > 0 ? (
            <FlatList
              data={[
                ...conversations,
                ...users.filter((u) => !conversations.find((c) => c.other.id === u.id)),
              ]}
              keyExtractor={(item, idx) => `${item.other?.id || item.id}-${idx}`}
              initialNumToRender={15}
              maxToRenderPerBatch={10}
              windowSize={11}
              removeClippedSubviews={Platform.OS === 'android'}
              renderItem={({ item }) => {
                const contact = item.other || item;
                const normalizedContact = {
                  id: contact.id,
                  username: contact.username,
                  display_name: contact.display_name,
                  profile_pic_url: contact.profile_pic_url || '',
                  online: presence[contact.id]?.isOnline ?? contact.online ?? contact.is_online ?? false,
                  last_seen: presence[contact.id]?.lastSeen ?? contact.last_seen ?? contact.lastSeen ?? null,
                  bio: contact.bio || '',
                };
                return (
                  <ConversationRow
                    contact={normalizedContact}
                    preview={item.lastMsg}
                    isOnline={normalizedContact.online}
                    lastSeen={normalizedContact.last_seen}
                    unread={unread[normalizedContact.id]}
                    theme={theme}
                    onPress={() => openChat(normalizedContact)}
                    onLongPress={() => setClearTarget(normalizedContact)}
                  />
                );
              }}
              contentContainerStyle={styles.list}
            />
          ) : (
            <EmptyChats theme={theme} />
          )}
        </View>
      )}

      {tab === 'contacts' && (
        <ContactsScreen users={filtered} presence={presence} onOpenChat={openChat} theme={theme} />
      )}

      {/* Clear chat confirmation */}
      <Modal transparent visible={!!clearTarget} animationType="fade" onRequestClose={() => setClearTarget(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Clear chat with {clearTarget?.display_name}?</Text>
            <Text style={[styles.modalSub, { color: theme.textSecondary }]}>
              This will delete this conversation for both users, on all devices and from the server.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setClearTarget(null)} style={[styles.modalBtn, { backgroundColor: theme.inputBg }]}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => clearChat(clearTarget)} style={[styles.modalBtn, { backgroundColor: theme.danger }]}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Clear</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <View style={[styles.nav, { backgroundColor: theme.navBg, borderTopColor: theme.border }]}>
        <TabBtn label="Chats" active={tab === 'chats'} onPress={() => setTab('chats')} icon="chatbubbles-outline" theme={theme} activeIcon="chatbubbles" />
        <TabBtn label="Contacts" active={tab === 'contacts'} onPress={() => setTab('contacts')} icon="people-outline" theme={theme} activeIcon="people" />
        <TabBtn label="Settings" active={tab === 'settings'} onPress={() => { onOpenSettings(); }} icon="settings-outline" theme={theme} activeIcon="settings" />
      </View>
    </View>
  );
}

function ConversationRowFn({ contact, isOnline, lastSeen, onPress, onLongPress, theme, preview, unread }) {
  const initial = contact.display_name ? contact.display_name[0].toUpperCase() : '?';
  const lastMsg = preview && preview.content ? preview.content : (preview && preview.type ? '📎 Media' : '');
  return (
    <TouchableOpacity style={[styles.row, { backgroundColor: theme.background }]} onPress={onPress} onLongPress={onLongPress} delayLongPress={400}>
      <View style={styles.avatarWrap}>
        <View style={[styles.avatar, { backgroundColor: contact.id === 1 ? theme.primary : theme.primaryDeep }]}>
          {contact.profile_pic_url ? (
            <Image source={{ uri: absUrl(contact.profile_pic_url) }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{initial}</Text>
          )}
        </View>
        {isOnline && <View style={styles.onlineDot} />}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowName, { color: theme.text }]}>{contact.display_name}</Text>
          {preview?.time && <Text style={[styles.rowTime, { color: theme.textSecondary }]}>{fmtTime(preview.time)}</Text>}
        </View>
        <View style={styles.rowPreviewRow}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.rowPreview, { color: theme.textSecondary }]}>
              {lastMsg || (isOnline ? 'Online' : 'Tap to say hello')}
            </Text>
          </View>
          {!!unread && (
            <View style={[styles.unreadBadge, { backgroundColor: theme.primary }]}>
              <Text style={styles.unreadBadgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
          <View style={[styles.onlineChip, { backgroundColor: theme.primaryLight }]}>
            <Icon name={isOnline ? 'radio-button-on' : 'radio-button-off'} size={12} color={isOnline ? theme.online : theme.textSecondary} />
            <Text style={{ fontSize: 11, color: isOnline ? theme.online : theme.textSecondary, marginLeft: 3 }}>
              {isOnline ? 'Online' : presenceText(lastSeen)}
            </Text>
</View>
      </View>
      </View>
    </TouchableOpacity>
  );
}

const ConversationRow = memo(ConversationRowFn);

function presenceText(lastSeen) {
  if (!lastSeen) return 'Offline';
  const d = new Date(lastSeen);
  if (isNaN(d.getTime())) return 'Offline';
  const now = new Date();
  const mins = Math.floor((now - d) / 60000);
  if (mins < 1) return 'Active now';
  if (mins < 60) return `last seen ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h`;
  return `last seen ${d.getDate()}/${d.getMonth() + 1}`;
}

function EmptyChats({ theme }) {
  return (
    <View style={[styles.empty, { backgroundColor: theme.background }]}>
      <Icon name="chatbubbles-outline" size={60} color={theme.primarySoft || theme.primaryLight} />
      <Text style={[styles.emptyTitle, { color: theme.text }]}>Start a conversation</Text>
      <Text style={[styles.emptySub, { color: theme.textSecondary }]}>
        Tap a contact to send a private message.
      </Text>
    </View>
  );
}

function TabBtn({ label, active, onPress, icon, activeIcon, theme }) {
  return (
    <TouchableOpacity style={styles.tab} onPress={onPress}>
      <Icon name={active ? activeIcon : icon} size={22} color={active ? theme.primary : theme.textSecondary} />
      <Text style={[styles.tabLabel, { color: active ? theme.primary : theme.textSecondary }, active && styles.tabLabelActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function fmtTime(d) {
  const now = new Date();
  const diff = (now - d) / 1000 / 60;
  if (diff < 1) return 'now';
  if (diff < 60) return `${Math.floor(diff)}m`;
  if (diff < 1440) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenWrap: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
  },
  title: { fontSize: 26, fontWeight: '800' },
  headerBtn: { padding: 6 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9,
  },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  list: { paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  avatarWrap: { position: 'relative', marginRight: 12 },
  avatar: {
    width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  onlineDot: {
    position: 'absolute', bottom: 0, right: 0, width: 13, height: 13, borderRadius: 7,
    backgroundColor: '#7C4DFF', borderWidth: 2, borderColor: '#F8F7FC',
  },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowName: { fontSize: 16, fontWeight: '600' },
  rowTime: { fontSize: 12 },
  rowPreviewRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 8 },
  rowPreview: { fontSize: 13 },
  onlineChip: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  unreadBadge: { minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 14 },
  emptySub: { fontSize: 13, marginTop: 8, textAlign: 'center' },
  nav: {
    flexDirection: 'row', borderTopWidth: 1, paddingVertical: 8, paddingBottom: 16,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabLabel: { fontSize: 11 },
  tabLabelActive: { fontWeight: '700' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { borderRadius: 16, padding: 22, width: '100%', maxWidth: 340 },
  modalTitle: { fontSize: 17, fontWeight: '700' },
  modalSub: { fontSize: 13, marginTop: 8, lineHeight: 19 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 20 },
  modalBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
});
