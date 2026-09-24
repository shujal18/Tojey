import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Switch, ScrollView, StyleSheet, Image, TextInput,
  Platform, AppState, Linking, PermissionsAndroid,
} from 'react-native';
import { launchImageLibrary } from 'react-native-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme/ThemeContext';
import { CHAT_COLORS } from '../theme';
import { Icon } from '../components/AppIcon';
import { SERVER_URL, absUrl } from '../config';
import { ensureMediaPermission } from '../services/permissions';
import RNFetchBlob from 'rn-fetch-blob';
import {
  supportsChatHead, getChatHeadEnabled, setChatHeadEnabled,
  canDrawOverlay, openOverlaySettings,
  getNudgeVibrationEnabled, setNudgeVibrationEnabled,
} from '../services/chatHead';
import { startPush } from '../services/notifications';

export default function SettingsScreen({ user, token, onBack, onLogout, setUser, appLockEnabled, appLockPIN, onAppLockChange }) {
  const { theme, mode, setMode, chatColorId, setChatColor } = useTheme();
  const [readReceipts, setReadReceipts] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [sound, setSound] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [saving, setSaving] = useState(false);
  const [appLockPINEntry, setAppLockPINEntry] = useState('');
  const [confirmingPIN, setConfirmingPIN] = useState(false);
  const [chatHead, setChatHead] = useState(false);
  const [chatHeadPending, setChatHeadPending] = useState(false);
  const [nudgeVib, setNudgeVib] = useState(true);
  const [fcmStatus, setFcmStatus] = useState(null);
  const [fcmBusy, setFcmBusy] = useState(false);
  const [notifPermission, setNotifPermission] = useState(true);

  useEffect(() => {
    if (Platform.Version >= 33) {
      (async () => {
        try {
          setNotifPermission(await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS));
        } catch (e) {}
      })();
    }
  }, []);

  const loadFcmStatus = async () => {
    setFcmStatus({ loading: true, data: null, error: null });
    try {
      const res = await fetch(`${SERVER_URL}/api/fcm/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        data = null;
      }
      if (!res.ok) throw new Error((data && data.error) || `Server responded ${res.status}`);
      setFcmStatus({ loading: false, data, error: null });
    } catch (e) {
      console.warn('FCM status fetch failed:', e.message);
      setFcmStatus({ loading: false, data: null, error: e.message });
    }
  };

  const reRegisterFCM = async () => {
    if (fcmBusy) return;
    setFcmBusy(true);
    try {
      const ok = await startPush(token);
      alert(ok ? 'Push token re-registered successfully.' : 'Could not register a fresh push token. Check console logs for [FCM].');
    } catch (e) {
      console.warn('FCM re-register failed:', e);
      alert('Failed to re-register: ' + e.message);
    } finally {
      setFcmBusy(false);
      loadFcmStatus();
    }
  };

  const sendFCMPush = async () => {
    if (fcmBusy) return;
    setFcmBusy(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/devices/tokens/sendtest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      let data;
      try {
        data = await res.json();
      } catch (parseErr) {
        data = {};
      }
      if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
      if (data.note === 'fcm-unconfigured') {
        alert('Server FCM is DISABLED — nothing was sent. In Render add the FIREBASE_SERVICE_ACCOUNT_B64 env var for Firebase project tojey-dba45, redeploy the backend, then test again.');
      } else if (!data.sent) {
        alert(`Test push not delivered (tokens=${data.tokens || 0}, note=${data.note || 'unknown'}).`);
      } else {
        alert(`Test push SENT (messageId ${data.messageId || 'ok'}). Check your device notification tray now.`);
      }
      loadFcmStatus();
    } catch (e) {
      console.warn('FCM test push failed:', e.message);
      alert('Test push request failed: ' + e.message);
    } finally {
      setFcmBusy(false);
    }
  };

  useEffect(() => {
    if (token) loadFcmStatus();
  }, [token]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const [ch, nv] = await Promise.all([getChatHeadEnabled(), getNudgeVibrationEnabled()]);
      if (mounted) {
        setChatHead(ch);
        setNudgeVib(nv);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // If the user toggled Chat Head on before granting "Display over other apps",
  // watch for the app to come back from the system overlay settings screen and
  // finish enabling it automatically (or revert if they didn't grant it).
  useEffect(() => {
    if (!chatHeadPending) return;
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      if (await canDrawOverlay()) {
        setChatHeadPending(false);
        setChatHead(true);
        await setChatHeadEnabled(true);
      } else {
        setChatHeadPending(false);
        setChatHead(false);
        await setChatHeadEnabled(false);
      }
    });
    return () => sub.remove();
  }, [chatHeadPending]);

  // If the user granted "Display over other apps" directly from the system settings
  // (without toggling the in-app switch first), pick that up and enable Chat Head
  // automatically next time the app is foregrounded. An explicit in-app toggle-off is
  // always respected and will not be undone.
  const chatHeadOffManually = useRef(false);
  useEffect(() => {
    let mounted = true;
    const sync = async () => {
      if (!mounted || chatHeadOffManually.current) return;
      const stored = await getChatHeadEnabled();
      const over = await canDrawOverlay();
      if (over && !stored) {
        await setChatHeadEnabled(true);
        if (mounted) setChatHead(true);
      } else if (!over && stored) {
        await setChatHeadEnabled(false);
        if (mounted) setChatHead(false);
      }
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') sync();
    });
    sync();
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const toggleChatHead = async (enabled) => {
    chatHeadOffManually.current = !enabled;
    if (!enabled) {
      setChatHeadPending(false);
      setChatHead(false);
      await setChatHeadEnabled(false);
      return;
    }
    if (!supportsChatHead()) {
      alert('Chat Head is only available in the installed Tojey app.');
      return;
    }
    if (!(await canDrawOverlay())) {
      setChatHead(true);
      setChatHeadPending(true);
      await setChatHeadEnabled(false);
      openOverlaySettings();
      alert('Grant "Display over other apps" for Tojey. When you come back, Chat Head turns on automatically.');
      return;
    }
    setChatHead(true);
    await setChatHeadEnabled(true);
  };

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
          const pText = await pRes.text();
          let data;
          try {
            data = JSON.parse(pText);
          } catch (parseErr) {
            throw new Error(
              pText && pText.includes('<') && !pText.includes('{')
                ? 'Server is outdated — please redeploy the backend, then try again.'
                : 'Invalid response from server.'
            );
          }
          if (!pRes.ok) {
            throw new Error(data.error || `Profile update failed (${pRes.status})`);
          }
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

      <Section title="Chat Color" theme={theme}>
        <View style={styles.chatColorRow}>
          {CHAT_COLORS.map((c) => (
            <TouchableOpacity
              key={c.id}
              onPress={() => setChatColor(c.id)}
              style={[styles.chatColorItem, { borderColor: chatColorId === c.id ? theme.primary : 'transparent' }]}
              accessibilityLabel={`Chat color ${c.name}`}
            >
              <View style={[styles.chatColorCircle, { backgroundColor: c.sent }]}>
                {chatColorId === c.id && <Icon name="checkmark" size={16} color="#fff" />}
              </View>
              <Text style={{ color: theme.textSecondary, fontSize: 11, marginTop: 4 }}>{c.name}</Text>
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
        <SettingRow label="Vibration" icon="finger-print-outline" theme={theme}>
          <Switch value={vibration} onValueChange={setVibration} trackColor={{ true: theme.primary }} />
        </SettingRow>
        {Platform.OS === 'android' && (
          <SettingRow label="Notification permission" icon="shield-checkmark-outline" theme={theme}>
            <TouchableOpacity onPress={() => Linking.openSettings()} style={{ paddingVertical: 2 }}>
              <Text style={{ color: notifPermission ? theme.online : theme.danger, fontSize: 13, fontWeight: '700' }}>
                {Platform.Version >= 33
                  ? (notifPermission ? 'Allowed' : 'Blocked · Tap to fix')
                  : 'Open settings · Check popups'}
              </Text>
            </TouchableOpacity>
          </SettingRow>
        )}
      </Section>

      <Section title="Push Notifications (FCM)" theme={theme}>
        {fcmStatus && fcmStatus.data && (
          <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.helperText, { flex: 1, padding: 0, fontSize: 13, color: theme.textSecondary }]}>Server Firebase</Text>
              <Text style={{
                fontSize: 13, fontWeight: '700', color: fcmStatus.data.firebaseAdmin === 'ENABLED' ? theme.online : theme.danger,
              }}>
                {fcmStatus.data.firebaseAdmin === 'ENABLED' ? 'ENABLED' : 'DISABLED'}
              </Text>
            </View>
            {fcmStatus.data.firebaseProjectId ? (
              <Text style={{ fontSize: 12, color: theme.textSecondary, marginTop: 4 }}>
                Firebase project: {fcmStatus.data.firebaseProjectId}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
              <Text style={{ flex: 1, fontSize: 13, color: theme.textSecondary }}>Registered push tokens</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: theme.text }}>{fcmStatus.data.totalActiveTokens || 0}</Text>
            </View>
          </View>
        )}

        {fcmStatus && fcmStatus.data && fcmStatus.data.firebaseAdmin !== 'ENABLED' && (
          <Text style={[styles.helperText, { color: theme.danger }]}>
            Push is NOT being delivered to backgrounded/killed devices. In the Render dashboard add a backend env
            var FIREBASE_SERVICE_ACCOUNT_B64 (base64 of the tojey-dba45 Firebase service-account JSON: Firebase console →
            Project settings → Service accounts → Generate new private key), then Redeploy and press "Re-register token".
          </Text>
        )}

        {fcmStatus && fcmStatus.error && (
          <Text style={[styles.helperText, { color: theme.danger }]}>Diagnostics unavailable: {fcmStatus.error}</Text>
        )}
        {(!fcmStatus || fcmStatus.loading) && (
          <Text style={[styles.helperText, { color: theme.textSecondary }]}>Checking FCM status…</Text>
        )}

        <View style={{ flexDirection: 'row', padding: 14, gap: 8 }}>
          <TouchableOpacity
            onPress={() => loadFcmStatus()}
            disabled={fcmBusy}
            style={[styles.fcmBtn, { backgroundColor: theme.primaryLight }]}
          >
            <Text style={{ color: theme.primary, fontSize: 12, fontWeight: '600' }}>{fcmBusy ? 'Working…' : 'Refresh'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={reRegisterFCM}
            disabled={fcmBusy}
            style={[styles.fcmBtn, { backgroundColor: theme.primaryLight }]}
          >
            <Text style={{ color: theme.primary, fontSize: 12, fontWeight: '600' }}>{fcmBusy ? 'Working…' : 'Re-register token'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={sendFCMPush}
            disabled={fcmBusy}
            style={[styles.fcmBtn, { flex: 1, backgroundColor: theme.primary }]}
          >
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{fcmBusy ? 'Working…' : 'Send test push'}</Text>
          </TouchableOpacity>
        </View>
      </Section>

      <Section title="Chat Head & Nudge" theme={theme}>
        <SettingRow label="Chat Head" icon="chatbubbles-outline" theme={theme}>
          <Switch value={chatHead} onValueChange={toggleChatHead} trackColor={{ true: theme.primary }} />
        </SettingRow>
        <Text style={[styles.helperText, { color: theme.textSecondary }]}>
          Shows a floating bubble of the person you are chatting with when you leave the app. Tap it to come back.
        </Text>
        <SettingRow label="Nudge Vibration" icon="hand-left-outline" theme={theme}>
          <Switch value={nudgeVib} onValueChange={async (v) => { setNudgeVib(v); await setNudgeVibrationEnabled(v); }} trackColor={{ true: theme.primary }} />
        </SettingRow>
        <Text style={[styles.helperText, { color: theme.textSecondary }]}>
          Vibrates when someone nudges you (from the chat menu or long-press in chats).
        </Text>
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

      <Text style={[styles.footer, { color: theme.textSecondary }]}>Tojey · Private Chat · v1.12.0</Text>
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
  helperText: { fontSize: 12, lineHeight: 17, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  themeRow: { flexDirection: 'row', gap: 8, padding: 14, borderBottomWidth: 1 },
  chatColorRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', padding: 14, gap: 14 },
  chatColorItem: { alignItems: 'center', width: 56, borderWidth: 2, borderRadius: 12, paddingVertical: 8 },
  chatColorCircle: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  themeBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 12,
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  fcmBtn: {
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center',
  },
  logoutBtn: {
    backgroundColor: 'rgba(229,57,53,0.1)', marginHorizontal: 16, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
    marginTop: 8,
  },
  logoutText: { fontSize: 15, fontWeight: '700' },
  footer: { textAlign: 'center', fontSize: 13, paddingVertical: 30 },
});
