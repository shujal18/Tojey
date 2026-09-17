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
    frameRate: 30,
  },
};

// Encoder profiles tuned for smooth motion. Both force the WebRTC CPU/network
// adapter to keep the frame rate and lower the resolution instead (so calls and
// screen shares stay fluid on weak devices instead of dropping to a slideshow).
const CAMERA_ENCODING = { maxBitrate: 900000, maxFramerate: 30 };
const SCREEN_ENCODING = { maxBitrate: 2500000, maxFramerate: 30 };

let pc = null;
let localStream = null;
let screenStream = null;
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
      };
    });
    await sender.setParameters({
      encodings,
      degradationPreference: 'MAINTAIN_FRAMERATE',
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

export async function startScreenShare() {
  if (!pc || !localStream) throw new Error('Start the camera call first');
  if (screenStream) return screenStream;

  const stream = await mediaDevices.getDisplayMedia();
  const track = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
  if (!track) {
    try {
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    throw new Error('Could not capture the screen');
  }

  const videoSender = pc.getSenders().find((s) => !!s.track && s.track.kind === 'video');
  if (!videoSender) {
    try {
      track.stop();
    } catch (e) {}
    throw new Error('Video sender is not ready');
  }

  await videoSender.replaceTrack(track);
  await tuneSender(videoSender, SCREEN_ENCODING);
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
  try {
    if (screenStream && screenStream.getTracks) {
      screenStream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {}
  screenStream = null;
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
  callbacks = {};
}