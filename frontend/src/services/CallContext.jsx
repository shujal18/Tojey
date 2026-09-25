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
  const [sharing, setSharing] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [incomingAfterOpen, setIncomingAfterOpen] = useState(null);

  const socketRef = useRef(socket);
  socketRef.current = socket;
  const stateRef = useRef('idle');
  const metaRef = useRef(null);
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;
  const streamRef = useRef(null);
  const noAnswerTimerRef = useRef(null);

  const updateState = (s) => { stateRef.current = s; setState(s); };
  const updateMeta = (m) => { metaRef.current = m; setCallMeta(m); };

  const clearStreams = () => {
    if (streamRef.current) streamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setMicMutedState(false);
    setVideoEnabledState(true);
    setRemoteAudible(true);
    setSharing(false);
  };

  const cleanup = useCallback((opts = {}) => {
    const { silentToast = false } = opts;
    if (noAnswerTimerRef.current) clearTimeout(noAnswerTimerRef.current);
    call.cleanupCall();
    clearStreams();
    updateMeta(null);
    if (!silentToast) updateState('idle');
  }, []);

  const endCall = useCallback((reason) => {
    const meta = metaRef.current;
    const s = stateRef.current;
    if (!meta || s === 'idle') return;
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
      },
      onConnectionState: (cs) => {
        if (cs === 'failed' || cs === 'closed') {
          if (stateRef.current === 'active' || stateRef.current === 'connecting') {
            showToast('Call ended');
            endCall();
          }
        }
      },
    });
  }, [endCall, showToast]);

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
        wireCallbacks();
        call.createPeerConnection();
        const answer = await call.acceptOffer(payload.offer);
        const peerId = metaRef.current?.callerId;
        if (peerId) socket.emit('video-call:answer', { targetUserId: peerId, callId: payload.callId, answer });
        updateState('active');
      } catch (e) {
        showToast('Could not start call');
        cleanup();
      }
    };

    const onAnswer = async (payload) => {
      const s = stateRef.current;
      if (s !== 'outgoing' && s !== 'connecting' && s !== 'active') return;
      try {
        await call.handleRemoteAnswer(payload.answer);
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
      updateState('ended');
      call.cleanupCall();
      clearStreams();
      setTimeout(() => updateState('idle'), 700);
    };

    socket.on('video-call:invite', onInvite);
    socket.on('video-call:accept', onAccept);
    socket.on('video-call:reject', onReject);
    socket.on('video-call:offer', onOffer);
    socket.on('video-call:answer', onAnswer);
    socket.on('video-call:ice-candidate', onCandidate);
    socket.on('video-call:end', onEnd);

    return () => {
      socket.off('video-call:invite', onInvite);
      socket.off('video-call:accept', onAccept);
      socket.off('video-call:reject', onReject);
      socket.off('video-call:offer', onOffer);
      socket.off('video-call:answer', onAnswer);
      socket.off('video-call:ice-candidate', onCandidate);
      socket.off('video-call:end', onEnd);
      call.clearCallbacks();
    };
  }, [socket, cleanup, endCall, showToast, wireCallbacks]);

  const beginOutgoingConnection = useCallback(async () => {
    const meta = metaRef.current;
    if (!meta) return;
    try {
      const stream = await call.startLocalStream();
      streamRef.current = stream;
      setLocalStream(stream);
      wireCallbacks();
      call.createPeerConnection();
      const offer = await call.createOffer();
      const sk = socketRef.current;
      if (sk && meta.calleeId) {
        sk.emit('video-call:offer', { targetUserId: meta.calleeId, callId: meta.callId, offer });
      }
      updateState('connecting');
    } catch (e) {
      showToast('Could not access the camera');
      cleanup();
    }
  }, [cleanup, showToast, wireCallbacks]);

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
  }, []);

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
    const next = !call.isVideoEnabled();
    call.setVideoEnabled(next);
    setVideoEnabledState(next);
  }, []);

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
      minimized, setMinimized, startCall, acceptCall, declineCall, endCall,
      toggleMic, toggleVideo, toggleRemoteAudio, toggleScreenShare, flipCamera,
    }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  return useContext(CallContext);
}