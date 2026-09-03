import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, StyleSheet, FlatList, Image,
} from 'react-native';
import { fetchUsers } from '../services/auth';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import ContactsScreen from './ContactsScreen';

export default function HomeScreen({ socket, user, setUser, onLogout, onOpenChat, onOpenSettings }) {
  const { theme } = useTheme();
  const [tab, setTab] = useState('chats');
  const [users, setUsers] = useState([]);
  const [presence, setPresence] = useState({});
  const [conversations, setConversations] = useState([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetchUsers().then((data) => {
      setUsers(data.filter((u) => u.id !== user.id));
    });

    if (socket) {
      socket.on('presence:update', ({ userId, isOnline }) => {
        setPresence((prev) => ({ ...prev, [userId]: { isOnline } }));
      });
      socket.on('message:receive', ({ message, sender, conversationId }) => {
        setConversations((prev) => {
          const mine = prev.filter((c) => c.other.id !== sender.userId);
          return [
            {
              other: { id: sender.userId, display_name: sender.displayName, profile_pic_url: sender.profilePic || '' },
              lastMsg: message.content || '📎 Media',
              time: new Date(message.created_at),
              conversationId,
            },
            ...mine,
          ];
        });
      });

      return () => {
        socket.off('presence:update');
        socket.off('message:receive');
      };
    }
  }, [socket, user.id]);

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
              renderItem={({ item }) => (
                <ConversationRow
                  contact={item}
                  isOnline={presence[item.id]?.isOnline}
                  theme={theme}
                  onPress={() => onOpenChat(item)}
                />
              )}
              contentContainerStyle={styles.list}
            />
          ) : conversations.length > 0 ? (
            <FlatList
              data={[
                ...conversations,
                ...users.filter((u) => !conversations.find((c) => c.other.id === u.id)),
              ]}
              keyExtractor={(item, idx) => `${item.other?.id || item.id}-${idx}`}
              renderItem={({ item }) => (
                <ConversationRow
                  contact={item.other || item}
                  preview={item.lastMsg}
                  isOnline={presence[(item.other || item).id]?.isOnline}
                  theme={theme}
                  onPress={() => onOpenChat(item.other || item)}
                />
              )}
              contentContainerStyle={styles.list}
            />
          ) : (
            <EmptyChats theme={theme} />
          )}
        </View>
      )}

      {tab === 'contacts' && (
        <ContactsScreen users={filtered} presence={presence} onOpenChat={onOpenChat} theme={theme} />
      )}

      <View style={[styles.nav, { backgroundColor: theme.navBg, borderTopColor: theme.border }]}>
        <TabBtn label="Chats" active={tab === 'chats'} onPress={() => setTab('chats')} icon="chatbubbles-outline" theme={theme} activeIcon="chatbubbles" />
        <TabBtn label="Contacts" active={tab === 'contacts'} onPress={() => setTab('contacts')} icon="people-outline" theme={theme} activeIcon="people" />
        <TabBtn label="Settings" active={tab === 'settings'} onPress={() => { onOpenSettings(); }} icon="settings-outline" theme={theme} activeIcon="settings" />
      </View>
    </View>
  );
}

function ConversationRow({ contact, isOnline, onPress, theme, preview }) {
  const initial = contact.display_name ? contact.display_name[0].toUpperCase() : '?';
  return (
    <TouchableOpacity style={[styles.row, { backgroundColor: theme.background }]} onPress={onPress}>
      <View style={styles.avatarWrap}>
        <View style={[styles.avatar, { backgroundColor: contact.id === 1 ? theme.primary : theme.primaryDeep }]}>
          {contact.profile_pic_url ? (
            <Image source={{ uri: contact.profile_pic_url }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{initial}</Text>
          )}
        </View>
        {isOnline && <View style={styles.onlineDot} />}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.rowName, { color: theme.text }]}>{contact.display_name}</Text>
          {preview && <Text style={[styles.rowTime, { color: theme.textSecondary }]}>{fmtTime(preview)}</Text>}
        </View>
        <View style={styles.rowPreviewRow}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.rowPreview, { color: theme.textSecondary }]}>
              {preview ? preview : (isOnline ? 'Online' : 'Tap to say hello')}
            </Text>
          </View>
          <View style={[styles.onlineChip, { backgroundColor: theme.primaryLight }]}>
            <Icon name={isOnline ? 'radio-button-on' : 'radio-button-off'} size={12} color={isOnline ? theme.online : theme.textSecondary} />
            <Text style={{ fontSize: 11, color: isOnline ? theme.online : theme.textSecondary, marginLeft: 3 }}>
              {isOnline ? 'Online' : 'Offline'}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 14 },
  emptySub: { fontSize: 13, marginTop: 8, textAlign: 'center' },
  nav: {
    flexDirection: 'row', borderTopWidth: 1, paddingVertical: 8, paddingBottom: 16,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  tabLabel: { fontSize: 11 },
  tabLabelActive: { fontWeight: '700' },
});
