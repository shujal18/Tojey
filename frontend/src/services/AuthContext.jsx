import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext();

const API = import.meta.env.VITE_API_URL || '';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('tojey-user');
    return raw ? JSON.parse(raw) : null;
  });
  const [token, setToken] = useState(() => localStorage.getItem('tojey-token') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function login(username, password) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return false;
      }
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('tojey-token', data.token);
      localStorage.setItem('tojey-user', JSON.stringify(data.user));
      return true;
    } catch (e) {
      setError('Cannot reach server. Is the backend running?');
      return false;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setUser(null);
    setToken('');
    localStorage.removeItem('tojey-token');
    localStorage.removeItem('tojey-user');
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, error, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
