// Video + audio call service. All media flows peer-to-peer over WebRTC; the
// server only relays signaling JSON. Mirrors the app's videoCall.js.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const LOCAL_CONSTRAINTS = {
  audio: true,
  video: {
    facingMode: 'user',
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30 },
  },
};

let pc = null;
let localStream = null;
let screenStream = null;
let remoteStream = null;
let callbacks = {};
let micMuted = false;
let remoteAudioEnabled = true;
let videoFacing = 'user';

export function applyCallbacks(cb) {
  callbacks = cb || {};
}

export function getLocalStream() { return localStream; }
export function getRemoteStream() { return remoteStream; }
export function getPeer() { return pc; }

export function setMicMuted(muted) {
  micMuted = !!muted;
  if (localStream) {
    (localStream.getAudioTracks() || []).forEach(t => { t.enabled = !micMuted; });
  }
}

export function isMicMuted() { return micMuted; }

export function setRemoteAudioEnabled(enabled) {
  remoteAudioEnabled = !!enabled;
  if (remoteStream) {
    (remoteStream.getAudioTracks() || []).forEach(t => { t.enabled = remoteAudioEnabled; });
  }
}

export function isRemoteAudioEnabled() { return remoteAudioEnabled; }

export function setVideoEnabled(enabled) {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (track) track.enabled = !!enabled;
}

export function isVideoEnabled() {
  if (!localStream) return true;
  const track = localStream.getVideoTracks()[0];
  return !track || track.enabled !== false;
}

export function hasActiveCall() {
  return !!pc || !!localStream;
}

export async function startLocalStream() {
  if (localStream) return localStream;
  const stream = await navigator.mediaDevices.getUserMedia(LOCAL_CONSTRAINTS);
  localStream = stream;
  return stream;
}

export function createPeerConnection() {
  if (pc) cleanupCallButKeepStream();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate && callbacks.onIceCandidate) callbacks.onIceCandidate(e.candidate);
  };

  pc.ontrack = (e) => {
    const streams = e.streams && e.streams[0];
    if (streams) remoteStream = streams;
    if (callbacks.onRemoteStream) callbacks.onRemoteStream(streams || null);
  };

  const fireState = () => {
    if (callbacks.onConnectionState) callbacks.onConnectionState(String(pc.connectionState || 'new'));
  };
  pc.onconnectionstatechange = fireState;
  pc.oniceconnectionstatechange = fireState;
  pc.onsignalingstatechange = fireState;

  if (localStream) {
    const kinds = new Set(pc.getSenders().map(s => (s.track ? s.track.kind : null)));
    localStream.getTracks().forEach(t => {
      if (!kinds.has(t.kind)) pc.addTrack(t, localStream);
    });
  }
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
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return pc.localDescription;
}

export async function handleRemoteAnswer(answer) {
  if (!pc) return;
  await pc.setRemoteDescription(answer);
}

export async function handleRemoteCandidate(candidate) {
  if (!pc) return;
  try {
    await pc.addIceCandidate(candidate);
  } catch (e) {}
}

// Browsers can't switch cameras without re-requesting; try constraints where supported.
export async function flipCamera() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  videoFacing = videoFacing === 'user' ? 'environment' : 'user';
  try {
    await track.applyConstraints({ facingMode: videoFacing });
  } catch (e) {}
}

export function isScreenSharing() { return !!screenStream; }

export async function startScreenShare() {
  if (!pc || !localStream) throw new Error('Start the camera call first');
  if (screenStream) return screenStream;

  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
  if (!track) {
    try { if (stream && stream.getTracks) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    throw new Error('Could not capture the screen');
  }

  const videoSender = pc.getSenders().find(s => !!s.track && s.track.kind === 'video');
  if (!videoSender) {
    try { track.stop(); } catch (e) {}
    throw new Error('Video sender is not ready');
  }

  await videoSender.replaceTrack(track);
  screenStream = stream;
  stream.getVideoTracks()[0].onended = () => { stopScreenShare(); };
  return screenStream;
}

export async function stopScreenShare() {
  if (!screenStream) return;
  const camTrack = localStream && localStream.getVideoTracks()[0];
  const videoSender = pc && pc.getSenders().find(s => !!s.track && s.track.kind === 'video');
  try {
    if (videoSender && camTrack) await videoSender.replaceTrack(camTrack);
  } catch (e) {}
  try {
    if (screenStream && screenStream.getTracks) screenStream.getTracks().forEach(t => t.stop());
  } catch (e) {}
  screenStream = null;
}

function cleanupCallButKeepStream() {
  if (screenStream) {
    try { screenStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    screenStream = null;
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
  remoteAudioEnabled = true;
  callbacks = {};
}

export function cleanupCall() {
  cleanupCallButKeepStream();
  if (localStream) {
    try {
      localStream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    localStream = null;
  }
  micMuted = false;
  remoteAudioEnabled = true;
  videoFacing = 'user';
}