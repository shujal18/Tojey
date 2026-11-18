import React, { useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Image, StyleSheet, PanResponder, Dimensions,
  useWindowDimensions, StatusBar, Platform, Modal, Switch,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { Icon } from './AppIcon';
import { absUrl } from '../config';

// In-call video surface for Tojey. Rendered between the chat header and the
// existing Tojey text composer (which stays fully functional during a call).
// Audio is enabled. Mirroring is applied per STREAM: the local camera is shown
// mirrored like a selfie (screen share stays unmirrored) and the remote video is
// also mirrored, whether it sits in the fullscreen stage or the floating pip.
// The small preview is draggable anywhere on the stage and tapping it swaps the
// two: the pip stream expands to fullscreen and the main stream shrinks into the
// floater (WhatsApp-style). If the other stream is absent (peer not connected,
// or no remote yet) tapping the main surface swaps back so the state is never
// trapped. The remote stream keeps a non-rounded surface (SurfaceView cannot be
// rounded/clipped reliably on some Android versions) with an explicit
// zIndex/elevation so it always stacks above the main stream. Controls: flip
// camera, camera on/off, my-mic mute, local mute of the REMOTE audio (this device
// stops playing the other user - the peer is never muted), screen share, end.
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const PIP_W = 96;
const PIP_H = 132;
const PIP_MARGIN = 12;

function AvatarCircle({ uri, name, theme, size, textSize }) {
  const initial = (name || '?')[0].toUpperCase();
  if (uri) {
    return (
      <Image
        source={{ uri: absUrl(uri) }}
        style={{ width: size, height: size, borderRadius: size / 2, resizeMode: 'cover' }}
      />
    );
  }
  return (
    <View style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: (theme && theme.primary) || '#6C3CE9',
    }}>
      <Text style={{ color: '#fff', fontSize: textSize, fontWeight: '700' }}>{initial}</Text>
    </View>
  );
}

function DraggablePip({ streamUrl, mirror, off, avatar, name, theme, scrTag, onSwap, onDrag, bounds, enabled = true, children }) {
  const [pos, setPos] = useState({ x: SCREEN_W - PIP_W - PIP_MARGIN, y: 14 });
  const posRef = useRef(pos);
  const baseRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const clampX = (x) => {
    const max = Math.max(PIP_W + 8, (boundsRef.current ? boundsRef.current.width : SCREEN_W) - PIP_W - 4);
    return Math.min(Math.max(0, x), max);
  };
  const clampY = (y) => {
    const max = Math.max(PIP_H + 4, (boundsRef.current ? boundsRef.current.height : SCREEN_H) - PIP_H - 4);
    return Math.min(Math.max(0, y), max);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        baseRef.current = posRef.current;
        movedRef.current = false;
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) + Math.abs(g.dy) > 4) movedRef.current = true;
        const next = { x: clampX(baseRef.current.x + g.dx), y: clampY(baseRef.current.y + g.dy) };
        posRef.current = next;
        setPos(next);
        if (onDrag) onDrag(next);
      },
      onPanResponderRelease: (_, g) => {
        if (!movedRef.current && Math.abs(g.dx) + Math.abs(g.dy) <= 6) {
          if (onSwap) onSwap();
        }
      },
      onPanResponderTerminate: () => {},
    })
  ).current;

  if (!streamUrl && !off) return null;

  return (
    <View
      {...(enabled ? panResponder.panHandlers : {})}
      style={[styles.localPip, { left: pos.x, top: pos.y }]}
      accessibilityLabel={off ? 'Camera is off' : 'Video preview (tap to switch)'}
    >
      {scrTag && (
        <View style={styles.scrTag}>
          <Icon name="laptop-outline" size={13} color="#fff" />
          <Text style={styles.scrTagText}>Screen</Text>
        </View>
      )}
      {off ? (
        <View style={styles.offPip}>
          <AvatarCircle uri={avatar} name={name} theme={theme} size={40} textSize={18} />
        </View>
      ) : (
        <RTCView streamURL={streamUrl} objectFit="cover" style={StyleSheet.absoluteFill} mirror={mirror} zOrder={1} />
      )}
      {children}
    </View>
  );
}

