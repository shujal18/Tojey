import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Switch, ScrollView, StyleSheet, Image, TextInput,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { SERVER_URL, absUrl } from '../config';

export default function SettingsScreen({ user, token, onBack, onLogout, setUser }) {
  const { theme, mode, setMode } = useTheme();
  const [readReceipts, setReadReceipts] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [sound, setSound] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [saving, setSaving] = useState(false);

  const profilePic = user.profilePic || '';

  const pickAndUpload = async () => {
    launchImageLibrary(
      { mediaType: 'photo', quality: 0.7, selectionLimit: 1, includeBase64: false },
      async (res) => {
        if (res.didCancel || res.errorCode || !res.assets || !res.assets[0]) return;
        const asset = res.assets[0];
        if (!asset.uri) return;
        try {
          setSaving(true);
          const fd = new FormData();
          fd.append('file', {
            uri: asset.uri,
            name: asset.fileName || 'profile.jpg',
            type: asset.type || 'image/jpeg',
          });
          const up = await fetch(`${SERVER_URL}/api/upload`, { method: 'POST', body: fd });
          const upData = await up.json();
          if (!upData.url) throw new Error(upData.error || 'Upload failed');
          const absolute = upData.url.startsWith('http') ? upData.url : `${SERVER_URL}${upData.url}`;
          const pRes = await fetch(`${SERVER_URL}/api/profile`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ profilePic: absolute }),
          });
          const data = await pRes.json();
          if (data.user) {
            setUser(data.user);
            await AsyncStorage.setItem('@tojey_user', JSON.stringify(data.user));
          }
        } catch (e) {
          alert('Could not update profile picture: ' + e.message);
        } finally {
          setSaving(false);
        }
      }
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.background }}>
      <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="chevron-back" size={26} color={theme.primary} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Settings</Text>
      </View>

      {/* Profile card */}
      <View style={[styles.profileCard, { backgroundColor: theme.card }]}>
        <TouchableOpacity onPress={pickAndUpload} style={styles.avatarWrap} disabled={saving}>
          <View style={[styles.avatarBig, { backgroundColor: theme.primary }]}>
            {profilePic ? (
              <Image source={{ uri: absUrl(profilePic) }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>{user.displayName[0].toUpperCase()}</Text>
            )}
          </View>
          <View style={[styles.cameraBadge, { backgroundColor: theme.primaryDeep }]}>
            <Icon name="camera" size={14} color="#fff" />
          </View>
        </TouchableOpacity>
        <View style={{ alignItems: 'center', marginTop: 10 }}>
          <Text style={[styles.profileName, { color: theme.text }]}>{user.displayName}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 2 }}>
            @{user.username} · online
          </Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 6, textAlign: 'center' }}>
            {user.bio || 'Tap the camera icon above to set your profile picture'}
          </Text>
        </View>
      </View>

      <Section title="Appearance" theme={theme}>
        <View style={[styles.themeRow, { borderBottomColor: theme.border }]}>
          {[
            { key: 'light', label: 'Light', icon: 'sunny-outline' },
            { key: 'dark', label: 'Dark', icon: 'moon-outline' },
          ].map((o) => (
            <TouchableOpacity
              key={o.key}
              onPress={() => setMode(o.key)}
              style={[
                styles.themeBtn,
                { backgroundColor: mode === o.key ? theme.primary : theme.inputBg },
              ]}
            >
              <Icon name={o.icon} size={16} color={mode === o.key ? '#fff' : theme.textSecondary} />
              <Text style={{ color: mode === o.key ? '#fff' : theme.textSecondary, fontSize: 12, fontWeight: '600' }}>
                {o.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Section>

      <Section title="Privacy" theme={theme}>
        <SettingRow label="Read receipts" icon="eye-outline" theme={theme}>
          <Switch value={readReceipts} onValueChange={setReadReceipts} trackColor={{ true: theme.primary }} />
        </SettingRow>
      </Section>

      <Section title="Notifications" theme={theme}>
        <SettingRow label="Message notifications" icon="notifications-outline" theme={theme}>
          <Switch value={notifications} onValueChange={setNotifications} trackColor={{ true: theme.primary }} />
        </SettingRow>
        <SettingRow label="Sound" icon="volume-high-outline" theme={theme}>
          <Switch value={sound} onValueChange={setSound} trackColor={{ true: theme.primary }} />
        </SettingRow>
        <SettingRow label="Vibration" icon="vibrate-outline" theme={theme}>
          <Switch value={vibration} onValueChange={setVibration} trackColor={{ true: theme.primary }} />
        </SettingRow>
      </Section>

      <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
        <Icon name="log-out-outline" size={18} color={theme.danger} />
        <Text style={[styles.logoutText, { color: theme.danger }]}>Log Out</Text>
      </TouchableOpacity>

      <Text style={[styles.footer, { color: theme.textSecondary }]}>Tojey · Private Chat · v1.1.0</Text>
    </ScrollView>
  );
}

function Section({ title, theme, children }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[styles.sectionTitle, { color: theme.primary }]}>{title}</Text>
      <View style={[styles.sectionCard, { backgroundColor: theme.card }]}>{children}</View>
    </View>
  );
}

function SettingRow({ label, icon, theme, children }) {
  return (
    <View style={[styles.row, { borderBottomColor: theme.border }]}>
      <Icon name={icon} size={20} color={theme.primary} style={{ marginRight: 12 }} />
      <Text style={[styles.rowLabel, { color: theme.text }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backBtn: { marginRight: 8, padding: 4 },
  title: { fontSize: 20, fontWeight: '700' },
  profileCard: {
    alignItems: 'center',
    margin: 16,
    borderRadius: 16,
    padding: 20,
  },
  avatarWrap: { position: 'relative' },
  avatarBig: {
    width: 86, height: 86, borderRadius: 43,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarText: { color: '#fff', fontSize: 32, fontWeight: '700' },
  cameraBadge: {
    position: 'absolute', right: 0, bottom: 0, width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  profileName: { fontSize: 19, fontWeight: '700' },
  sectionTitle: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13, fontWeight: '700' },
  sectionCard: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1,
  },
  rowLabel: { flex: 1, fontSize: 14 },
  themeRow: { flexDirection: 'row', gap: 8, padding: 14, borderBottomWidth: 1 },
  themeBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 12,
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  logoutBtn: {
    backgroundColor: 'rgba(229,57,53,0.1)', marginHorizontal: 16, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
    marginTop: 8,
  },
  logoutText: { fontSize: 15, fontWeight: '700' },
  footer: { textAlign: 'center', fontSize: 13, paddingVertical: 30 },
});
