import { io } from 'socket.io-client';
import { SERVER_URL } from '../config';
import { getDeviceId } from './notifications';

let socket = null;

// Socket.IO manager options tuned for mobile: exponential backoff with jitter so
// reconnection after a network drop is fast on first retries and backs off under
// sustained failure, without hammering the server.
const MANAGER_OPTS = {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 8000,
  reconnectionDelayFactor: 1.9,
  randomizationFactor: 0.6,
  timeout: 10000,
};

export function connect(token) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = io(SERVER_URL, {
    // auth as an async callback: Socket.IO resolves it before the handshake, letting
    // us attach the stable per-install deviceId so the server can route FCM per device.
    auth: (cb) => {
      getDeviceId()
        .then((deviceId) => cb({ token, deviceId }))
        .catch(() => cb({ token }));
    },
    transports: ['websocket', 'polling'],
    autoConnect: true,
    forceNew: false,
    ...MANAGER_OPTS,
  });
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnect() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}