function Peers({ localStream, remoteStream, peerAvatar, peerName, localAvatar, localName, theme, cameraOn, remoteCameraOn, screenSharing, remoteScreenSharing, cameraFacing, mainIsLocal, floating, controlActive, onControlTap, onControlSwipe, onSwapPip, onTapMain }) {
  const [stageSize, setStageSize] = useState(null);
  const controlRef = useRef({ stageSize, onControlTap, onControlSwipe, active: false });
  const localUrl = localStream ? localStream.toURL() : null;
  const remoteUrl = remoteStream ? remoteStream.toURL() : null;
  const localOff = !screenSharing && !cameraOn;
  const remoteOff = !remoteScreenSharing && !remoteCameraOn;

  const mainIsLocalSurface = mainIsLocal && !!localUrl;
  const mainUrl = mainIsLocalSurface ? localUrl : remoteUrl;
  const localMirror = cameraFacing === 'user' && !screenSharing;
  const remoteMirror = !remoteScreenSharing;
  const mainMirror = mainIsLocalSurface ? localMirror : remoteMirror;
  const mainIsScreen = mainIsLocalSurface ? screenSharing : remoteScreenSharing;
  const mainOff = mainIsLocalSurface ? localOff : remoteOff;
  const showMainOff = !!mainUrl && mainOff;
  const mainAvatar = mainIsLocalSurface ? localAvatar : peerAvatar;
  const mainName = mainIsLocalSurface ? localName : peerName;
  const canControl = !!controlActive && !!remoteScreenSharing && !mainIsLocalSurface && !floating;
  controlRef.current = { stageSize, onControlTap, onControlSwipe, active: canControl };

  const controlPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => controlRef.current.active,
    onMoveShouldSetPanResponder: () => controlRef.current.active,
    onPanResponderRelease: (_, g) => {
      const ref = controlRef.current;
      if (!ref.active) return;
      const size = ref.stageSize || { width: SCREEN_W, height: SCREEN_H };
      const norm = (x, y) => [
        Math.min(1, Math.max(0, x / (size.width || SCREEN_W))),
        Math.min(1, Math.max(0, y / (size.height || SCREEN_H))),
      ];
      const [sx, sy] = norm(g.x0, g.y0);
      if (Math.abs(g.dx) + Math.abs(g.dy) > 14) {
        const [ex, ey] = norm(g.moveX, g.moveY);
        if (ref.onControlSwipe) ref.onControlSwipe(sx, sy, ex, ey, 240);
      } else if (ref.onControlTap) {
        ref.onControlTap(sx, sy);
      }
    },
  })).current;

  const pipIsRemote = mainIsLocalSurface;
  const pipUrl = pipIsRemote ? remoteUrl : localUrl;
  const pipMirror = pipIsRemote ? remoteMirror : localMirror;
  const pipOff = pipIsRemote ? remoteOff : localOff;
  const pipScrTag = !pipIsRemote && screenSharing;
  const pipAvatar = pipIsRemote ? peerAvatar : localAvatar;
  const pipName = pipIsRemote ? peerName : localName;
  const showPip = !floating && (!!pipUrl || pipOff);

  return (
    <View
      style={styles.stage}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setStageSize({ width, height });
      }}
    >
      {mainUrl ? (
        <TouchableOpacity
          activeOpacity={1}
          onPress={!pipUrl && !pipOff ? onTapMain : undefined}
          style={StyleSheet.absoluteFill}
          accessibilityLabel="Switch video"
        >
          {!mainOff && (
            <RTCView streamURL={mainUrl} objectFit={mainIsScreen ? 'contain' : 'cover'} style={StyleSheet.absoluteFill} mirror={mainMirror} zOrder={0} />
          )}
          {canControl && <View style={StyleSheet.absoluteFill} {...controlPan.panHandlers} accessibilityLabel="Control shared screen" />}
          {screenSharing && mainIsLocalSurface && (
            <View style={styles.scrTagBig}>
              <Icon name="laptop-outline" size={14} color="#fff" />
              <Text style={styles.scrTagBigText}>Screen</Text>
            </View>
          )}
          {showMainOff && (
            <View style={styles.mainOff}>
              <AvatarCircle uri={mainAvatar} name={mainName} theme={theme} size={96} textSize={36} />
              <Text style={styles.mainOffLabel}>Camera off</Text>
            </View>
          )}
        </TouchableOpacity>
      ) : (
        <View style={[styles.waiting, { backgroundColor: '#101418' }]}>
          <AvatarCircle uri={mainAvatar} name={mainName} theme={theme} size={92} textSize={36} />
          <Text style={styles.waitingName}>{mainName}</Text>
          <Text style={styles.waitingHint}>
            {screenSharing ? 'Sharing your screen…' : (!mainIsLocalSurface && remoteOff ? 'Camera off' : 'Connecting…')}
          </Text>
        </View>
      )}
      {showPip && (
        <DraggablePip
          streamUrl={pipUrl}
          mirror={pipMirror}
          off={pipOff}
          avatar={pipAvatar}
          name={pipName}
          theme={theme}
          scrTag={pipScrTag}
          onSwap={onSwapPip}
          bounds={stageSize}
          enabled={!floating}
        />
      )}
    </View>
  );
}

