import React from 'react';
import Ionicons from 'react-native-vector-icons/Ionicons';

const family = Ionicons;

export function Icon({ name, size = 22, color = '#6C3CE9', style }) {
  return <Ionicons name={name} size={size} color={color} style={style} />;
}

export const Colors = {
  primary: '#6C3CE9',
  primaryDeep: '#4E22B8',
  primaryLight: '#EEE8FF',
  textLight: '#1A1720',
  textSecondary: '#6B6773',
  white: '#FFFFFF',
  danger: '#E53935',
  online: '#7C4DFF',
};
