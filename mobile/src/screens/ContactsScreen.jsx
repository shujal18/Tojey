import React from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Image } from 'react-native';
import { Icon } from '../components/AppIcon';

export default function ContactsScreen({ users, presence, onOpenChat, theme }) {
  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <Text style={[styles.title, { color: theme.text }]}>Contacts</Text>
      </View>
      <FlatList
        data={users}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="people-outline" size={52} color={theme.primaryLight} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>No contacts found</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={[styles.row, { backgroundColor: theme.background }]} onPress={() => onOpenChat(item)}>
            <View style={[styles.avatar, { backgroundColor: item.id === 1 ? theme.primary : theme.primaryDeep }]}>
              {item.profile_pic_url ? (
                <Image source={{ uri: item.profile_pic_url }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarText}>{item.display_name[0].toUpperCase()}</Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: theme.text }]}>{item.display_name}</Text>
              <View style={styles.statusRow}>
                <Icon name={presence[item.id]?.isOnline ? 'radio-button-on' : 'radio-button-off'} size={12}
                  color={presence[item.id]?.isOnline ? theme.online : theme.textSecondary} />
                <Text style={[styles.status, { color: theme.textSecondary }]}>
                  {presence[item.id]?.isOnline ? 'Online' : 'Tap to start a chat'}
                </Text>
              </View>
            </View>
            <Icon name="chevron-forward" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        )}
        contentContainerStyle={{ paddingVertical: 8 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16 },
  title: { fontSize: 24, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center', marginRight: 12, overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  name: { fontSize: 16, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 4 },
  status: { fontSize: 13, marginTop: 1 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: 60 },
  emptyText: { fontSize: 15, marginTop: 12 },
});
