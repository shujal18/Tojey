import { io } from 'socket.io-client';
import { SERVER_URL } from '../config';

let socket = null;

export function connect(token) {
  if (socket) {
    socket.disconnect();
  }
  socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });
  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
