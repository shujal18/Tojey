import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import RNFetchBlob from 'rn-fetch-blob';

let recorder = null;
let player = null;
let currentPath = null;
let recordingActive = false;
let recordingPaused = false;
let recordingStartedAt = 0;
let recordingPausedAt = 0;
let recordingPausedMs = 0;
let playbackToken = 0;

const AUDIO_SET = {
  OutputFormatAndroid: 2,
  AudioEncoderAndroid: 3,
  AudioSamplingRateAndroid: 44100,
  AudioChannelsAndroid: 1,
  AudioEncodingBitRateAndroid: 64000,
};

function getRecorder() {
  if (!recorder) recorder = new AudioRecorderPlayer();
  return recorder;
}

function getPlayer() {
  if (!player) player = new AudioRecorderPlayer();
  return player;
}

function toPath(uri) {
  if (!uri) return null;
  return String(uri).replace(/^file:\/\//, '');
}

function toPlayableUri(uri) {
  if (!uri) return '';
  const value = String(uri);
  if (value.startsWith('file://') || /^https?:\/\//.test(value)) return value;
  if (value.startsWith('/')) return `file://${value}`;
  return value;
}

export function parseDuration(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return 0;
    return value > 86400 ? value / 1000 : value;
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?\s*ms$/i.test(text)) return parseFloat(text) / 1000;
  if (/^\d+(\.\d+)?\s*s$/i.test(text)) return parseFloat(text);
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 86400 ? n / 1000 : n;
  }
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

export function parseDurationMs(value) {
  if (typeof value === 'number' && value > 0 && value <= 86400) return value * 1000;
  return Math.round(parseDuration(value) * 1000);
}

export function voiceErrorMessage(error) {
  const text = String((error && (error.message || error)) || '');
  if (/permission|denied|authorize|security|not allowed/i.test(text)) {
    return 'Microphone permission was denied. Allow microphone access in system settings, then try again.';
  }
  return text || 'Unknown audio error';
}

function meteringLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0.08;
  if (n > 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return n / 100;
  if (n < 0 && n >= -160) return Math.min(1, Math.max(0, (n + 160) / 160));
  return null;
}

function recordingElapsedMs() {
  if (!recordingActive) return recordingPausedMs;
  if (recordingPaused) return recordingPausedMs;
  const base = recordingPausedMs || 0;
  const start = recordingStartedAt || Date.now();
  return Math.max(0, base + (Date.now() - start));
}

export async function startVoiceRecording() {
  const r = getRecorder();
  try {
    await r.stopRecorder();
  } catch (e) {}
  try {
    r.removeRecordBackListener();
  } catch (e) {}
  const name = `voice_${Date.now()}.m4a`;
  const path = `${RNFetchBlob.fs.dirs.CacheDir}/${name}`;
  try {
    await r.setSubscriptionDuration(0.1);
  } catch (e) {}
  await r.startRecorder(path, AUDIO_SET, true);
  currentPath = path;
  recordingActive = true;
  recordingPaused = false;
  recordingPausedMs = 0;
  recordingStartedAt = Date.now();
  recordingPausedAt = 0;
  return { path, name };
}

export function trackVoiceRecording(cb) {
  const r = getRecorder();
  const handler = (event) => {
    if (!recordingActive) return;
    const nativePosition = Number(event && event.currentPosition);
    const elapsedMs = Number.isFinite(nativePosition) && nativePosition > 0
      ? nativePosition
      : recordingElapsedMs();
    const metering = Number(event && event.currentMetering);
    const level = meteringLevel(event && event.currentMetering);
    if (typeof cb === 'function') {
      cb({
        currentPosition: elapsedMs,
        elapsedMs,
        currentMetering: Number.isFinite(metering) ? metering : 0,
        level,
        hasMetering: level != null,
        isRecording: !recordingPaused && event && event.isRecording !== false,
        isPaused: recordingPaused,
      });
    }
  };
  r.addRecordBackListener(handler);
  return () => {
    try {
      r.removeRecordBackListener();
    } catch (e) {}
  };
}

export async function pauseVoiceRecording() {
  if (!recordingActive || recordingPaused) return;
  const r = getRecorder();
  recordingPausedMs = recordingElapsedMs();
  await r.pauseRecorder();
  recordingPaused = true;
  recordingPausedAt = Date.now();
}

export async function resumeVoiceRecording() {
  if (!recordingActive || !recordingPaused) return;
  const r = getRecorder();
  await r.resumeRecorder();
  recordingStartedAt = Date.now();
  recordingPaused = false;
  recordingPausedAt = 0;
}

export function getVoiceRecordingElapsedMs() {
  return recordingElapsedMs();
}

export async function stopVoiceRecording() {
  const r = getRecorder();
  const durationMs = recordingElapsedMs();
  let uri = null;
  try {
    uri = await r.stopRecorder();
  } catch (e) {
    console.warn('stopRecorder failed', e);
    try {
      await r.pauseRecorder();
    } catch (inner) {}
  }
  try {
    r.removeRecordBackListener();
  } catch (e) {}
  const path = toPath(uri || currentPath);
  recordingActive = false;
  recordingPaused = false;
  recordingPausedMs = 0;
  recordingStartedAt = 0;
  recordingPausedAt = 0;
  currentPath = null;
  return {
    path,
    durationMs,
    durationSec: Math.max(1, Math.round(durationMs / 1000)),
  };
}

export async function deleteVoiceFile(filePath) {
  if (!filePath) return;
  try {
    const p = toPath(filePath);
    if (p && await RNFetchBlob.fs.exists(p)) {
      await RNFetchBlob.fs.unlink(p);
    }
  } catch (e) {
    console.warn('deleteVoice failed', e);
  }
}

export async function playVoice(url, cb, headers) {
  const p = getPlayer();
  const token = ++playbackToken;
  try {
    await p.stopPlayer();
  } catch (e) {}
  try {
    p.removePlayBackListener();
  } catch (e) {}
  try {
    await p.setSubscriptionDuration(0.1);
  } catch (e) {}
  p.addPlayBackListener((event) => {
    if (token !== playbackToken) return;
    const rawDuration = event && event.duration;
    const rawPosition = event && event.currentPosition;
    const durationMs = typeof rawDuration === 'number' ? Math.max(0, rawDuration) : parseDurationMs(rawDuration);
    const positionMs = typeof rawPosition === 'number' ? Math.max(0, rawPosition) : parseDurationMs(rawPosition);
    if (typeof cb === 'function') {
      cb({
        durationMs,
        positionMs,
        isFinished: !!(event && event.isFinished),
        durationSec: durationMs / 1000,
        positionSec: positionMs / 1000,
      });
    }
  });
  await p.startPlayer(toPlayableUri(url), headers);
}

export async function stopVoicePlayback() {
  playbackToken += 1;
  const p = getPlayer();
  try {
    p.removePlayBackListener();
  } catch (e) {}
  try {
    await p.stopPlayer();
  } catch (e) {}
}

export async function resetVoice() {
  playbackToken += 1;
  try {
    if (recorder) {
      try {
        recorder.removeRecordBackListener();
      } catch (e) {}
      if (recordingActive || currentPath) {
        try {
          await recorder.stopRecorder();
        } catch (e) {}
      }
    }
    if (player) {
      try {
        player.removePlayBackListener();
      } catch (e) {}
      try {
        await player.stopPlayer();
      } catch (e) {}
    }
  } catch (e) {}
  recordingActive = false;
  recordingPaused = false;
  recordingPausedMs = 0;
  recordingStartedAt = 0;
  recordingPausedAt = 0;
  currentPath = null;
}
