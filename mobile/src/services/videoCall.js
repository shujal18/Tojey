import {
  mediaDevices,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';

// Video + audio call service. All media flows peer-to-peer over WebRTC; the
// server only relays signaling JSON.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Camera + microphone getUserMedia. Mic mute and "remote-audio mute" are purely
// local track toggles (see setMicMuted / setRemoteAudioEnabled below).
const LOCAL_CONSTRAINTS = {
  audio: true,
  video: {
    facingMode: 'user',
    width: 1280,
    height: 720,
    frameRate: 30,
  },
};

// Encoder profiles tuned for smooth motion. Camera keeps its framerate while
// screen sharing favours a balance of resolution and framerate at a higher bitrate.
const CAMERA_ENCODING = {
  maxBitrate: 2000000,
  maxFramerate: 30,
  scaleResolutionDownBy: 1,
  degradationPreference: 'MAINTAIN_FRAMERATE',
};
const SCREEN_ENCODING = {
  maxBitrate: 8000000,
  maxFramerate: 60,
  scaleResolutionDownBy: 1.35,
  degradationPreference: 'BALANCED',
};
const DISPLAY_CONSTRAINTS = {
  audio: true,
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60, max: 60 },
  },
};

let pc = null;
let localStream = null;
let screenStream = null;
let screenAudioTrack = null;
let remoteStream = null;
let pendingCandidates = [];
let addedCandidates = new Set();
let callbacks = {};
let micMuted = false;
let remoteAudioEnabled = true;
let videoFacing = 'user';
let screenShareOptions = { internalAudio: false, allowControl: false };

// Incoming-call handoff for WhatsApp-style auto-open: App.jsx catches the
// invite globally and calls storeInvite() before opening the chat; the mounted
// ChatRoomScreen consumes it with takeInvite() so the call UI appears even if
// the socket listener attached after the invite was delivered.
let pendingInvite = null;

export function storeInvite(invite) {
  pendingInvite = (invite && invite.callId && invite.callerId) ? invite : null;
}

export function takeInvite() {
  const p = pendingInvite;
  pendingInvite = null;
  return p;
}

export function getCameraFacing() {
  return videoFacing;
}

export function getLocalStream() {
  return localStream;
}

export function getRemoteStream() {
  return remoteStream;
}

export function getPeer() {
  return pc;
}

function applyRemoteAudioToStream(stream) {
  if (!stream || typeof stream.getAudioTracks !== 'function') return;
  const tracks = stream.getAudioTracks() || [];
  tracks.forEach((t) => {
    try {
      if (typeof t._setVolume === 'function') t._setVolume(remoteAudioEnabled ? 1 : 0);
      else t.enabled = remoteAudioEnabled;
    } catch (e) {
      try { t.enabled = remoteAudioEnabled; } catch (e2) {}
    }
  });
}

export function applyCallbacks(cb) {
  callbacks = cb || {};
  const origRemote = callbacks.onRemoteStream;
  callbacks.onRemoteStream = (stream) => {
    remoteStream = stream || remoteStream;
    applyRemoteAudioToStream(remoteStream);
    if (typeof origRemote === 'function') origRemote(stream);
  };
}

/**
 * Mutes/unmutes THIS device's microphone (what the other user hears).
 * Only toggles the LOCAL tracks that are being transmitted; the peer's state
 * is never touched and no signaling is sent.
 */
export function setMicMuted(muted) {
  micMuted = !!muted;
  if (localStream) {
    const tracks = localStream.getAudioTracks() || [];
    tracks.forEach((t) => { t.enabled = !micMuted; });
  }
}

export function isMicMuted() {
  return micMuted;
}

/**
 * Mutes/unmutes LOCAL playback of the remote participant's incoming audio.
 * Uses the received track's local volume control so the peer keeps transmitting
 * and their microphone state is untouched. No signaling / renegotiation.
 */
export function setRemoteAudioEnabled(enabled) {
  remoteAudioEnabled = !!enabled;
  applyRemoteAudioToStream(remoteStream);
}

export function isRemoteAudioEnabled() {
  return remoteAudioEnabled;
}

