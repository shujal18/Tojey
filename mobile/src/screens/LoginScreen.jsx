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
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';

export default function LoginScreen({ onLogin }) {
  const { theme } = useTheme();
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
          <View style={[styles.logo, { backgroundColor: theme.primary }]}>
            <Icon name="chatbubbles" size={40} color="#fff" />
          </View>
          <Text style={[styles.appName, { color: theme.primaryDeep }]}>Tojey</Text>
          <Text style={[styles.tagline, { color: theme.textSecondary }]}>Private one-to-one messaging</Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme.card }]}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>Username</Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder="Private username"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={[styles.label, { color: theme.textSecondary }]}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={theme.textSecondary}
            style={[styles.input, { backgroundColor: theme.inputBg, color: theme.text }]}
            secureTextEntry
          />

          {error ? (
            <View style={[styles.errorBox, { backgroundColor: theme.danger }]}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.loginBtn, { backgroundColor: theme.primary }, (!username.trim() || !password) && styles.loginBtnDim]}
            onPress={handleSubmit}
            disabled={loading || !username.trim() || !password}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginBtnText}>Sign In</Text>
            )}
          </TouchableOpacity>

          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            This is a private chat. Only invited users can connect.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: 20 },
  header: { alignItems: 'center', marginBottom: 30 },
  logo: {
    width: 76,
    height: 76,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  appName: { fontSize: 34, fontWeight: '800' },
  tagline: { fontSize: 14, marginTop: 4 },
  card: {
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
    marginBottom: 6,
    marginTop: 6,
  },
  input: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    marginBottom: 14,
  },
  errorBox: {
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  errorText: { color: '#fff', fontSize: 13 },
  loginBtn: {
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
  },
  loginBtnDim: { opacity: 0.6 },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  hint: { textAlign: 'center', fontSize: 12, marginTop: 14 },
});
