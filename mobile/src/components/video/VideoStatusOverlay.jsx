import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { fs } from '../../utils/size';

export default function VideoStatusOverlay({ label, error, buffering, onRetry }) {
  if (!label && !error && !buffering) return null;
  return (
    <View pointerEvents={error ? 'auto' : 'none'} style={{ position: 'absolute', left: 24, right: 24, top: '42%', zIndex: 25, alignItems: 'center' }}>
      <View style={{ borderRadius: 16, paddingHorizontal: 18, paddingVertical: 12, backgroundColor: 'rgba(8,5,14,0.78)', alignItems: 'center', minWidth: 160 }}>
        {error ? (
          <>
            <Text style={{ color: '#fff', fontSize: fs(13), fontWeight: '800', textAlign: 'center' }}>Unable to play this video.</Text>
            <Text style={{ color: 'rgba(255,255,255,0.66)', fontSize: fs(11), marginTop: 4, textAlign: 'center' }}>{error}</Text>
            <TouchableOpacity onPress={onRetry} accessibilityLabel="Retry video" style={{ marginTop: 10, borderRadius: 16, paddingHorizontal: 18, paddingVertical: 7, backgroundColor: '#8B5CF6' }}>
              <Text style={{ color: '#fff', fontSize: fs(12), fontWeight: '800' }}>Retry</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {buffering ? <ActivityIndicator color="#fff" size="small" /> : null}
            <Text style={{ color: '#fff', fontSize: fs(12), fontWeight: '700', marginTop: buffering ? 7 : 0, textAlign: 'center' }}>{label}</Text>
          </>
        )}
      </View>
    </View>
  );
}
