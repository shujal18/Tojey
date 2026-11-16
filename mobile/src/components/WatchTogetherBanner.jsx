import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from './AppIcon';
import Toast from './Toast';
import { fs } from '../utils/size';
import { useWatchTogether } from '../services/WatchTogetherContext';

// Global Watch Together surface: incoming invitation card on any screen, the
// "waiting for partner" notice, and the partner-left notice. It also opens the
// room's video as soon as an authoritative room state arrives (accept or
// reconnect), mirroring the web WatchTogetherBridge.
export default function WatchTogetherBanner({ onOpenVideo }) {
  const { theme } = useTheme();
  const wt = useWatchTogether();
  const lastRoomRef = useRef(null);
  const roomId = wt.room && wt.room.roomId;

  useEffect(() => {
    if (roomId && roomId !== lastRoomRef.current) {
      lastRoomRef.current = roomId;
      if (onOpenVideo && wt.room && wt.room.videoId) onOpenVideo(wt.room);
    }
    if (!roomId) lastRoomRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const showCard = !!(wt.invite || wt.outgoing || wt.partnerLeft);

  return (
    <>
      {showCard && (
        <View pointerEvents="box-none" style={styles.wrap}>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            <View style={[styles.iconWrap, { backgroundColor: theme.primaryLight }]}>
              <Icon name="people" size={18} color={theme.primary} />
            </View>

            {!!wt.invite && (
              <>
                <View style={styles.copy}>
                  <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                    {(wt.invite.from && wt.invite.from.displayName) || 'Friend'} invited you
                  </Text>
                  <Text style={[styles.sub, { color: theme.textSecondary }]} numberOfLines={1}>
                    {wt.invite.title || 'Watch together'}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => wt.respondInvite(true)}
                  style={[styles.btn, { backgroundColor: theme.primary }]}
                >
                  <Text style={styles.btnText}>Accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => wt.respondInvite(false)}
                  style={[styles.btnGhost, { borderColor: theme.border }]}
                >
                  <Text style={[styles.btnGhostText, { color: theme.textSecondary }]}>Decline</Text>
                </TouchableOpacity>
              </>
            )}

            {!wt.invite && !!wt.outgoing && (
              <View style={styles.copy}>
                <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                  Waiting for {wt.outgoing.toName}…
                </Text>
                <Text style={[styles.sub, { color: theme.textSecondary }]} numberOfLines={1}>
                  Invitation sent
                </Text>
              </View>
            )}

            {!wt.invite && !wt.outgoing && !!wt.partnerLeft && (
              <View style={styles.copy}>
                <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
                  {(wt.partnerLeft.by && wt.partnerLeft.by.displayName) || 'Your friend'} left the room
                </Text>
                <Text style={[styles.sub, { color: theme.textSecondary }]} numberOfLines={1}>
                  Watch alone or start a new session
                </Text>
              </View>
            )}
          </View>
        </View>
      )}
      <Toast message={wt.notice} bottom={96} />
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 42,
    left: 10,
    right: 10,
    zIndex: 120,
    elevation: 24,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    maxWidth: 520,
    width: '100%',
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: fs(13), fontWeight: '800' },
  sub: { fontSize: fs(11), marginTop: 1 },
  btn: {
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  btnText: { color: '#fff', fontSize: fs(12), fontWeight: '800' },
  btnGhost: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
  },
  btnGhostText: { fontSize: fs(12), fontWeight: '700' },
});
