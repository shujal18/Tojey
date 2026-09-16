import {
  mediaDevices,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';

// Camera-only video call service (spec: NO microphone, NO audio). All media
// flows peer-to-peer over WebRTC; the server only relays signaling JSON.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Video-only getUserMedia: audio is never requested, so no mic permission is
// ever needed for video calls (camera permission only).
const LOCAL_CONSTRAINTS = {
  audio: false,
  video: {
    facingMode: 'user',
    width: 640,
    height: 480,
    frameRate: 24,
  },
};

let pc = null;
let localStream = null;
let callbacks = {};

export function getLocalStream() {
  return localStream;
}

export function getPeer() {
  return pc;
}

export function applyCallbacks(cb) {
  callbacks = cb || {};
}

export function hasActiveCall() {
  return !!pc || !!localStream;
}

export async function startLocalStream() {
  if (localStream) return localStream;
  const stream = await mediaDevices.getUserMedia(LOCAL_CONSTRAINTS);
  localStream = stream;
  return stream;
}

export function createPeerConnection() {
  if (pc) cleanupCall();
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
  return pc;
}

export async function createOffer() {
  if (!pc) throw new Error('No peer connection');
  const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
  await pc.setLocalDescription(offer);
  return pc.localDescription;
}

export async function acceptOffer(offer) {
  if (!pc) throw new Error('No peer connection');
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return pc.localDescription;
}

export async function handleRemoteAnswer(answer) {
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export async function handleRemoteCandidate(candidate) {
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn('addIceCandidate failed', e && e.message);
  }
}

export function switchCamera() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  try {
    if (typeof track._switchCamera === 'function') track._switchCamera();
    else if (typeof track.switchCamera === 'function') track.switchCamera();
  } catch (e) {
    console.warn('switchCamera failed', e && e.message);
  }
}

export function cleanupCall() {
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
  callbacks = {};
}