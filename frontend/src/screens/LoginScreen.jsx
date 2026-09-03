import React, { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { useAuth } from '../services/AuthContext';
import { MessageCircle, Lock } from 'lucide-react';

export default function LoginScreen() {
  const { theme, mode, setMode } = useTheme();
  const { login, loading, error } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    await login(username.trim(), password);
  };

  const fillDemo = (u, p) => {
    setUsername(u);
    setPassword(p);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: theme.background,
      padding: 16,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 400,
        background: theme.card,
        borderRadius: 24,
        boxShadow: theme.shadow,
        overflow: 'hidden',
        animation: 'slideInUp 0.4s ease',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
          padding: '40px 32px 32px',
          textAlign: 'center',
        }}>
          <div className="splash-logo" style={{
            width: 72,
            height: 72,
            margin: '0 auto 16px',
            borderRadius: 22,
            background: 'rgba(255,255,255,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <MessageCircle size={40} color="#fff" />
          </div>
          <h1 style={{ color: '#fff', fontSize: 32, fontWeight: 700 }}>Tojey</h1>
          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, marginTop: 4 }}>
            Private one-to-one messaging
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: 28 }}>
          <label style={{ color: theme.textSecondary, fontSize: 13, marginBottom: 6, display: 'block' }}>
            Username
          </label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="tom or jerry"
            style={{
              width: '100%',
              padding: '14px 16px',
              borderRadius: 12,
              background: theme.inputBg,
              color: theme.text,
              fontSize: 15,
              marginBottom: 16,
            }}
          />

          <label style={{ color: theme.textSecondary, fontSize: 13, marginBottom: 6, display: 'block' }}>
            Password
          </label>
          <div style={{ position: 'relative' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: 12,
                background: theme.inputBg,
                color: theme.text,
                fontSize: 15,
                marginBottom: 20,
                paddingRight: 44,
              }}
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              style={{ position: 'absolute', right: 12, top: 12, color: theme.textSecondary }}>
              <Lock size={18} />
            </button>
          </div>

          {error && (
            <div style={{
              color: '#E53935', fontSize: 13, marginBottom: 12, padding: 10,
              borderRadius: 10, background: 'rgba(229,57,53,0.1)',
            }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading || !username || !password} style={{
            width: '100%',
            padding: 15,
            borderRadius: 12,
            background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
            color: '#fff',
            fontSize: 16,
            fontWeight: 600,
            opacity: loading || !username || !password ? 0.6 : 1,
            transition: 'opacity 0.2s',
          }}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          <div style={{ marginTop: 22, textAlign: 'center', color: theme.textSecondary, fontSize: 13 }}>
            Demo accounts
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => fillDemo('tom', 'tom18')} style={{
              flex: 1, padding: 10, borderRadius: 10,
              background: theme.primaryLight, color: theme.primary,
              fontSize: 13, fontWeight: 500,
            }}>
              Tom · tom18
            </button>
            <button type="button" onClick={() => fillDemo('jerry', 'jerry22')} style={{
              flex: 1, padding: 10, borderRadius: 10,
              background: theme.primaryLight, color: theme.primary,
              fontSize: 13, fontWeight: 500,
            }}>
              Jerry · jerry22
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
