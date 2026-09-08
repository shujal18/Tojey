import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import RNFetchBlob from 'rn-fetch-blob';

let recorder = null;
let player = null;

function getRecorder() {
  if (!recorder) recorder = new AudioRecorderPlayer();
  return recorder;
}

function getPlayer() {
  if (!player) player = new AudioRecorderPlayer();
  return player;
}

const AUDIO_SET = {
  OutputFormatAndroid: 2, // MPEG_4
  AudioEncoderAndroid: 3, // AAC
  AudioSamplingRateAndroid: 44100,
  AudioChannelsAndroid: 1,
  AudioEncodingBitRateAndroid: 64000,
};

export async function startVoiceRecording() {
  const r = getRecorder();
  try {
    await r.stopRecorder();
  } catch (e) {}
  const name = `voice_${Date.now()}.m4a`;
  const path = `${RNFetchBlob.fs.dirs.CacheDir}/${name}`;
  await r.startRecorder(path, AUDIO_SET, false);
  return { path, name };
}

export function trackVoiceRecording(cb) {
  const r = getRecorder();
  r.addRecordBackListener(cb);
  return () => r.removeRecordBackListener();
}

export async function stopVoiceRecording() {
  const r = getRecorder();
  let path = null;
  try {
    path = await r.stopRecorder();
  } catch (e) {
    console.warn('stopRecorder failed', e);
  }
  try {
    r.removeRecordBackListener();
  } catch (e) {}
  return path; // "file:///..." or null
}

export async function deleteVoiceFile(filePath) {
  if (!filePath) return;
  try {
    const p = String(filePath).replace(/^file:\/\//, '');
    if (await RNFetchBlob.fs.exists(p)) {
      await RNFetchBlob.fs.unlink(p);
    }
  } catch (e) {
    console.warn('deleteVoice failed', e);
  }
}

export async function playVoice(url, cb) {
  const p = getPlayer();
  try {
    await p.stopPlayer();
  } catch (e) {}
  try {
    p.removePlayBackListener();
  } catch (e) {}
  p.addPlayBackListener(cb);
  await p.startPlayer(url);
}

export async function stopVoicePlayback() {
  const p = getPlayer();
  try {
    p.removePlayBackListener();
  } catch (e) {}
  try {
    await p.stopPlayer();
  } catch (e) {}
}

export async function resetVoice() {
  try {
    if (recorder) {
      try {
        recorder.removeRecordBackListener();
      } catch (e) {}
      try {
        await recorder.stopRecorder();
      } catch (e) {}
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
}