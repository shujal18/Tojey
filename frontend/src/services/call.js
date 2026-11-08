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
let pendingCandidates = [];
let addedCandidates = new Set();
let callbacks = {};
let micMuted = false;
let remoteAudioEnabled = true;
let videoFacing = 'user';
let originalVideoTrack = null;   // NEW: remember the camera track before screen share

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

// Audio-only fallback (camera denied / unavailable) still needs a video m-line
// with send direction so later "Camera on" can swap a real camera in without a
// full renegotiation (and so peers receive a stream object that carries video).
function makePlaceholderVideoTrack() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const stream = canvas.captureStream(30);
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (track) track.enabled = true;
    return track || null;
  } catch (e) {
    return null;
  }
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
    // Respect the user's remote-audio choice for tracks that arrive later.
    if (e.track.kind === 'audio') e.track.enabled = remoteAudioEnabled;
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
    if (localStream.getVideoTracks().length === 0) {
      const placeholder = makePlaceholderVideoTrack();
      if (placeholder) pc.addTrack(placeholder, new MediaStream([placeholder]));
    }
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
  await flushPendingCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return pc.localDescription;
}

export async function handleRemoteAnswer(answer) {
  if (!pc) return;
  await pc.setRemoteDescription(answer);
  await flushPendingCandidates();
}

// Candidates can arrive before the remote description is applied (the callee's
// ICE gathering may beat the answer over the socket). Queue instead of dropping,
// otherwise mobile/NAT calls connect audio-less or fail entirely.
async function flushPendingCandidates() {
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
  if (addedCandidates.has(key)) return;          // dup‑guard
  if (!pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
    addedCandidates.add(key);
  } catch (e) {
    pendingCandidates.push(candidate);
  }
}

function findVideoSender() {
  if (!pc) return null;
  const direct = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
  if (direct) return direct;
  const transceiver = pc.getTransceivers().find((t) =>
    t.sender
    && (!t.sender.track || t.sender.track.kind === 'video')
    && t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
  return transceiver ? transceiver.sender : null;
}

// Acquire a camera track for a call that started audio-only (camera denied or
// unavailable) and attach it to the existing video sender.
export async function startCameraTrack() {
  if (!localStream) throw new Error('No local stream');
  const existing = localStream.getVideoTracks()[0];
  if (existing) {
    existing.enabled = true;
    return existing;
  }
  const camStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: videoFacing,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  });
  const track = camStream.getVideoTracks()[0];
  if (!track) throw new Error('Camera unavailable');
  localStream.addTrack(track);
  if (pc) {
    const sender = findVideoSender();
    if (sender) await sender.replaceTrack(track);
    else pc.addTrack(track, localStream);
  }
  return track;
}

// Browsers usually ignore facingMode updates, so re-request the camera and swap
// the sender's track (no renegotiation needed).
export async function flipCamera() {
  if (!localStream) return null;
  const current = localStream.getVideoTracks()[0];
  if (!current) return startCameraTrack();
  const nextFacing = videoFacing === 'user' ? 'environment' : 'user';
  const camStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: nextFacing,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  });
  const track = camStream.getVideoTracks()[0];
  if (!track) throw new Error('Camera unavailable');
  if (pc) {
    const sender = findVideoSender();
    if (sender) await sender.replaceTrack(track);
  }
  try { localStream.removeTrack(current); } catch (e) {}
  try { current.stop(); } catch (e) {}
  localStream.addTrack(track);
  videoFacing = nextFacing;
  return localStream;
}

export function isScreenSharing() { return !!screenStream; }

export async function startScreenShare() {
  if (!pc || !localStream) throw new Error('Start the camera call first');
  if (screenStream) return screenStream;

  // NEW: remember the current camera track so we can restore it later
  const existingSender = pc.getSenders().find(s => !!s.track && s.track.kind === 'video');
  originalVideoTrack = existingSender?.track;

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
  // NEW: restore the original camera track if it was saved
  if (originalVideoTrack) {
    try {
      const sender = pc.getSenders().find(s => !!s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(originalVideoTrack);
    } catch (e) {}
    originalVideoTrack = null;
  }
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
  pendingCandidates = [];
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