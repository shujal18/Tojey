import { io } from 'socket.io-client';
import { getWebDeviceId } from './webPush';

const API = import.meta.env.VITE_API_URL || '';

export function createSocket(token) {
  const socket = io(API, {
    auth: { token, deviceId: getWebDeviceId() },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });
  return socket;
}

// Tell the backend whether this browser "device" is foreground (page visible) or
// background. The FCM vs Socket.IO routing for web pushes keys off this, exactly like
// the Android app does, so a backgrounded/closed tab still gets a real web push while a
// visible tab gets live socket delivery instead of duplicate popups.
export function emitAppVisibility(socket, visible) {
  if (!socket) return;
  const deviceId = getWebDeviceId();
  socket.emit(visible ? 'app:foreground' : 'app:background', { deviceId });
}