export function hasActiveCall() {
  return !!pc || !!localStream;
}

async function tuneSender(sender, profile) {
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
  try {
    const p = sender.getParameters();
    if (!p || !p.encodings || !p.encodings.length) return;
    // Build a plain update object: the native updater reads only the encodings
    // array and the degradation preference, and requires every encoding entry to
    // carry `active` + `rid`, so we never mutate the library classes directly.
    const encodings = p.encodings.map((e) => {
      const ej = typeof e.toJSON === 'function' ? e.toJSON() : e;
      return {
        active: ej.active === false ? false : true,
        rid: ej.rid || '',
        maxBitrate: profile.maxBitrate,
        maxFramerate: profile.maxFramerate,
        scaleResolutionDownBy: profile.scaleResolutionDownBy || 1,
      };
    });
    await sender.setParameters({
      encodings,
      degradationPreference: profile.degradationPreference || 'MAINTAIN_FRAMERATE',
    });
  } catch (e) {
    console.warn('tuneSender failed', e && e.message);
  }
}

export async function startLocalStream() {
  if (localStream) return localStream;
  const stream = await mediaDevices.getUserMedia(LOCAL_CONSTRAINTS);
  localStream = stream;
  return stream;
}

export function createPeerConnection() {
  if (pc) cleanupCall();
  pendingCandidates = [];
  addedCandidates = new Set();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate && callbacks.onIceCandidate) callbacks.onIceCandidate(e.candidate);
  };

  pc.ontrack = (e) => {
    const streams = e.streams && e.streams[0];
    if (callbacks.onRemoteStream) callbacks.onRemoteStream(streams || null);
  };

  const fireState = () => {
    if (callbacks.onConnectionState) callbacks.onConnectionState(String(pc.connectionState || 'new'));
  };
  pc.onconnectionstatechange = fireState;
  pc.oniceconnectionstatechange = fireState;

  if (localStream) {
    const tracks = localStream.getTracks();
    const senders = pc.getSenders().map((s) => (s.track ? s.track.kind : null));
    tracks.forEach((t) => {
      if (!senders.includes(t.kind)) pc.addTrack(t, localStream);
    });
  }
  const videoSender = pc.getSenders().find((s) => !!s.track && s.track.kind === 'video');
  if (videoSender) tuneSender(videoSender, CAMERA_ENCODING);
  return pc;
}

export async function createOffer() {
  if (!pc) throw new Error('No peer connection');
  const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);
  return pc.localDescription;
}

export async function acceptOffer(offer) {
  if (!pc) throw new Error('No peer connection');
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  await flushPendingCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return pc.localDescription;
}

export async function handleRemoteAnswer(answer) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
  await flushPendingCandidates();
}

// Candidates can arrive before the remote description is applied (the callee's
// ICE gathering may beat the answer over the socket). Queue instead of dropping,
// otherwise mobile/NAT calls connect audio-less or fail entirely.
export async function flushPendingCandidates() {
  if (!pc || !pc.remoteDescription || !pendingCandidates.length) return;
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(candidate);
      addedCandidates.add(`${candidate.sdpMid}:${candidate.sdpMLineIndex}`);
    } catch (e) {}
  }
}

export async function handleRemoteCandidate(candidate) {
  if (!pc) return;
  const key = `${candidate.sdpMid}:${candidate.sdpMLineIndex}`;
  if (addedCandidates.has(key)) return;          // dup-guard
  if (!pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    addedCandidates.add(key);
  } catch (e) {
    pendingCandidates.push(candidate);
  }
}

export function switchCamera() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  try {
    if (typeof track._switchCamera === 'function') track._switchCamera();
    else if (typeof track.switchCamera === 'function') track.switchCamera();
    videoFacing = videoFacing === 'user' ? 'environment' : 'user';
  } catch (e) {
    console.warn('switchCamera failed', e && e.message);
  }
}

export function setVideoEnabled(enabled) {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  try {
    track.enabled = !!enabled;
  } catch (e) {
    console.warn('setVideoEnabled failed', e && e.message);
  }
}

export function isVideoEnabled() {
  if (!localStream) return true;
  const track = localStream.getVideoTracks()[0];
  return !track || track.enabled !== false;
}

