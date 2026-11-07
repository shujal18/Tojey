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
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera and microphone need a secure (HTTPS) connection');
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia(LOCAL_CONSTRAINTS);
  } catch (e) {
    // Camera unavailable/denied: fall back to audio-only so the call can still work.
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  return localStream;
}

export function createPeerConnection() {
  if (pc) cleanupCallButKeepStream();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate && callbacks.onIceCandidate) callbacks.onIceCandidate(e.candidate);
  };

  pc.ontrack = (e) => {
    // Build one persistent remote stream from the incoming tracks. Some browsers
    // (notably iOS Safari) deliver an empty e.streams array, which previously
    // left the remote video permanently blank.
    if (!remoteStream) remoteStream = new MediaStream();
    try {
      const already = remoteStream.getTracks().some((t) => t.id === e.track.id);
      if (!already) remoteStream.addTrack(e.track);
    } catch (err) {
      // Fall back to the signalled stream if the tracks can't be added.
      if (e.streams && e.streams[0]) remoteStream = e.streams[0];
    }
    if (callbacks.onRemoteStream) callbacks.onRemoteStream(remoteStream);
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
}

export function clearCallbacks() {
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