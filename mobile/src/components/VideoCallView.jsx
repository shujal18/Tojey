import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { Icon } from './AppIcon';
import { fs } from '../utils/size';
import { absUrl } from '../config';

// In-call video surface for Tojey. Rendered between the chat header and the
// existing Tojey text composer (which stays fully functional during a call).
// Camera-only: mic/speaker controls are intentionally absent (spec forbids audio).
function Peers({ localUrl, remoteUrl, peerAvatar, peerName, theme }) {
  return (
    <View style={styles.stage}>
      {remoteUrl ? (
        <RTCView streamURL={remoteUrl} objectFit="cover" style={StyleSheet.absoluteFill} />
      ) : (
        <View style={[styles.waiting, { backgroundColor: '#101418' }]}>
          {peerAvatar ? (
            <Image source={{ uri: absUrl(peerAvatar) }} style={styles.waitingAvatar} />
          ) : (
            <View style={[styles.waitingAvatar, { backgroundColor: theme.primary }]}>
              <Text style={styles.waitingAvatarText}>{(peerName || '?')[0].toUpperCase()}</Text>
            </View>
          )}
          <Text style={styles.waitingName}>{peerName}</Text>
          <Text style={styles.waitingHint}>Connecting…</Text>
        </View>
      )}
      {localUrl && (
        <View style={styles.localPip}>
          <RTCView streamURL={localUrl} objectFit="cover" style={styles.localVideo} />
        </View>
      )}
    </View>
  );
}

export default function VideoCallView({ status, peerName, peerAvatar, localStream, remoteStream, onAccept, onDecline, onEnd, onSwitchCamera, theme }) {
  const localUrl = localStream ? localStream.toURL() : null;
  const remoteUrl = status === 'active' && remoteStream ? remoteStream.toURL() : null;

  if (status === 'incoming') {
    return (
      <View style={[styles.fit, { backgroundColor: '#101418' }]}>
        {peerAvatar ? (
          <Image source={{ uri: absUrl(peerAvatar) }} style={styles.bigAvatar} />
        ) : (
          <View style={[styles.bigAvatar, { backgroundColor: theme.primary }]}>
            <Text style={styles.bigAvatarText}>{(peerName || '?')[0].toUpperCase()}</Text>
          </View>
        )}
        <Text style={styles.bigName}>{peerName}</Text>
        <Text style={styles.sub}>{'Incoming video call'}</Text>
        <View style={styles.incomingActions}>
          <TouchableOpacity onPress={onDecline} style={styles.bigBtn} accessibilityLabel="Decline call">
            <View style={[styles.bigBtnCircle, { backgroundColor: '#E53935' }]}>
              <Icon name="call" size={26} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
            </View>
            <Text style={styles.bigBtnLabel}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onAccept} style={styles.bigBtn} accessibilityLabel="Accept video call">
            <View style={[styles.bigBtnCircle, { backgroundColor: '#2E9E6B' }]}>
              <Icon name="videocam" size={26} color="#fff" />
            </View>
            <Text style={styles.bigBtnLabel}>Accept</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const connecting = status !== 'active' || !remoteUrl;

  return (
    <View style={styles.fit}>
      <Peers localUrl={localUrl} remoteUrl={remoteUrl} peerAvatar={peerAvatar} peerName={peerName} theme={theme} />
      <View style={styles.topBar}>
        <Text style={styles.topStatus}>
          {status === 'active' && remoteUrl ? 'Video call' : 'Ringing…'}
        </Text>
      </View>
      <View style={styles.controls}>
        <TouchableOpacity onPress={onSwitchCamera} style={styles.ctrlBtn} accessibilityLabel="Switch camera">
          <View style={[styles.ctrlCircle, { backgroundColor: 'rgba(255,255,255,0.16)' }]}>
            <Icon name="camera-reverse-outline" size={24} color="#fff" />
          </View>
          <Text style={styles.ctrlLabel}>Flip</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onEnd} style={styles.ctrlBtn} accessibilityLabel="End call">
          <View style={[styles.ctrlCircle, { backgroundColor: '#E53935' }]}>
            <Icon name="call" size={24} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
          </View>
          <Text style={styles.ctrlLabel}>End</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fit: { flex: 1, position: 'relative' },
  stage: { flex: 1, overflow: 'hidden' },
  waiting: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  waitingAvatar: { width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center', resizeMode: 'cover' },
  waitingAvatarText: { color: '#fff', fontSize: 36, fontWeight: '700' },
  waitingName: { color: '#fff', fontSize: 18, fontWeight: '600', marginTop: 14 },
  waitingHint: { color: 'rgba(255,255,255,0.55)', fontSize: 13, marginTop: 6 },
  localPip: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 96,
    height: 132,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    elevation: 5,
  },
  localVideo: { flex: 1, borderRadius: 12 },
  topBar: { position: 'absolute', top: 14, left: 14 },
  topStatus: { color: '#fff', fontSize: 13, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
  },
  ctrlBtn: { alignItems: 'center' },
  ctrlCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  ctrlLabel: { color: '#fff', fontSize: 11, marginTop: 6, fontWeight: '600' },
  bigAvatar: { width: 120, height: 120, borderRadius: 60, alignSelf: 'center', marginTop: 60, alignItems: 'center', justifyContent: 'center', resizeMode: 'cover' },
  bigAvatarText: { color: '#fff', fontSize: 46, fontWeight: '700' },
  bigName: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 18 },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center', marginTop: 6 },
  incomingActions: { flexDirection: 'row', justifyContent: 'center', gap: 56, marginTop: 48 },
  bigBtn: { alignItems: 'center' },
  bigBtnCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  bigBtnLabel: { color: '#fff', fontSize: 13, marginTop: 8, fontWeight: '600' },
});