export function isScreenSharing() {
  return !!screenStream;
}

export function getScreenStream() {
  return screenStream;
}

export function getScreenShareOptions() {
  return screenShareOptions;
}

export async function startScreenShare(opts = {}) {
  if (!pc || !localStream) throw new Error('Start the camera call first');
  if (screenStream) return screenStream;

  const internalAudio = !!opts.internalAudio;
  screenShareOptions = {
    internalAudio,
    allowControl: !!opts.allowControl,
  };
  screenAudioTrack = null;

  let stream;
  try {
    stream = await mediaDevices.getDisplayMedia({
      ...DISPLAY_CONSTRAINTS,
      audio: internalAudio,
    });
  } catch (e) {
    screenShareOptions = { internalAudio: false, allowControl: false };
  screenAudioTrack = null;
    screenAudioTrack = null;
    throw e;
  }
  const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
  if (!track) {
    try {
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    screenShareOptions = { internalAudio: false, allowControl: false };
  screenAudioTrack = null;
    screenAudioTrack = null;
    throw new Error('Could not capture the screen');
  }

  try {
    if ('contentHint' in track) track.contentHint = 'detail';
  } catch (e) {}

  if (internalAudio) {
    try {
      const audioTrack = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
      const audioSender = pc.getSenders().find((s) => !!s.track && s.track.kind === 'audio');
      if (audioTrack && audioSender) {
        await audioSender.replaceTrack(audioTrack);
        screenAudioTrack = audioTrack;
      }
    } catch (e) {}
  }

  const videoSender = pc.getSenders().find((s) => !!s.track && s.track.kind === 'video');
  if (!videoSender) {
    try {
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    screenShareOptions = { internalAudio: false, allowControl: false };
  screenAudioTrack = null;
    screenAudioTrack = null;
    throw new Error('Video sender is not ready');
  }

  try {
    await videoSender.replaceTrack(track);
    await tuneSender(videoSender, SCREEN_ENCODING);
  } catch (e) {
    try { track.stop(); } catch (e2) {}
    try {
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    } catch (e3) {}
    screenShareOptions = { internalAudio: false, allowControl: false };
  screenAudioTrack = null;
    screenAudioTrack = null;
    throw e;
  }
  screenStream = stream;
  return screenStream;
}

export async function stopScreenShare() {
  if (!screenStream) return;
  const camTrack = localStream && localStream.getVideoTracks()[0];
  const videoSender = pc && pc.getSenders().find((s) => !!s.track && s.track.kind === 'video');
  try {
    if (videoSender && camTrack) await videoSender.replaceTrack(camTrack);
  } catch (e) {
    console.warn('replaceTrack back to camera failed', e && e.message);
  }
  if (videoSender && camTrack) await tuneSender(videoSender, CAMERA_ENCODING);
  if (screenAudioTrack) {
    try {
      const micTrack = localStream && localStream.getAudioTracks && localStream.getAudioTracks()[0];
      const audioSender = pc && pc.getSenders().find((s) => !!s.track && s.track.kind === 'audio');
      if (audioSender && micTrack) {
        await audioSender.replaceTrack(micTrack);
        micTrack.enabled = !micMuted;
      }
    } catch (e) {}
    screenAudioTrack = null;
  }
  try {
    if (screenStream && screenStream.getTracks) {
      screenStream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {}
  screenStream = null;
  screenShareOptions = { internalAudio: false, allowControl: false };
  screenAudioTrack = null;
}

export function cleanupCall() {
  if (screenStream) {
    try {
      if (screenStream.getTracks) screenStream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    screenStream = null;
  }
  if (localStream) {
    try {
      localStream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    localStream = null;
  }
  if (pc) {
    try {
      pc.close();
      pc.onicecandidate = null;
      pc.ontrack = null;
    } catch (e) {}
    pc = null;
  }
  remoteStream = null;
  pendingCandidates = [];
  addedCandidates = new Set();
  micMuted = false;
  remoteAudioEnabled = true;
  videoFacing = 'user';
  screenShareOptions = { internalAudio: false, allowControl: false };
  screenAudioTrack = null;
}