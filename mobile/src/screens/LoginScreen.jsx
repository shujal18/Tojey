import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { login } from '../services/auth';
import { TojeyColors } from '../theme';

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!username.trim() || !password) return;
    setLoading(true);
    setError('');
    const result = await login(username.trim(), password);
    setLoading(false);
    if (result.ok) {
      onLogin(result.user, result.token);
    } else {
      setError(result.error);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.logo}>
            <Text style={styles.logoIcon}>💬</Text>
          </View>
          <Text style={styles.appName}>Tojey</Text>
          <Text style={styles.tagline}>Private one-to-one messaging</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder="Username"
            placeholderTextColor="#9B96A8"
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor="#9B96A8"
            style={styles.input}
            secureTextEntry
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.loginBtn, (!username.trim() || !password) && styles.loginBtnDim]}
            onPress={handleSubmit}
            disabled={loading || !username.trim() || !password}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginBtnText}>Sign In</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: TojeyColors.backgroundLight },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  header: { alignItems: 'center', marginBottom: 30 },
  logo: {
    width: 76,
    height: 76,
    borderRadius: 24,
    backgroundColor: TojeyColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  logoIcon: { fontSize: 40 },
  appName: { fontSize: 34, fontWeight: '800', color: TojeyColors.primaryDeep },
  tagline: { fontSize: 14, color: TojeyColors.textSecondary, marginTop: 4 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 24,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  label: {
    fontSize: 13,
    color: TojeyColors.textSecondary,
    marginBottom: 6,
    marginTop: 6,
  },
  input: {
    backgroundColor: '#F0EDF8',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    color: TojeyColors.textLight,
    marginBottom: 14,
  },
  errorBox: {
    backgroundColor: 'rgba(229,57,53,0.1)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  errorText: { color: '#E53935', fontSize: 13 },
  loginBtn: {
    backgroundColor: TojeyColors.primary,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  loginBtnDim: { opacity: 0.6 },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
