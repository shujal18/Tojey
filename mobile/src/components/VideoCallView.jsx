import React from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { Icon } from './AppIcon';
import { fs } from '../utils/size';
import { absUrl } from '../config';

// In-call video surface for Tojey. Rendered between the chat header and the
// existing Tojey text composer (which stays fully functional during a call).
// Audio is enabled. The local camera preview is MIRRORED like a selfie view so
// it matches the web client (screen share stays unmirrored), kept behind a small
// non-rounded surface (SurfaceView cannot be rounded/clipped reliably on some
// Android versions) with an explicit zIndex/elevation so it always stacks above
// the remote stream. Controls: flip camera, camera on/off, my-mic mute, local
// mute of the REMOTE audio (this device stops playing the other user - the peer
// is never muted), screen share, end.
function Peers({ localStream, remoteStream, peerAvatar, peerName, theme, cameraOn, screenSharing }) {
  const localUrl = localStream ? localStream.toURL() : null;
  const remoteUrl = remoteStream ? remoteStream.toURL() : null;
  const showOffPip = !screenSharing && !cameraOn;
  return (
    <View style={styles.stage}>
      {remoteUrl ? (
        <RTCView streamURL={remoteUrl} objectFit="cover" style={StyleSheet.absoluteFill} zOrder={0} />
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
          <Text style={styles.waitingHint}>{screenSharing ? 'Sharing your screen…' : 'Connecting…'}</Text>
        </View>
      )}
      {localUrl && !showOffPip && (
        <View style={styles.localPip} pointerEvents="none">
          {screenSharing && (
            <View style={styles.scrTag}>
              <Icon name="laptop-outline" size={13} color="#fff" />
              <Text style={styles.scrTagText}>Screen</Text>
            </View>
          )}
          <RTCView
            streamURL={localUrl}
            objectFit="cover"
            style={StyleSheet.absoluteFill}
            mirror={!screenSharing}
            zOrder={1}
          />
        </View>
      )}
      {showOffPip && (
        <View style={styles.localPip} pointerEvents="none">
          <View style={styles.offPip}>
            <Icon name="videocam-off-outline" size={26} color="#fff" />
          </View>
        </View>
      )}
    </View>
  );
}

function ControlButton({ onPress, icon, label, color, active, accent, small, accessibilityLabel }) {
  const base = small ? styles.ctrlCircleS : styles.ctrlCircle;
  return (
    <TouchableOpacity onPress={onPress} style={styles.ctrlBtn} accessibilityLabel={accessibilityLabel}>
      <View style={[base, {
        backgroundColor: accent ? '#E53935' : (color || 'rgba(255,255,255,0.16)'),
      }, active && styles.ctrlActive]}>
        <Icon name={icon} size={small ? 19 : 24} color={(active && !color && !accent) ? '#0B0F14' : '#fff'} />
      </View>
    </TouchableOpacity>
  );
}

export default function VideoCallView({
  status,
  peerName,
  peerAvatar,
  localStream,
  remoteStream,
  cameraOn,
  screenSharing,
  micOn,
  remoteAudioOn,
  compact,
  onAccept,
  onDecline,
  onEnd,
  onSwitchCamera,
  onToggleCamera,
  onToggleMic,
  onToggleRemoteAudio,
  onToggleScreenShare,
  onMinimize,
  onExpand,
  theme,
}) {
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

  const small = !!compact;

  return (
    <View style={styles.fit}>
      <Peers
        localStream={localStream}
        remoteStream={remoteStream}
        peerAvatar={peerAvatar}
        peerName={peerName}
        theme={theme}
        cameraOn={cameraOn}
        screenSharing={screenSharing}
      />
      <View style={styles.topBar} pointerEvents="box-none">
        <View style={styles.statusChip}>
          <Text style={styles.topStatus}>
            {status === 'active' && remoteStream ? (screenSharing ? 'Sharing screen' : 'Video call') : 'Ringing…'}
          </Text>
        </View>
        {compact ? (
          <TouchableOpacity onPress={onExpand} style={styles.layoutBtn} accessibilityLabel="Expand call">
            <Icon name="chevron-up" size={22} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={onMinimize} style={styles.layoutBtn} accessibilityLabel="Minimize call">
            <Icon name="chevron-down" size={22} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
      <View style={[styles.controls, small && styles.controlsSmall]}>
        <ControlButton
          onPress={onSwitchCamera}
          icon="camera-reverse-outline"
          label="Flip"
          small={small}
          accessibilityLabel="Switch camera"
        />
        <ControlButton
          onPress={onToggleCamera}
          icon={cameraOn ? 'videocam' : 'videocam-off-outline'}
          label="Camera off"
          active={!cameraOn}
          small={small}
          accessibilityLabel="Toggle camera"
        />
        <ControlButton
          onPress={onToggleScreenShare}
          icon="laptop-outline"
          label="Share"
          active={screenSharing}
          small={small}
          accessibilityLabel="Toggle screen share"
        />
        <ControlButton
          onPress={onEnd}
          icon="call"
          label="End"
          color="#E53935"
          small={small}
          accessibilityLabel="End call"
        />
      </View>

      {/* Audio controls row: my-mic mute and LOCAL remote-audio mute (independent).
          Mutting "Remote audio" only silences THIS device's playback of the peer;
          the peer's microphone is never touched and keeps transmitting normally. */}
      <View style={[styles.voiceControls, small && styles.voiceControlsSmall]}>
        <ControlButton
          onPress={onToggleMic}
          icon={micOn ? 'mic' : 'mic-off-outline'}
          label="Mic"
          active={!micOn}
          small={small}
          accessibilityLabel="Toggle my microphone"
        />
        <ControlButton
          onPress={onToggleRemoteAudio}
          icon={remoteAudioOn ? 'volume-high' : 'volume-mute-outline'}
          label={remoteAudioOn ? 'Remote audio' : 'Remote muted'}
          accent={!remoteAudioOn}
          small={small}
          accessibilityLabel="Toggle remote audio locally"
        />
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
    elevation: 6,
    zIndex: 3,
  },
  scrTag: {
    position: 'absolute',
    top: 6,
    left: 6,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 3,
    gap: 4,
  },
  scrTagText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  offPip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,22,26,0.92)',
  },
  topBar: {
    position: 'absolute',
    top: 10,
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 4,
  },
  statusChip: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  topStatus: { color: '#fff', fontSize: 13, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  layoutBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 30,
    zIndex: 4,
    alignItems: 'flex-end',
  },
  controlsSmall: {
    bottom: 10,
    gap: 22,
  },
  voiceControls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 84,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 30,
    zIndex: 4,
    alignItems: 'flex-end',
  },
  voiceControlsSmall: {
    bottom: 62,
    gap: 24,
  },
  ctrlBtn: { alignItems: 'center' },
  ctrlCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  ctrlCircleS: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  ctrlActive: { backgroundColor: '#fff' },
  bigAvatar: { width: 120, height: 120, borderRadius: 60, alignSelf: 'center', marginTop: 60, alignItems: 'center', justifyContent: 'center', resizeMode: 'cover' },
  bigAvatarText: { color: '#fff', fontSize: 46, fontWeight: '700' },
  bigName: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 18 },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center', marginTop: 6 },
  incomingActions: { flexDirection: 'row', justifyContent: 'center', gap: 56, marginTop: 48 },
  bigBtn: { alignItems: 'center' },
  bigBtnCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  bigBtnLabel: { color: '#fff', fontSize: 13, marginTop: 8, fontWeight: '600' },
});