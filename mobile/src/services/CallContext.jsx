import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter, Dimensions, PanResponder, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import VideoCallView from '../components/VideoCallView';
import { ensureVideoCallPermission } from './permissions';
import {
  startLocalStream, createPeerConnection, applyCallbacks, createOffer, acceptOffer,
  handleRemoteAnswer, handleRemoteCandidate, cleanupCall, switchCamera,
  setVideoEnabled, startScreenShare, stopScreenShare, getScreenStream, getCameraFacing,
  setMicMuted, setRemoteAudioEnabled, takeInvite,
} from './videoCall';

const CallContext = createContext(null);

export function useCall() {
  return useContext(CallContext);
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const FLOAT_W = 136;
const FLOAT_H = 188;
const FLOAT_MARGIN = 10;

function FloatingCall({ onExpand, children }) {
  const [pos, setPos] = useState({ x: SCREEN_W - FLOAT_W - FLOAT_MARGIN, y: 88 });
  const baseRef = useRef({ x: 0, y: 0 });
  const movedRef = useRef(false);
  const maxX = Math.max(0, SCREEN_W - FLOAT_W - FLOAT_MARGIN);
  const maxY = Math.max(0, SCREEN_H - FLOAT_H - FLOAT_MARGIN);
  const clamp = (v, max) => Math.min(Math.max(0, v), max);
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      baseRef.current = pos;
      movedRef.current = false;
    },
    onPanResponderMove: (_, g) => {
      if (Math.abs(g.dx) + Math.abs(g.dy) > 4) movedRef.current = true;
      setPos({
        x: clamp(baseRef.current.x + g.dx, maxX),
        y: clamp(baseRef.current.y + g.dy, maxY),
      });
    },
    onPanResponderRelease: (_, g) => {
      if (!movedRef.current && Math.abs(g.dx) + Math.abs(g.dy) <= 6) onExpand();
    },
  })).current;
  return (
    <View
      style={[styles.floating, { left: pos.x, top: pos.y, width: FLOAT_W, height: FLOAT_H }]}
      accessibilityLabel="Floating call"
    >
      <View {...pan.panHandlers} style={styles.dragHandle}>
        <View style={styles.grabber} />
      </View>
      <View style={styles.floatBody}>{children}</View>
    </View>
  );
}

