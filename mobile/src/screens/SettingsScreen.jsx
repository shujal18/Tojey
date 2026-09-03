import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Switch, ScrollView, StyleSheet } from 'react-native';
import { TojeyColors } from '../theme';

export default function SettingsScreen({ user, onLogout }) {
  const [readReceipts, setReadReceipts] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [sound, setSound] = useState(true);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{user.displayName[0].toUpperCase()}</Text>
        </View>
        <View>
          <Text style={styles.profileName}>{user.displayName}</Text>
          <Text style={styles.profileSub}>@{user.username} · online</Text>
        </View>
      </View>

      <Section title="Privacy">
        <SettingRow label="Read Receipts">
          <Switch value={readReceipts} onValueChange={setReadReceipts} trackColor={{ true: TojeyColors.primary }} />
        </SettingRow>
      </Section>

      <Section title="Notifications">
        <SettingRow label="Message Notifications">
          <Switch value={notifications} onValueChange={setNotifications} trackColor={{ true: TojeyColors.primary }} />
        </SettingRow>
        <SettingRow label="Sound">
          <Switch value={sound} onValueChange={setSound} trackColor={{ true: TojeyColors.primary }} />
        </SettingRow>
      </Section>

      <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>

      <Text style={styles.footer}>Tojey · Private Chat · v1.0.0</Text>
    </ScrollView>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function SettingRow({ label, children }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: TojeyColors.backgroundLight },
  header: { padding: 16 },
  title: { fontSize: 24, fontWeight: '800', color: TojeyColors.primaryDeep },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 16,
    marginBottom: 8,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: TojeyColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  avatarText: { color: '#fff', fontSize: 24, fontWeight: '700' },
  profileName: { fontSize: 18, fontWeight: '700', color: TojeyColors.textLight },
  profileSub: { fontSize: 13, color: TojeyColors.textSecondary, marginTop: 2 },
  section: { marginBottom: 12 },
  sectionTitle: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 13,
    fontWeight: '700',
    color: TojeyColors.primary,
  },
  sectionCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    borderRadius: 16,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: TojeyColors.border,
  },
  rowLabel: { fontSize: 14, color: TojeyColors.textLight },
  logoutBtn: {
    backgroundColor: 'rgba(229,57,53,0.1)',
    marginHorizontal: 16,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  logoutText: { color: TojeyColors.danger, fontSize: 15, fontWeight: '700' },
  footer: {
    textAlign: 'center',
    color: TojeyColors.textSecondary,
    fontSize: 13,
    paddingVertical: 30,
  },
});
