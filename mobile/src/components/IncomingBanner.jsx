import React, { useEffect, useRef } from 'react';
import { Animated, Platform, StatusBar, StyleSheet, Text, TouchableOpacity, View, Image } from 'react-native';
import { Icon } from './AppIcon';
import { absUrl } from '../config';

const TOP_OFFSET = Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 44;

export function messagePreviewText(message) {
  const t = message && message.type;
  const raw = typeof message.content === 'string' ? message.content.trim() : '';
  if (t === 'VOICE') return '🎤 Voice message';
  if (t === 'IMAGE') return raw ? `📷 Photo: ${raw}` : '📷 Photo';
  if (t === 'VIDEO') return raw ? `🎥 Video: ${raw}` : '🎥 Video';
  if (t === 'FILE' || t === 'DOCUMENT') return raw ? `📎 File: ${raw}` : '📎 File';
  if (t === 'CALL') return '📞 Video call';
  if (t === 'TEXT') return raw;
  return raw || 'New message';
}

// WhatsApp/Facebook-Lite-style heads-up banner. Rendered by the app itself over any
// open screen when a chat message arrives for a conversation that is not the one
// currently open - so a new message visibly "pops" on EVERY device in EVERY state,
// with zero dependency on FCM, notification permission, or OEM background rules.
export default function IncomingBanner({ data, onPress, onDismiss }) {
  const anim = useRef(new Animated.Value(-140)).current;
  const timer = useRef(null);

  useEffect(() => {
    if (!data) return;
    Animated.spring(anim, { toValue: 0, damping: 18, stiffness: 240, mass: 0.7, useNativeDriver: true }).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      Animated.timing(anim, { toValue: -140, duration: 220, useNativeDriver: true }).start(({ finished }) => {
        if (finished && onDismiss) onDismiss();
      });
    }, 4000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [data, anim, onDismiss]);

  if (!data) return null;

  const name = data.senderName || 'Tojey';
  const body = data.preview || 'New message';
  const pic = data.senderPic ? absUrl(data.senderPic) : null;

  return (
    <Animated.View pointerEvents="box-none" style={[styles.wrap, { paddingTop: TOP_OFFSET, transform: [{ translateY: anim }] }]}>
      <TouchableOpacity style={styles.card} activeOpacity={0.92} onPress={onPress}>
        {pic ? (
          <Image source={{ uri: pic }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarLetter}>{(name || 'T').slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
        <View style={styles.body}>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
          <Text style={styles.preview} numberOfLines={1}>{body}</Text>
        </View>
        <TouchableOpacity style={styles.close} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} onPress={onDismiss}>
          <Icon name="close" size={16} color="#8A8691" />
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 300,
    paddingHorizontal: 10,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(28,26,35,0.96)',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    elevation: 12,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  avatar: { width: 38, height: 38, borderRadius: 19 },
  avatarFallback: { backgroundColor: '#6C3CE9', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#fff', fontSize: 16, fontWeight: '700' },
  body: { flex: 1, paddingHorizontal: 10 },
  name: { color: '#F2F0F7', fontSize: 14, fontWeight: '700' },
  preview: { color: '#B4AFBD', fontSize: 13, marginTop: 2 },
  close: { padding: 2 },
});