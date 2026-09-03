import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  FlatList,
} from 'react-native';
import { fetchUsers } from '../services/auth';
import { TojeyColors } from '../theme';
import ContactsScreen from './ContactsScreen';
import SettingsScreen from './SettingsScreen';

export default function HomeScreen({ socket, user, onLogout, onOpenChat }) {
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
        // update conversations list preview
        setConversations((prev) => {
          const mine = prev.filter((c) => c.other.id !== sender.userId);
          return [
            { other: { id: sender.userId, display_name: sender.displayName }, lastMsg: message.content || '📎 Media', time: new Date(message.created_at), conversationId },
            ...mine,
          ];
        });
      });
      socket.on('connected:ack', ({ userId: myId, displayName }) => {
        // ensure we tell the server we're online (handled server-side on connect)
      });

      return () => {
        socket.off('presence:update');
        socket.off('message:receive');
        socket.off('connected:ack');
      };
    }
  }, [socket, user.id]);

  const filtered = users.filter(
    (u) => !query || u.display_name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <View style={styles.container}>
      {tab === 'chats' && (
        <View style={styles.screenWrap}>
          <View style={styles.header}>
            <Text style={styles.title}>Tojey</Text>
            <TouchableOpacity onPress={onLogout} style={styles.logoutBtn}>
              <Text style={styles.logoutText}>Logout</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.searchBox}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search conversations..."
              placeholderTextColor="#9B96A8"
              style={styles.searchInput}
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
                  isOnline={presence[(item.other || item).id]?.isOnline}
                  onPress={() => onOpenChat(item.other || item)}
                />
              )}
              contentContainerStyle={styles.list}
            />
          ) : (
            <EmptyChats />
          )}
        </View>
      )}

      {tab === 'contacts' && <ContactsScreen users={filtered} presence={presence} onOpenChat={onOpenChat} />}
      {tab === 'settings' && <SettingsScreen user={user} onLogout={onLogout} />}

      <View style={styles.nav}>
        <TabBtn label="Chats" active={tab === 'chats'} onPress={() => setTab('chats')} icon="💬" />
        <TabBtn label="Contacts" active={tab === 'contacts'} onPress={() => setTab('contacts')} icon="👥" />
        <TabBtn label="Settings" active={tab === 'settings'} onPress={() => setTab('settings')} icon="⚙️" />
      </View>
    </View>
  );
}

function ConversationRow({ contact, isOnline, onPress }) {
  const initial = contact.display_name ? contact.display_name[0].toUpperCase() : '?';
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={styles.avatarWrap}>
        <View style={[styles.avatar, { backgroundColor: contact.id === 1 ? TojeyColors.primary : TojeyColors.primaryDeep }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        {isOnline && <View style={styles.onlineDot} />}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.rowName}>{contact.display_name}</Text>
          <Text style={styles.rowTime}>now</Text>
        </View>
        <Text style={styles.rowPreview}>{isOnline ? '● online' : 'Say hello 👋'}</Text>
      </View>
    </TouchableOpacity>
  );
}

function EmptyChats() {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>💬</Text>
      <Text style={styles.emptyTitle}>Start a conversation</Text>
      <Text style={styles.emptySub}>Message the people who matter to you.</Text>
    </View>
  );
}

function TabBtn({ label, active, onPress, icon }) {
  return (
    <TouchableOpacity style={styles.tab} onPress={onPress}>
      <Text style={{ fontSize: 20 }}>{icon}</Text>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: TojeyColors.backgroundLight },
  screenWrap: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: { fontSize: 26, fontWeight: '800', color: TojeyColors.primaryDeep },
  logoutBtn: { padding: 6 },
  logoutText: { color: TojeyColors.danger, fontSize: 14, fontWeight: '600' },
  searchBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#F0EDF8',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: { fontSize: 14, color: TojeyColors.textLight, padding: 0 },
  list: { paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  avatarWrap: { position: 'relative', marginRight: 12 },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: TojeyColors.online,
    borderWidth: 2,
    borderColor: TojeyColors.backgroundLight,
  },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between' },
  rowName: { fontSize: 16, fontWeight: '600', color: TojeyColors.textLight },
  rowTime: { fontSize: 12, color: TojeyColors.textSecondary },
  rowPreview: { fontSize: 13, color: TojeyColors.textSecondary, marginTop: 3 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: TojeyColors.textLight },
  emptySub: { fontSize: 13, color: TojeyColors.textSecondary, marginTop: 8, textAlign: 'center' },
  nav: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: TojeyColors.border,
    paddingVertical: 8,
    paddingBottom: 16,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2 },
  tabLabel: { fontSize: 11, color: TojeyColors.textSecondary },
  tabLabelActive: { color: TojeyColors.primary, fontWeight: '700' },
});
