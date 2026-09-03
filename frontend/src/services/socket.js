import { io } from 'socket.io-client';

const API = import.meta.env.VITE_API_URL || '';

export function createSocket(token) {
  const socket = io(API, {
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
