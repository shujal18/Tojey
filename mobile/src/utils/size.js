import { Dimensions } from 'react-native';

const { width: WIN_W, height: WIN_H } = Dimensions.get('window');

const FACTOR = Math.min(Math.max(WIN_W / 390, 0.8), 1.35);

export function fs(n) {
  return Math.round(FACTOR * n);
}

export function fsw(v) {
  return Math.min(Math.max(0.8, FACTOR), 1) * v;
}

export { WIN_W, WIN_H };