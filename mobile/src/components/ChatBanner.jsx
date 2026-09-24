import React, { useEffect, useRef } from 'react';
import { Animated, Image, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeContext';

const AUTODISMISS_MS = 6000;

// WhatsApp/Bazar-Nepal-style floating top banner shown when a chat message
// arrives while the app is open but the user is not viewing that conversation.
// Rendered entirely in-app, so it is NOT subject to OEM notification rules
// (Do Not Disturb, per-app banner allowance, battery killers) — the only
// requirement is that the app process is alive.
export default function ChatBanner({ banner, onOpen, onDismiss }) {
  const { theme } = useTheme();
  const translateY = useRef(new Animated.Value(-140)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 260, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 260, useNativeDriver: true }),
    ]).start();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -140, duration: 200, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished && onDismiss) onDismiss();
      });
    }, AUTODISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [banner, onDismiss]);

  if (!banner) return null;

  const initial = ((banner.name || '?')[0] || '?').toUpperCase();

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <Animated.View
        style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border, transform: [{ translateY }], opacity }]}
      >
        <TouchableOpacity activeOpacity={0.85} style={styles.body} onPress={() => { if (onOpen) onOpen(banner); }}>
          <View style={[styles.avatar, { backgroundColor: banner.userId === 1 ? theme.primary : theme.primaryDeep }]}>
            {banner.profilePic ? (
              <Image source={{ uri: banner.profilePic }} style={styles.avatarImg} />
            ) : (
              <Text style={[styles.avatarText, { color: '#fff' }]}>{initial}</Text>
            )}
          </View>
          <View style={styles.textWrap}>
            <Text style={[styles.title, { color: theme.primary }]} numberOfLines={1}>{banner.name || 'Tojey'}</Text>
            <Text style={[styles.preview, { color: theme.text }]} numberOfLines={2}>{banner.preview || ''}</Text>
          </View>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>Tap to open</Text>
        </TouchableOpacity>
        <TouchableOpacity hitSlop={10} onPress={onDismiss} style={styles.close} accessibilityLabel="Dismiss">
          <Text style={[styles.closeX, { color: theme.textSecondary }]}>✕</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 46,
    left: 10,
    right: 10,
    zIndex: 9999,
    elevation: 9999,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingRight: 10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
    overflow: 'hidden',
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingLeft: 12, paddingRight: 6 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  avatarImg: { width: '100%', height: '100%', borderRadius: 20 },
  avatarText: { fontSize: 18, fontWeight: '700' },
  textWrap: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  preview: { fontSize: 12.5, lineHeight: 17 },
  hint: { fontSize: 10, marginLeft: 8, alignSelf: 'flex-end', marginBottom: 10 },
  close: { paddingHorizontal: 8, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  closeX: { fontSize: 15, fontWeight: '700' },
});