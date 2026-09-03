import React, { useEffect } from 'react';
import { AuthProvider, useAuth } from './services/AuthContext';
import LoginScreen from './screens/LoginScreen';
import HomeLayout from './screens/HomeLayout';

function Root() {
  const { user } = useAuth();
  return user ? <HomeLayout /> : <LoginScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}