export function CallProvider({ socket, currentUser, children }) {
  const { theme } = useTheme();
  const [callStatus, setCallStatus] = useState('none');
  const [callLayout, setCallLayout] = useState('full');
  const [peer, setPeer] = useState(null);
  const [mainIsLocal, setMainIsLocal] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [incomingCaller, setIncomingCaller] = useState(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteAudioOn, setRemoteAudioOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState(null);
  const [cameraFacing, setCameraFacing] = useState('user');
  const [remoteScreenSharing, setRemoteScreenSharing] = useState(false);

  const statusRef = useRef('none');
  const callIdRef = useRef(null);
  const peerIdRef = useRef(null);
  const ringingRef = useRef(null);
  const wasConnectedRef = useRef(false);
  const screenSharingRef = useRef(false);

  const setCall = useCallback((s) => {
    statusRef.current = s;
    setCallStatus(s);
  }, []);

  const emitVideo = useCallback((event, payload) => {
    if (socket && socket.connected) socket.emit(event, payload);
  }, [socket]);

  const emitMediaState = useCallback((sharing, camera = true) => {
    if (!peerIdRef.current || !callIdRef.current) return;
    emitVideo('video-call:media-state', {
      targetUserId: peerIdRef.current,
      callId: callIdRef.current,
      cameraOn: camera !== false,
      screenSharing: !!sharing,
    });
  }, [emitVideo]);

  const pushCallMessage = useCallback((content, suffix) => {
    const callId = callIdRef.current;
    const targetUserId = peerIdRef.current;
    if (!callId || !targetUserId || !socket || !socket.connected) return;
    const clientId = `call-${callId}-${suffix}`;
    socket.emit('message:send', { otherUserId: targetUserId, type: 'CALL', content, clientId }, (ack) => {
      if (ack && ack.ok && ack.message) DeviceEventEmitter.emit('tojey:call-message', ack.message);
    });
  }, [socket]);

  const notify = useCallback((message) => {
    DeviceEventEmitter.emit('tojey:call-toast', message);
  }, []);

  const teardown = useCallback(() => {
    if (ringingRef.current) clearTimeout(ringingRef.current);
    ringingRef.current = null;
    callIdRef.current = null;
    peerIdRef.current = null;
    wasConnectedRef.current = false;
    screenSharingRef.current = false;
    cleanupCall();
    setPeer(null);
    setMainIsLocal(false);
    setCameraOn(true);
    setMicOn(true);
    setRemoteAudioOn(true);
    setScreenSharing(false);
    setScreenStream(null);
    setCameraFacing('user');
    setRemoteScreenSharing(false);
    setLocalStream(null);
    setRemoteStream(null);
    setIncomingCaller(null);
    setCallLayout('full');
    setCall('none');
  }, [setCall]);

  const endCall = useCallback(() => {
    const wasConnected = wasConnectedRef.current;
    if (peerIdRef.current && callIdRef.current) {
      emitVideo('video-call:end', { targetUserId: peerIdRef.current, callId: callIdRef.current });
    }
    pushCallMessage(wasConnected ? 'Call ended' : 'Missed video call', 'end');
    teardown();
  }, [emitVideo, pushCallMessage, teardown]);

  const startCall = useCallback(async (otherUser) => {
    if (statusRef.current !== 'none' || !otherUser || !otherUser.id) return;
    if (!socket || !socket.connected) return;
    try {
      if (!(await ensureVideoCallPermission())) {
        notify('Camera permission is required for video calls.');
        return;
      }
      const stream = await startLocalStream();
      const callId = `vc-${currentUser?.id || 0}-${Date.now()}`;
      await new Promise((resolve, reject) => {
        socket.emit('video-call:invite', { calleeId: otherUser.id, callId }, (res) => {
          if (res && res.ok) resolve();
          else reject(new Error((res && res.error) || 'invite failed'));
        });
      });
      callIdRef.current = callId;
      peerIdRef.current = otherUser.id;
      setPeer(otherUser);
      setLocalStream(stream);
      setCameraFacing(getCameraFacing());
      setCallLayout('full');
      setCall('outgoing');
      if (ringingRef.current) clearTimeout(ringingRef.current);
      ringingRef.current = setTimeout(() => {
        if (statusRef.current === 'outgoing') endCall();
      }, 30000);
    } catch (e) {
      cleanupCall();
      teardown();
      notify(e && e.message === 'offline' ? 'User is not online right now.' : 'Could not start the video call.');
    }
  }, [socket, currentUser, notify, setCall, endCall, teardown]);

  const acceptIncoming = useCallback(async () => {
    const inc = incomingCaller;
    if (!inc) return;
    try {
      if (!(await ensureVideoCallPermission())) {
        emitVideo('video-call:reject', { targetUserId: inc.callerId, callId: inc.callId });
        teardown();
        notify('Camera permission is required for video calls.');
        return;
      }
      const stream = await startLocalStream();
      callIdRef.current = inc.callId;
      peerIdRef.current = inc.callerId;
      setLocalStream(stream);
      setCameraFacing(getCameraFacing());
      setPeer(inc.caller || { id: inc.callerId, display_name: 'User' });
      createPeerConnection();
      setIncomingCaller(null);
      setCallLayout('full');
      setCall('active');
      emitVideo('video-call:accept', { targetUserId: inc.callerId, callId: inc.callId });
      pushCallMessage('Video call', 'start');
    } catch (e) {
      teardown();
      notify('Could not start the video call.');
    }
  }, [incomingCaller, emitVideo, teardown, notify, setCall, pushCallMessage]);

  const declineIncoming = useCallback(() => {
    const inc = incomingCaller;
    if (inc) emitVideo('video-call:reject', { targetUserId: inc.callerId, callId: inc.callId });
    pushCallMessage('Missed video call', 'end');
    teardown();
  }, [incomingCaller, emitVideo, pushCallMessage, teardown]);

  const headerCallPress = useCallback((otherUser) => {
    if (statusRef.current === 'incoming') declineIncoming();
    else if (statusRef.current !== 'none') {
      setCallLayout('full');
    } else startCall(otherUser);
  }, [declineIncoming, startCall]);

  const toggleCamera = useCallback(() => {
    if (statusRef.current === 'none') return;
    const next = !cameraOn;
    setVideoEnabled(next);
    setCameraOn(next);
    emitMediaState(screenSharingRef.current, next);
  }, [cameraOn, emitMediaState]);

  const toggleMic = useCallback(() => {
    if (statusRef.current === 'none') return;
    const next = !micOn;
    setMicMuted(!next);
    setMicOn(next);
  }, [micOn]);

  const toggleRemoteAudio = useCallback(() => {
    if (statusRef.current === 'none') return;
    const next = !remoteAudioOn;
    setRemoteAudioEnabled(next);
    setRemoteAudioOn(next);
  }, [remoteAudioOn]);

  const switchCameraSafe = useCallback(() => {
    if (statusRef.current === 'none' || screenSharingRef.current) return;
    switchCamera();
    setCameraFacing(getCameraFacing());
  }, []);

  const toggleScreenShare = useCallback(async () => {
    if (statusRef.current === 'none') return;
    if (screenSharingRef.current) {
      try { await stopScreenShare(); } catch (e) {}
      screenSharingRef.current = false;
      setScreenSharing(false);
      setScreenStream(null);
      emitMediaState(false, cameraOn);
    } else {
      try {
        const stream = await startScreenShare();
        if (!stream) throw new Error('could not capture');
        screenSharingRef.current = true;
        setScreenStream(getScreenStream());
        setScreenSharing(true);
        emitMediaState(true, cameraOn);
      } catch (e) {
        screenSharingRef.current = false;
        notify('Could not start screen share: ' + ((e && e.message) || 'unknown error'));
      }
    }
  }, [cameraOn, emitMediaState, notify]);

  useEffect(() => {
    if (!socket) return undefined;
    applyCallbacks({
      onIceCandidate: (candidate) => {
        if (peerIdRef.current && callIdRef.current) {
          emitVideo('video-call:ice-candidate', {
            targetUserId: peerIdRef.current,
            callId: callIdRef.current,
            candidate,
          });
        }
      },
      onRemoteStream: (stream) => setRemoteStream(stream),
      onConnectionState: (state) => {
        if (state === 'connected' || state === 'completed') {
          wasConnectedRef.current = true;
          if (ringingRef.current) clearTimeout(ringingRef.current);
        } else if (state === 'failed' || state === 'closed') {
          if (statusRef.current !== 'none') teardown();
        }
      },
    });

    const pending = takeInvite();
    if (pending && statusRef.current === 'none') {
      callIdRef.current = pending.callId;
      peerIdRef.current = pending.callerId;
      setIncomingCaller({ callId: pending.callId, callerId: pending.callerId, caller: pending.caller || null });
      setPeer(pending.caller || { id: pending.callerId, display_name: 'User' });
      setCall('incoming');
    }

    const hInvite = ({ callId, callerId, caller }) => {
      if (!callId || !callerId) return;
      if (statusRef.current !== 'none') {
        emitVideo('video-call:reject', { targetUserId: callerId, callId });
        return;
      }
      callIdRef.current = callId;
      peerIdRef.current = callerId;
      setIncomingCaller({ callId, callerId, caller: caller || null });
      setPeer(caller || { id: callerId, display_name: 'User' });
      setCall('incoming');
    };
    const hAccept = ({ callId }) => {
      if (callIdRef.current !== callId || statusRef.current !== 'outgoing') return;
      setCall('active');
      pushCallMessage('Video call', 'start');
      try {
        createPeerConnection();
        (async () => {
          const offer = await createOffer();
          if (peerIdRef.current && callIdRef.current && statusRef.current !== 'none') {
            emitVideo('video-call:offer', { targetUserId: peerIdRef.current, callId: callIdRef.current, offer });
          }
        })().catch(() => teardown());
      } catch (e) {
        teardown();
      }
    };
    const hReject = ({ callId }) => {
      if (callIdRef.current !== callId) return;
      if (statusRef.current === 'outgoing') {
        pushCallMessage('Missed video call', 'end');
        teardown();
      }
    };
    const hOffer = ({ callId, offer }) => {
      if (callIdRef.current !== callId || !offer) return;
      (async () => {
        const answer = await acceptOffer(offer);
        if (callIdRef.current === callId && peerIdRef.current && statusRef.current !== 'none') {
          emitVideo('video-call:answer', { targetUserId: peerIdRef.current, callId, answer });
        }
      })().catch(() => teardown());
    };
    const hAnswer = ({ callId, answer }) => {
      if (callIdRef.current !== callId || !answer) return;
      handleRemoteAnswer(answer).catch(() => {});
    };
    const hIce = ({ callId, candidate }) => {
      if (callIdRef.current !== callId || !candidate) return;
      handleRemoteCandidate(candidate);
    };
    const hEnd = ({ callId }) => {
      if (callIdRef.current !== callId) return;
      pushCallMessage(wasConnectedRef.current ? 'Call ended' : 'Missed video call', 'end');
      teardown();
    };
    const hMedia = ({ callId, screenSharing: remoteSharing }) => {
      if (callIdRef.current !== callId) return;
      setRemoteScreenSharing(!!remoteSharing);
    };
    const hDisconnect = () => {
      if (statusRef.current !== 'none') teardown();
    };

    socket.on('video-call:invite', hInvite);
    socket.on('video-call:accept', hAccept);
    socket.on('video-call:reject', hReject);
    socket.on('video-call:offer', hOffer);
    socket.on('video-call:answer', hAnswer);
    socket.on('video-call:ice-candidate', hIce);
    socket.on('video-call:end', hEnd);
    socket.on('video-call:media-state', hMedia);
    socket.on('disconnect', hDisconnect);
    return () => {
      socket.off('video-call:invite', hInvite);
      socket.off('video-call:accept', hAccept);
      socket.off('video-call:reject', hReject);
      socket.off('video-call:offer', hOffer);
      socket.off('video-call:answer', hAnswer);
      socket.off('video-call:ice-candidate', hIce);
      socket.off('video-call:end', hEnd);
      socket.off('video-call:media-state', hMedia);
      socket.off('disconnect', hDisconnect);
    };
  }, [socket, setCall, emitVideo, pushCallMessage, teardown]);

  const peerName = peer?.display_name || peer?.username || 'Unknown';
  const peerAvatar = peer?.profile_pic_url || '';
  const activeLocalStream = screenSharing && screenStream ? screenStream : localStream;
  const callProps = {
    status: callStatus,
    peerName,
    peerAvatar,
    localStream: activeLocalStream,
    remoteStream,
    cameraOn,
    micOn,
    remoteAudioOn,
    screenSharing,
    remoteScreenSharing,
    cameraFacing,
    mainIsLocal,
    theme,
    onAccept: acceptIncoming,
    onDecline: declineIncoming,
    onEnd: endCall,
    onSwitchCamera: switchCameraSafe,
    onToggleCamera: toggleCamera,
    onToggleMic: toggleMic,
    onToggleRemoteAudio: toggleRemoteAudio,
    onToggleScreenShare: toggleScreenShare,
    onSwapPip: () => setMainIsLocal((v) => !v),
    onTapMain: () => setMainIsLocal((v) => !v),
  };

  const value = {
    callStatus,
    startCall,
    headerCallPress,
    endCall,
    expandCall: () => setCallLayout('full'),
    minimizeCall: () => setCallLayout('floating'),
  };

  return (
    <CallContext.Provider value={value}>
      {children}
      {callStatus !== 'none' && callLayout === 'full' && (
        <View style={styles.fullOverlay} pointerEvents="auto">
          <VideoCallView {...callProps} onMinimize={() => setCallLayout('floating')} />
        </View>
      )}
      {callStatus !== 'none' && callStatus !== 'incoming' && callLayout === 'floating' && (
        <FloatingCall onExpand={() => setCallLayout('full')}>
          <VideoCallView {...callProps} floating compact onExpand={() => setCallLayout('full')} />
        </FloatingCall>
      )}
    </CallContext.Provider>
  );
}

const styles = StyleSheet.create({
  fullOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#101418',
    zIndex: 1000,
    elevation: 1000,
  },
  dragHandle: {
    height: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', zIndex: 3,
  },
  grabber: { width: 34, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.55)' },
  floatBody: { flex: 1 },
  floating: {
    position: 'absolute',
    backgroundColor: '#101418',
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    zIndex: 1000,
    elevation: 1000,
  },
});
