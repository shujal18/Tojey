const fs = require('fs');
const path = require('path');

const target = path.resolve(
  __dirname,
  '..',
  'mobile/node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/ScreenCaptureController.java'
);

if (!fs.existsSync(target)) {
  console.log('react-native-webrtc screen capture source not found; skipping fps patch');
  process.exit(0);
}

const before = fs.readFileSync(target, 'utf8');
const after = before.replace(/DEFAULT_FPS = 30\b/, 'DEFAULT_FPS = 60');

if (after === before) {
  console.log('react-native-webrtc screen capture already patched for 60fps');
  process.exit(0);
}

fs.writeFileSync(target, after);
console.log('patched react-native-webrtc screen capture to 60fps');