function ControlButton({ onPress, icon, color, active, small, size, accessibilityLabel }) {
  const base = small ? styles.ctrlCircleS : styles.ctrlCircle;
  const diameter = size || (small ? 42 : 46);
  return (
    <TouchableOpacity onPress={onPress} style={styles.ctrlBtn} accessibilityLabel={accessibilityLabel}>
      <View style={[base, {
        width: diameter,
        height: diameter,
        borderRadius: diameter / 2,
        backgroundColor: color || 'rgba(255,255,255,0.16)',
      }, active && styles.ctrlActive]}>
        <Icon name={icon} size={small ? 19 : (diameter <= 44 ? 21 : 23)} color={(active && !color) ? '#0B0F14' : '#fff'} />
      </View>
    </TouchableOpacity>
  );
}

export default function VideoCallView({
  status,
  peerName,
  peerAvatar,
  localName = 'You',
  localAvatar = '',
  localStream,
  remoteStream,
  cameraOn,
  screenSharing,
  micOn,
  remoteAudioOn,
  compact,
  mainIsLocal = false,
  onSwapPip,
  onTapMain,
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
  remoteScreenSharing = false,
  remoteCameraOn = true,
  remoteShareOptions = {},
  controlEnabledHere = false,
  remoteControlGranted = false,
  onGrantRemoteControl,
  onControlTap,
  onControlSwipe,
  cameraFacing = 'user',
  floating = false,
  theme,
}) {
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [internalAudio, setInternalAudio] = useState(false);
  const [allowControl, setAllowControl] = useState(false);
  const { width: viewportWidth } = useWindowDimensions();

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

  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 44;
  const bottomInset = Platform.OS === 'ios' ? 34 : 20;
  const mainBtnSize = viewportWidth < 360 ? 44 : 46;
  const mainBtnGap = viewportWidth < 360 ? 8 : 10;
  const topOffset = floating ? 6 : topInset + 8;
  const controlsBottom = floating ? 8 : bottomInset + 12;
  const shareBadgeTop = topOffset + 44;

  const handleSharePress = () => {
    if (screenSharing) onToggleScreenShare();
    else setShareModalOpen(true);
  };
  const handleStartShare = () => {
    setShareModalOpen(false);
    onToggleScreenShare({ internalAudio, allowControl });
  };

  return (
    <View style={styles.fit}>
      <Peers
        localStream={localStream}
        remoteStream={remoteStream}
        peerAvatar={peerAvatar}
        peerName={peerName}
        localAvatar={localAvatar}
        localName={localName}
        theme={theme}
        cameraOn={cameraOn}
        remoteCameraOn={remoteCameraOn}
        screenSharing={screenSharing}
        remoteScreenSharing={remoteScreenSharing}
        cameraFacing={cameraFacing}
        mainIsLocal={mainIsLocal}
        floating={floating}
        controlActive={!!remoteShareOptions.allowControl && remoteControlGranted}
        onControlTap={onControlTap}
        onControlSwipe={onControlSwipe}
        onSwapPip={onSwapPip}
        onTapMain={onTapMain}
      />
      <View style={[styles.topBar, { top: topOffset }]} pointerEvents="box-none">
        {!floating && !compact && (
          <TouchableOpacity onPress={onMinimize} style={styles.layoutBtn} accessibilityLabel="Minimize call">
            <Icon name="chevron-down" size={22} color="#fff" />
          </TouchableOpacity>
        )}
        {!floating && (
          <View style={styles.statusChip}>
            <Text style={styles.topStatus}>
              {status === 'active' && remoteStream ? (screenSharing ? 'Sharing screen' : 'Video call') : 'Ringing…'}
            </Text>
          </View>
        )}
        {floating && (
          <TouchableOpacity onPress={onExpand} style={styles.layoutBtn} accessibilityLabel="Expand call">
            <Icon name="chevron-up" size={22} color="#fff" />
          </TouchableOpacity>
        )}
      </View>

      {!floating && (remoteScreenSharing || controlEnabledHere) && (remoteShareOptions.internalAudio || remoteShareOptions.allowControl || controlEnabledHere) && (
        <View style={[styles.shareBadge, { top: shareBadgeTop }]} pointerEvents="box-none">
          {controlEnabledHere && (
            <View style={styles.shareBadgeItem}>
              <Icon name="hand-left-outline" size={13} color="#fff" />
              <Text style={styles.shareBadgeText}>Control enabled</Text>
            </View>
          )}
          {remoteShareOptions.internalAudio && (
            <View style={styles.shareBadgeItem}>
              <Icon name="volume-high" size={13} color="#fff" />
              <Text style={styles.shareBadgeText}>Internal audio</Text>
            </View>
          )}
          {remoteShareOptions.allowControl && (
            <View style={styles.shareBadgeItem}>
              <Icon name="hand-left-outline" size={13} color="#fff" />
              <Text style={styles.shareBadgeText}>{remoteControlGranted ? 'Controlling' : 'Control allowed'}</Text>
            </View>
          )}
          {remoteScreenSharing && remoteShareOptions.allowControl && !remoteControlGranted && (
            <TouchableOpacity style={styles.controlGrantBtn} onPress={onGrantRemoteControl} accessibilityLabel="Grant remote control">
              <Text style={styles.controlGrantText}>Grant control</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {floating ? (
        <View style={styles.floatingControls}>
          <ControlButton
            onPress={onToggleMic}
            icon={micOn ? 'mic' : 'mic-off-outline'}
            active={!micOn}
            small
            accessibilityLabel="Toggle my microphone"
          />
          <ControlButton
            onPress={onEnd}
            icon="call"
            color="#E53935"
            small
            accessibilityLabel="End call"
          />
        </View>
      ) : (
        <View style={[styles.controls, { bottom: controlsBottom, gap: mainBtnGap, paddingHorizontal: viewportWidth < 340 ? 6 : 8 }]}>
          <ControlButton
            onPress={onSwitchCamera}
            icon="camera-reverse-outline"
            size={mainBtnSize}
            accessibilityLabel="Switch camera"
          />
          <ControlButton
            onPress={onToggleCamera}
            icon={cameraOn ? 'videocam' : 'videocam-off-outline'}
            active={!cameraOn}
            size={mainBtnSize}
            accessibilityLabel="Toggle camera"
          />
          <ControlButton
            onPress={onToggleMic}
            icon={micOn ? 'mic' : 'mic-off-outline'}
            active={!micOn}
            size={mainBtnSize}
            accessibilityLabel="Toggle my microphone"
          />
          <ControlButton
            onPress={onToggleRemoteAudio}
            icon={remoteAudioOn ? 'volume-high' : 'volume-mute-outline'}
            active={!remoteAudioOn}
            size={mainBtnSize}
            accessibilityLabel={remoteAudioOn ? 'Mute remote audio' : 'Unmute remote audio'}
          />
          <ControlButton
            onPress={handleSharePress}
            icon={screenSharing ? 'stop-circle-outline' : 'laptop-outline'}
            active={screenSharing}
            size={mainBtnSize}
            accessibilityLabel={screenSharing ? 'Stop screen share' : 'Share screen'}
          />
          <ControlButton
            onPress={onEnd}
            icon="call"
            color="#E53935"
            size={mainBtnSize}
            accessibilityLabel="End call"
          />
        </View>
      )}

      <Modal
        visible={shareModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setShareModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Share screen</Text>
            <View style={styles.modalOption}>
              <Text style={styles.modalOptionText}>Enable internal audio</Text>
              <Switch
                value={internalAudio}
                onValueChange={setInternalAudio}
                trackColor={{ false: 'rgba(255,255,255,0.25)', true: '#2E9E6B' }}
                thumbColor="#fff"
              />
            </View>
            <View style={styles.modalOption}>
              <Text style={styles.modalOptionText}>Allow other user to control my screen</Text>
              <Switch
                value={allowControl}
                onValueChange={setAllowControl}
                trackColor={{ false: 'rgba(255,255,255,0.25)', true: '#2E9E6B' }}
                thumbColor="#fff"
              />
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnGhost]}
                onPress={() => setShareModalOpen(false)}
                accessibilityLabel="Cancel screen share"
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnPrimary]}
                onPress={handleStartShare}
                accessibilityLabel="Start screen share"
              >
                <Text style={styles.modalBtnText}>Start</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  fit: { flex: 1, position: 'relative' },
  stage: { flex: 1, overflow: 'hidden' },
  waiting: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  waitingName: { color: '#fff', fontSize: 18, fontWeight: '600', marginTop: 14 },
  waitingHint: { color: 'rgba(255,255,255,0.55)', fontSize: 13, marginTop: 6 },
  localPip: {
    position: 'absolute',
    width: PIP_W,
    height: PIP_H,
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
  scrTagBig: {
    position: 'absolute',
    top: 14,
    left: 14,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  scrTagBigText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  offPip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#14161A',
  },
  mainOff: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#101418',
    zIndex: 2,
  },
  mainOffLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 13, fontWeight: '600', marginTop: 12 },
  topBar: {
    position: 'absolute',
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    zIndex: 4,
  },
  ctrlBtn: { alignItems: 'center' },
  floatingControls: {
    position: 'absolute', left: 0, right: 0, bottom: 8,
    flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center', zIndex: 5,
  },
  shareBadge: {
    position: 'absolute',
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    zIndex: 5,
  },
  shareBadgeItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  shareBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  controlGrantBtn: {
    backgroundColor: '#2E7DFF',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  controlGrantText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  ctrlCircle: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  ctrlCircleS: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  ctrlActive: { backgroundColor: '#fff' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#151A20',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingVertical: 10,
  },
  modalOptionText: { color: '#fff', fontSize: 14, flex: 1 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  modalBtnGhost: { backgroundColor: 'rgba(255,255,255,0.12)' },
  modalBtnPrimary: { backgroundColor: '#2E9E6B' },
  modalBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  bigAvatar: { width: 120, height: 120, borderRadius: 60, alignSelf: 'center', marginTop: 60, alignItems: 'center', justifyContent: 'center', resizeMode: 'cover' },
  bigAvatarText: { color: '#fff', fontSize: 46, fontWeight: '700' },
  bigName: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 18 },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center', marginTop: 6 },
  incomingActions: { flexDirection: 'row', justifyContent: 'center', gap: 56, marginTop: 48 },
  bigBtn: { alignItems: 'center' },
  bigBtnCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  bigBtnLabel: { color: '#fff', fontSize: 13, marginTop: 8, fontWeight: '600' },
});