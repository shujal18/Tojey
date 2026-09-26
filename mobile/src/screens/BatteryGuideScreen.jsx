import React, { useEffect, useState } from 'react';
import { SafeAreaView, View, Text, TouchableOpacity, ScrollView, StyleSheet, AppState, Platform } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import {
  getDeviceInfo, isAggressiveOem, isBatteryOptimizationIgnored, requestBatteryOptimizationExempt, supportsBatteryModule,
} from '../services/battery';

const GUIDES = {
  OPPO: {
    title: 'OPPO / ColorOS',
    steps: [
      'Open Settings → Apps → App management → Tojey.',
      'Turn ON “Allow auto-start”.',
      'Tap “Battery usage” → choose “No restrictions”.',
      'Tap “Notifications” → turn every toggle ON.',
      'Also check: Settings → Battery → More → Background power management → Tojey → Allow.',
    ],
  },
  REALME: {
    title: 'realme / realme UI',
    steps: [
      'Open Settings → Apps → App management → Tojey.',
      'Turn ON “Allow auto-start”.',
      'Tap “Battery usage” → choose “No restrictions”.',
      'Tap “Notifications” → turn every toggle ON.',
      'Also check: Settings → Battery → More → Background power management → Tojey → Allow.',
    ],
  },
  VIVO: {
    title: 'vivo / Funtouch OS',
    steps: [
      'Open Settings → Battery → Background power consumption management.',
      'For Tojey, enable “Allow when locked” and “Allow background activity”.',
      'Open Settings → More settings → Permissions → Autostart → turn ON for Tojey.',
      'Tap the “×” on Tojey in iManager one-touch optimisation so it is not cleaned up.',
    ],
  },
  XIAOMI: {
    title: 'Xiaomi / Redmi / POCO (MIUI)',
    steps: [
      'Open Settings → Apps → Manage apps → Tojey.',
      'Turn ON “Autostart”.',
      'Tap “Battery saver” → choose “No restrictions”.',
      'Open Settings → Notifications → App notifications → Tojey → allow all.',
      'Optional: in Recents, long-press the Tojey card and tap the lock so it is never cleared.',
    ],
  },
  HUAWEI: {
    title: 'Huawei (EMUI)',
    steps: [
      'Open Settings → Battery → Launch → Tojey.',
      'Tap “Manage manually” and enable all toggles.',
      'Open Settings → Apps → Apps → Tojey → Notifications → allow all.',
      'Add Tojey to “Protected apps” if your build has it.',
    ],
  },
  HONOR: {
    title: 'Honor (Magic UI)',
    steps: [
      'Open Settings → Battery → Launch → Tojey.',
      'Tap “Manage manually” and enable all toggles.',
      'Open Settings → Apps → Apps → Tojey → Notifications → allow all.',
      'Add Tojey to the protected / auto-launch list if your build has it.',
    ],
  },
  TRANSSION: {
    title: 'Tecno / Infinix / iTel',
    steps: [
      'Open Settings → Apps → Tojey → “Allow auto-start”.',
      'Open Settings → Battery → App power consumption → allow background for Tojey.',
      'In “Phone Manager”, exclude Tojey from one-touch optimisation.',
      'Open Settings → Apps → Tojey → Notifications → allow all.',
    ],
  },
  SAMSUNG: {
    title: 'Samsung (One UI)',
    steps: [
      'Open Settings → Apps → Tojey → Battery → choose “Unrestricted”.',
      'Open Settings → Battery and device care → Background usage limits.',
      'In “Never sleeping apps”, add Tojey.',
      'Open Settings → Apps → Tojey → Notifications → allow all.',
    ],
  },
  ONEPLUS: {
    title: 'OnePlus',
    steps: [
      'Open Settings → Apps → Tojey → Battery → choose “Unrestricted”.',
      'Open Settings → Apps → Tojey → Notifications → allow all.',
      'If your OnePlus runs ColorOS-based software, also follow the OPPO steps (Allow auto-start).',
    ],
  },
  ASUS: {
    title: 'ASUS',
    steps: [
      'Open Settings → Apps & notifications → Tojey → Battery → “Unrestricted”.',
      'Open Settings → Apps → Tojey → Notifications → allow all.',
      'Make sure the app is not in the auto-cleanup list of the battery supervisor.',
    ],
  },
  GENERIC: {
    title: 'Standard Android',
    steps: [
      'Tap “Allow background activity” above (or do it in Settings → Apps → Tojey → Battery).',
      'Open Settings → Apps → Tojey → Notifications → turn every toggle ON.',
      'Open Settings → Apps → Tojey → Battery → choose “Unrestricted”.',
      'Never press “Force stop” for Tojey or “Optimize” its battery — that blocks notifications until you reopen the app.',
    ],
  },
  NOKIA: {
    title: 'Nokia (Android One)',
    steps: [
      'Tap “Allow background activity” above (or do it in Settings → Apps → Tojey → Battery).',
      'Open Settings → Apps → Tojey → Notifications → turn every toggle ON.',
      'Never press “Force stop” for Tojey or “Optimize” its battery.',
    ],
  },
};

