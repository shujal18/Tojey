import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, Switch, ScrollView, StyleSheet, Image, TextInput,
  Platform,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { SERVER_URL, absUrl } from '../config';
import { ensureMediaPermission } from '../services/permissions';
import RNFetchBlob from 'rn-fetch-blob';

export default function SettingsScreen({ user, token, onBack, onLogout, setUser, appLockEnabled, appLockPIN, onAppLockChange }) {
  const { theme, mode, setMode } = useTheme();
  const [readReceipts, setReadReceipts] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [sound, setSound] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [saving, setSaving] = useState(false);
  const [appLockPINEntry, setAppLockPINEntry] = useState('');
  const [confirmingPIN, setConfirmingPIN] = useState(false);

  const profilePic = user.profilePic || '';

  const pickAndUpload = async () => {
    try {
      const hasPermission = await ensureMediaPermission();
      if (!hasPermission) {
        alert('Media permission is required to select a profile picture. Please enable it in Settings.');
        return;
      }
    } catch (e) {
      console.warn('Permission check failed:', e);
    }
    launchImageLibrary(
      { mediaType: 'photo', quality: 0.7, selectionLimit: 1, includeBase64: false },
      async (res) => {
        if (res.didCancel) {
          console.log('User cancelled image picker');
          return;
        }
        if (res.errorCode) {
          console.error('Image picker error:', res.errorCode, res.errorMessage);
          alert('Failed to open image picker: ' + (res.errorMessage || 'Unknown error'));
          return;
        }
        if (!res.assets || !res.assets[0]) {
          console.warn('No assets returned from image picker');
          return;
        }
        const asset = res.assets[0];
        if (!asset.uri) {
          console.warn('Asset has no URI');
          return;
        }
        try {
          setSaving(true);
          const mimeType = asset.type || 'image/jpeg';
          const fileName = asset.fileName || `profile_${Date.now()}.jpg`;
          
          // Use RNFetchBlob for reliable file upload on Android (handles content:// URIs)
          const uploadRes = await RNFetchBlob.fetch('POST', `${SERVER_URL}/api/upload`, {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'multipart/form-data',
          }, [
            { name: 'file', filename: fileName, type: mimeType, data: RNFetchBlob.wrap(asset.uri) },
          ]);
          
          const upData = JSON.parse(uploadRes.data);
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
            alert('Profile picture updated successfully!');
          }
        } catch (e) {
          console.error('Profile picture upload failed:', e);
          alert('Could not update profile picture: ' + e.message);
        } finally {
          setSaving(false);
        }
      }
    );
  };

  const handleAppLockToggle = async (enabled) => {
    if (enabled && !appLockPIN) {
      setConfirmingPIN(true);
      return;
    }
    if (!enabled) {
      await onAppLockChange(false, '');
      return;
    }
    if (enabled && appLockPIN) {
      await onAppLockChange(true, appLockPIN);
    }
  };

  const handlePINConfirm = async () => {
    if (appLockPINEntry.length !== 4) {
      alert('PIN must be 4 digits');
      return;
    }
    if (confirmingPIN) {
      await onAppLockChange(true, appLockPINEntry);
      setConfirmingPIN(false);
      setAppLockPINEntry('');
    } else {
      setConfirmingPIN(true);
      setAppLockPINEntry('');
    }
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
      <View style={styles.profileWrap}>
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
          <View style={{ alignItems: 'center', marginTop: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.profileName, { color: theme.text }]}>{user.displayName}</Text>
              <View style={[styles.onlineDot, { backgroundColor: theme.online }]} />
            </View>
            <View style={styles.userHandle}>
              <Text style={{ color: theme.online, fontSize: 13, fontWeight: '600' }}>online</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}> · @{user.username}</Text>
            </View>
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 8, textAlign: 'center' }}>
              {user.bio || 'Tap the camera icon above to set your profile picture'}
            </Text>
          </View>

          <TouchableOpacity onPress={pickAndUpload} disabled={saving} style={[styles.changePicBtn, { backgroundColor: theme.primaryLight }]}>
            <Icon name="camera-outline" size={15} color={theme.primary} />
            <Text style={{ color: theme.primary, fontSize: 13, fontWeight: '600', marginLeft: 6 }}>
              {saving ? 'Uploading…' : (profilePic ? 'Change profile picture' : 'Set profile picture')}
            </Text>
          </TouchableOpacity>
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

      <Section title="App Lock" theme={theme}>
        <SettingRow label="App Lock" icon="lock-closed-outline" theme={theme}>
          <Switch
            value={appLockEnabled}
            onValueChange={handleAppLockToggle}
            trackColor={{ true: theme.primary }}
          />
        </SettingRow>
        {appLockEnabled && (
          <SettingRow label="Change PIN" icon="create-outline" theme={theme}>
            <TouchableOpacity onPress={() => setConfirmingPIN(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="key-outline" size={18} color={theme.primary} />
              <Text style={{ color: theme.text, fontSize: 14 }}>Change PIN</Text>
            </TouchableOpacity>
          </SettingRow>
        )}
      </Section>

      {confirmingPIN && (
        <View style={{ marginHorizontal: 16, marginTop: 8, padding: 16, backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: theme.text, marginBottom: 8, textAlign: 'center' }}>
            {confirmingPIN && appLockPIN ? 'Confirm New PIN' : 'Set New PIN'}
          </Text>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 16 }}>
            {[1, 2, 3, 4].map((i) => (
              <View key={i} style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: appLockPINEntry.length >= i ? theme.primary : theme.border, backgroundColor: appLockPINEntry.length >= i ? theme.primary : 'transparent' }} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
            {['1','2','3','4','5','6','7','8','9','0','⌫'].map((k) => (
              <TouchableOpacity key={k} onPress={() => {
                if (k === '⌫') setAppLockPINEntry(l => l.slice(0, -1));
                else if (k === '') return;
                else if (appLockPINEntry.length < 4) setAppLockPINEntry(l => l + k);
              }} style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: theme.inputBg, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border }}>
                <Text style={{ fontSize: 20, fontWeight: '600', color: theme.text }}>{k}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity onPress={handlePINConfirm} style={{ marginTop: 16, alignItems: 'center', paddingVertical: 10, backgroundColor: theme.primary, borderRadius: 10 }}>
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>{confirmingPIN && appLockPIN ? 'Confirm' : 'Set PIN'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setConfirmingPIN(false); setAppLockPINEntry(''); }} style={{ marginTop: 8, alignItems: 'center' }}>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

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
  profileWrap: { margin: 16 },
  changePicBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginTop: 14, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9 },
  onlineDot: { width: 9, height: 9, borderRadius: 4.5, marginLeft: 8 },
  userHandle: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
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
