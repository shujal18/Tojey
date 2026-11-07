import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from './ChatContext';
import * as call from './call';

const CallContext = createContext();

// WebRTC call manager. Drives the whole call FSM (outgoing/incoming/active)
// over the shared socket using the same signaling events as the app.
export function CallProvider({ socket, currentUser, children }) {
  const { showToast } = useChat();
  const [state, setState] = useState('idle'); // idle | outgoing | incoming | connecting | active | ended
  const [callMeta, setCallMeta] = useState(null); // {callId, callerId, calleeId, other, caller}
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [micMuted, setMicMutedState] = useState(false);
  const [videoEnabled, setVideoEnabledState] = useState(true);
  const [remoteAudible, setRemoteAudible] = useState(true);
  const [remoteCameraOn, setRemoteCameraOn] = useState(true);
  const [remoteHasVideoTrack, setRemoteHasVideoTrack] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [callError, setCallError] = useState(null);
  const [incomingAfterOpen, setIncomingAfterOpen] = useState(null);

  const socketRef = useRef(socket);
  socketRef.current = socket;
  const stateRef = useRef('idle');
  const metaRef = useRef(null);
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const streamRef = useRef(null);
  const noAnswerTimerRef = useRef(null);
  const connectTimerRef = useRef(null);

  const clearTimers = () => {
    if (noAnswerTimerRef.current) clearTimeout(noAnswerTimerRef.current);
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    noAnswerTimerRef.current = null;
    connectTimerRef.current = null;
  };

  const updateState = (s) => { stateRef.current = s; setState(s); };
  const updateMeta = (m) => { metaRef.current = m; setCallMeta(m); };

  const clearStreams = () => {
    if (streamRef.current) streamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setRemoteHasVideoTrack(false);
    setRemoteCameraOn(true);
    setMicMutedState(false);
    setVideoEnabledState(true);
    setRemoteAudible(true);
    setSharing(false);
  };

  const cleanup = useCallback((opts = {}) => {
    const { silentToast = false } = opts;
    clearTimers();
    call.cleanupCall();
    clearStreams();
    updateMeta(null);
    setCallError(null);
    if (!silentToast) updateState('idle');
  }, []);

  const dismissError = useCallback(() => {
    setCallError(null);
    cleanup();
  }, [cleanup]);

  const failCall = useCallback((message) => {
    const meta = metaRef.current;
    const s = stateRef.current;
    clearTimers();
    const sk = socketRef.current;
    if (sk && meta && meta.callId && s !== 'idle') {
      const myId = currentUserRef.current?.id;
      const peerId = meta.callerId === myId ? meta.calleeId : meta.callerId;
      if (peerId) sk.emit('video-call:end', { targetUserId: peerId, callId: meta.callId });
    }
    call.cleanupCall();
    clearStreams();
    setCallError(message || 'Could not start the call');
    updateState('failed');
  }, []);

  // Tell the peer whether our camera is actually sending video, so their UI can
  // show "Camera off" instead of a black rectangle (camera denied, audio-only
  // fallback, or the user toggled the camera off).
  const sendMediaState = useCallback((cameraOn) => {
    const meta = metaRef.current;
    const sk = socketRef.current;
    const s = stateRef.current;
    if (!sk || !meta || !meta.callId || s === 'idle') return;
    const myId = currentUserRef.current?.id;
    const peerId = meta.callerId === myId ? meta.calleeId : meta.callerId;
    if (peerId) {
      sk.emit('video-call:media-state', { targetUserId: peerId, callId: meta.callId, cameraOn: !!cameraOn });
    }
  }, []);

  const endCall = useCallback((reason) => {
    const meta = metaRef.current;
    const s = stateRef.current;
    if (!meta || s === 'idle') return;
    clearTimers();
    const peerId = (s === 'outgoing' || s === 'active' || s === 'connecting') ? meta.calleeId : meta.callerId;
    const sk = socketRef.current;
    if (sk && peerId && meta.callId) {
      sk.emit('video-call:end', { targetUserId: peerId, callId: meta.callId });
    }
    updateState('ended');
    call.cleanupCall();
    clearStreams();
    setTimeout(() => updateState('idle'), 700);
  }, []);

  const wireCallbacks = useCallback(() => {
    const sk = socketRef.current;
    if (!sk) return;
    call.applyCallbacks({
      onIceCandidate: (candidate) => {
        const meta = metaRef.current;
        if (!meta || !meta.callId) return;
        const peerId = stateRef.current === 'outgoing' || stateRef.current === 'active' ? meta.calleeId : meta.callerId;
        sk.emit('video-call:ice-candidate', { targetUserId: peerId, callId: meta.callId, candidate });
      },
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setRemoteHasVideoTrack(!!(stream && stream.getVideoTracks().length > 0));
      },
      onConnectionState: (cs) => {
        // 'closed' is always initiated by our own teardown - ignore it. Only a
        // genuine ICE/peer failure should surface an explanation instead of the
        // call screen silently vanishing.
        if (cs === 'failed') {
          if (stateRef.current === 'active' || stateRef.current === 'connecting') {
            failCall('Connection failed — your network may block peer-to-peer calls');
          }
        }
      },
    });
  }, [endCall, failCall, showToast]);

  useEffect(() => {
    if (!socket) return;

    wireCallbacks();

    const onInvite = (payload) => {
      if (stateRef.current === 'active' || stateRef.current === 'outgoing' || stateRef.current === 'connecting') {
        socket.emit('video-call:reject', { targetUserId: payload.callerId, callId: payload.callId });
        return;
      }
      const caller = payload.caller || {};
      updateMeta({
        callId: payload.callId,
        callerId: payload.callerId,
        calleeId: currentUserRef.current?.id,
        caller,
        other: {
          id: payload.callerId,
          username: caller.username,
          display_name: caller.displayName || 'User',
          profile_pic_url: caller.profilePic || '',
        },
      });
      updateState('incoming');
    };

    const onAccept = (payload) => {
      if (stateRef.current !== 'outgoing') return;
      if (noAnswerTimerRef.current) clearTimeout(noAnswerTimerRef.current);
      beginOutgoingConnection();
    };

    const onReject = (payload) => {
      if (stateRef.current !== 'outgoing') return;
      showToast(`${metaRef.current?.other?.display_name || 'They'} declined`);
      cleanup();
    };

    const onOffer = async (payload) => {
      const s = stateRef.current;
      if (s !== 'incoming' && s !== 'connecting' && s !== 'active') return;
      try {
        const stream = await call.startLocalStream();
        streamRef.current = stream;
        setLocalStream(stream);
        setVideoEnabledState(stream.getVideoTracks().length > 0);
        wireCallbacks();
        call.createPeerConnection();
        const answer = await call.acceptOffer(payload.offer);
        const peerId = metaRef.current?.callerId;
        if (peerId) socket.emit('video-call:answer', { targetUserId: peerId, callId: payload.callId, answer });
        clearTimers();
        updateState('active');
        sendMediaState(stream.getVideoTracks().some((t) => t.enabled !== false));
      } catch (e) {
        failCall(e && e.message ? e.message : 'Could not access camera or microphone');
      }
    };

    const onAnswer = async (payload) => {
      const s = stateRef.current;
      if (s !== 'outgoing' && s !== 'connecting' && s !== 'active') return;
      try {
        await call.handleRemoteAnswer(payload.answer);
        clearTimers();
        updateState('active');
      } catch (e) {}
    };

    const onCandidate = (payload) => {
      if (payload.candidate && stateRef.current !== 'idle') {
        call.handleRemoteCandidate(payload.candidate).catch(() => {});
      }
    };

    const onEnd = (payload) => {
      if (stateRef.current === 'idle') return;
      clearTimers();
      updateState('ended');
      call.cleanupCall();
      clearStreams();
      setTimeout(() => updateState('idle'), 700);
    };

    const onMediaState = (payload) => {
      if (!payload) return;
      if (payload.callId && metaRef.current?.callId && payload.callId !== metaRef.current.callId) return;
      setRemoteCameraOn(payload.cameraOn !== false);
    };

    socket.on('video-call:invite', onInvite);
    socket.on('video-call:accept', onAccept);
    socket.on('video-call:reject', onReject);
    socket.on('video-call:offer', onOffer);
    socket.on('video-call:answer', onAnswer);
    socket.on('video-call:ice-candidate', onCandidate);
    socket.on('video-call:end', onEnd);
    socket.on('video-call:media-state', onMediaState);

    return () => {
      socket.off('video-call:invite', onInvite);
      socket.off('video-call:accept', onAccept);
      socket.off('video-call:reject', onReject);
      socket.off('video-call:offer', onOffer);
      socket.off('video-call:answer', onAnswer);
      socket.off('video-call:ice-candidate', onCandidate);
      socket.off('video-call:end', onEnd);
      socket.off('video-call:media-state', onMediaState);
      call.clearCallbacks();
    };
  }, [socket, cleanup, endCall, showToast, wireCallbacks, sendMediaState]);

  const beginOutgoingConnection = useCallback(async () => {
    const meta = metaRef.current;
    if (!meta) return;
    try {
      const stream = await call.startLocalStream();
      streamRef.current = stream;
      setLocalStream(stream);
      setVideoEnabledState(stream.getVideoTracks().length > 0);
      wireCallbacks();
      call.createPeerConnection();
      const offer = await call.createOffer();
      const sk = socketRef.current;
      if (sk && meta.calleeId) {
        sk.emit('video-call:offer', { targetUserId: meta.calleeId, callId: meta.callId, offer });
      }
      updateState('connecting');
      sendMediaState(stream.getVideoTracks().some((t) => t.enabled !== false));
      if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
      connectTimerRef.current = setTimeout(() => {
        if (stateRef.current === 'connecting') {
          failCall('Could not connect — check your network');
        }
      }, 25000);
    } catch (e) {
      failCall(e && e.message ? e.message : 'Could not access camera or microphone');
    }
  }, [failCall, wireCallbacks]);

  const startCall = useCallback((otherUser) => {
    if (stateRef.current !== 'idle' || !socketRef.current) return;
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    updateMeta({ callId, calleeId: otherUser.id, callerId: currentUserRef.current?.id, other: otherUser, caller: null });
    updateState('outgoing');
    noAnswerTimerRef.current = setTimeout(() => {
      if (stateRef.current === 'outgoing') {
        showToast('No answer');
        cleanup();
      }
    }, 30000);
    socketRef.current.emit('video-call:invite', { calleeId: otherUser.id, callId }, (ack) => {
      if (ack && ack.error) {
        if (noAnswerTimerRef.current) clearTimeout(noAnswerTimerRef.current);
        showToast(ack.error === 'offline' ? `${otherUser.display_name || 'They'} is offline` : ack.error);
        cleanup();
      }
    });
  }, [cleanup, showToast]);

  const acceptCall = useCallback(() => {
    const meta = metaRef.current;
    if (!meta || !socketRef.current) return;
    updateState('connecting');
    socketRef.current.emit('video-call:accept', { targetUserId: meta.callerId, callId: meta.callId });
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = setTimeout(() => {
      if (stateRef.current === 'connecting') {
        failCall('Could not connect — the other side did not respond');
      }
    }, 25000);
  }, [failCall]);

  const declineCall = useCallback(() => {
    const meta = metaRef.current;
    if (meta && socketRef.current) {
      socketRef.current.emit('video-call:reject', { targetUserId: meta.callerId, callId: meta.callId });
    }
    cleanup();
  }, [cleanup]);

  const toggleMic = useCallback(() => {
    const next = !call.isMicMuted();
    call.setMicMuted(next);
    setMicMutedState(next);
  }, []);

  const toggleVideo = useCallback(() => {
    const stream = call.getLocalStream();
    const hasVideo = !!(stream && stream.getVideoTracks().length > 0);
    const next = hasVideo ? !call.isVideoEnabled() : false;
    call.setVideoEnabled(next);
    setVideoEnabledState(next);
    sendMediaState(next && hasVideo);
  }, [sendMediaState]);

  const toggleRemoteAudio = useCallback(() => {
    const next = !call.isRemoteAudioEnabled();
    call.setRemoteAudioEnabled(next);
    setRemoteAudible(next);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    try {
      if (call.isScreenSharing()) {
        await call.stopScreenShare();
        setSharing(false);
      } else {
        await call.startScreenShare();
        setSharing(true);
      }
    } catch (e) {
      showToast(e.message || 'Screen share unavailable');
    }
  }, [showToast]);

  const flipCamera = useCallback(async () => {
    try {
      await call.flipCamera();
    } catch (e) {}
  }, []);

  return (
    <CallContext.Provider value={{
      state, callMeta, localStream, remoteStream, micMuted, videoEnabled, remoteAudible, sharing,
      remoteCameraOn, remoteHasVideoTrack,
      minimized, setMinimized, callError, startCall, acceptCall, declineCall, endCall, dismissError,
      toggleMic, toggleVideo, toggleRemoteAudio, toggleScreenShare, flipCamera,
    }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  return useContext(CallContext);
}