export default function BatteryGuideScreen({ onClose }) {
  const { theme } = useTheme();
  const info = getDeviceInfo();
  const guide = GUIDES[info.brand] || GUIDES.GENERIC;
  const [exempt, setExempt] = useState(null);
  const [checking, setChecking] = useState(false);

  const refresh = async () => {
    if (!supportsBatteryModule()) {
      setExempt(false);
      return;
    }
    setChecking(true);
    try {
      setExempt(await isBatteryOptimizationIgnored());
    } catch (e) {
      setExempt(false);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, []);

  const allowed = exempt === true;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={onClose} style={styles.backBtn}>
          <Icon name="close" size={26} color={theme.primary} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Notification setup</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={[styles.statusCard, { backgroundColor: theme.card, borderColor: allowed ? '#2E9E5B' : theme.border }]}>
          <View style={styles.statusRow}>
            <Icon name={allowed ? 'checkmark-circle' : 'warning'} size={30} color={allowed ? '#2E9E5B' : theme.danger} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[styles.statusTitle, { color: theme.text }]}>
                {allowed ? 'Background delivery is allowed' : 'Battery saving may block Tojey'}
              </Text>
              <Text style={[styles.statusBody, { color: theme.textSecondary }]}>
                {allowed
                  ? 'Tojey is exempted from battery optimization, so notifications arrive even when the app is closed.'
                  : 'To receive pop-ups when Tojey is closed, allow background activity and auto-start (steps below).'}
              </Text>
            </View>
          </View>

          {!allowed && (
            <TouchableOpacity
              onPress={() => requestBatteryOptimizationExempt()}
              disabled={checking}
              style={[styles.allowBtn, { backgroundColor: checking ? theme.inputBg : theme.primary }]}
            >
              <Icon name="shield-checkmark-outline" size={18} color={checking ? theme.textSecondary : '#fff'} />
              <Text style={{ color: checking ? theme.textSecondary : '#fff', fontWeight: '700', fontSize: 14, marginLeft: 8 }}>
                {checking ? 'Checking…' : 'Allow background activity'}
              </Text>
            </TouchableOpacity>
          )}

          {!allowed && supportsBatteryModule() && (
            <TouchableOpacity onPress={refresh} style={{ alignSelf: 'center', marginTop: 10, flexDirection: 'row', alignItems: 'center' }}>
              <Icon name="refresh-outline" size={15} color={theme.textSecondary} />
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginLeft: 4 }}>Check again after you return from Settings</Text>
            </TouchableOpacity>
          )}
        </View>

        {Platform.Version >= 33 && (
          <View style={[styles.noteCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Icon name="notifications-outline" size={20} color={theme.primary} />
            <Text style={[styles.noteText, { color: theme.textSecondary }]}>
              Your Android also has an “Allow notifications” switch. Settings → Apps → Tojey → Notifications must be ON for any pop-up to appear.
            </Text>
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: theme.primary }]}>Follow these steps on {guide.title}</Text>
        <View style={[styles.stepsCard, { backgroundColor: theme.card }]}>
          {guide.steps.map((step, i) => (
            <View key={i} style={[styles.stepRow, i < guide.steps.length - 1 && { borderBottomColor: theme.border, borderBottomWidth: 1 }]}>
              <View style={[styles.stepNum, { backgroundColor: theme.primaryLight }]}>
                <Text style={{ color: theme.primary, fontWeight: '700' }}>{i + 1}</Text>
              </View>
              <Text style={[styles.stepText, { color: theme.text }]}>{step}</Text>
            </View>
          ))}
        </View>

        <View style={styles.deviceLine}>
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
            {info.model} · {info.label.toLowerCase()} · Android {info.sdkInt}
          </Text>
        </View>

        <Text style={[styles.sectionTitle, { color: theme.primary }]}>How to test</Text>
        <View style={[styles.stepsCard, { backgroundColor: theme.card }]}>
          <Text style={[styles.testText, { color: theme.textSecondary }]}>
            Close Tojey (from Recents or turn the screen off), then have a friend send you a message. If it pops up, everything works. The notification is shown by Android itself, so the app does not need to run.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4, width: 42, alignItems: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  statusCard: {
    margin: 16,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
  },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start' },
  statusTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  statusBody: { fontSize: 13, lineHeight: 19 },
  allowBtn: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 12,
  },
  noteCard: {
    marginHorizontal: 16,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  noteText: { flex: 1, fontSize: 12, lineHeight: 17 },
  sectionTitle: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13, fontWeight: '700' },
  stepsCard: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden' },
  stepRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 13 },
  stepNum: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  stepText: { flex: 1, fontSize: 13, lineHeight: 18 },
  deviceLine: { alignItems: 'center', paddingTop: 12 },
  testText: { fontSize: 13, lineHeight: 19, padding: 14 },
});