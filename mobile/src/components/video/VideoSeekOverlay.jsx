import React from 'react';
import { Text, View } from 'react-native';
import { fs } from '../../utils/size';

export default function VideoSeekOverlay({ value, duration }) {
  if (!value || value.target == null) return null;
  const delta = Number(value.delta) || 0;
  const prefix = delta >= 0 ? '+' : '-';
  const abs = Math.abs(delta);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  const deltaText = `${prefix}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
  const target = `${Math.floor(value.target / 60)}:${String(Math.floor(value.target % 60)).padStart(2, '0')}`;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: '36%', zIndex: 26, alignItems: 'center' }}>
      <View style={{ borderRadius: 18, backgroundColor: 'rgba(8,5,14,0.84)', paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: fs(20), fontWeight: '900' }}>{deltaText}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: fs(11), fontWeight: '700', marginTop: 3 }}>{target} / {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}</Text>
      </View>
    </View>
  );
}
