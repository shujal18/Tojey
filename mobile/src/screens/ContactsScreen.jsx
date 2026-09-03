import React from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { TojeyColors } from '../theme';

export default function ContactsScreen({ users, presence, onOpenChat }) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Contacts</Text>
      </View>
      <FlatList
        data={users}
        keyExtractor={(item) => String(item.id)}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => onOpenChat(item)}>
            <View style={[styles.avatar, { backgroundColor: item.id === 1 ? TojeyColors.primary : TojeyColors.primaryDeep }]}>
              <Text style={styles.avatarText}>{item.display_name[0].toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.display_name}</Text>
              <Text style={styles.status}>
                {presence[item.id]?.isOnline ? '● online' : 'tap to say hello'}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        contentContainerStyle={{ paddingVertical: 8 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: TojeyColors.backgroundLight },
  header: { padding: 16 },
  title: { fontSize: 24, fontWeight: '800', color: TojeyColors.primaryDeep },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  name: { fontSize: 16, fontWeight: '600', color: TojeyColors.textLight },
  status: { fontSize: 13, color: TojeyColors.textSecondary, marginTop: 2 },
});
