import { lightTheme, darkTheme } from './ThemeContext';

export const TojeyColors = {
  primary: '#6C3CE9',
  primaryDeep: '#4E22B8',
  primaryLight: '#EEE8FF',
  primarySoft: '#D8CCFF',
  backgroundLight: '#F8F7FC',
  backgroundDark: '#121116',
  sentBubble: '#6C3CE9',
  receivedBubbleLight: '#FFFFFF',
  receivedBubbleDark: '#2A2733',
  textLight: '#1A1720',
  textDark: '#F2F0F7',
  textSecondary: '#6B6773',
  white: '#FFFFFF',
  danger: '#E53935',
  online: '#7C4DFF',
  readBlue: '#A5D6FF',
  border: '#E6E2F0',
};

export const quickReactions = ['❤️', '😂', '😮', '😢', '👍', '👎'];

export const reactionPopRow = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🫂'];

export const CHAT_COLORS = [
  { id: 'default', name: 'Purple', sent: '#6C3CE9' },
  { id: 'teal', name: 'Teal', sent: '#00A884' },
  { id: 'blue', name: 'Ocean', sent: '#0B7FE8' },
  { id: 'green', name: 'Green', sent: '#1FA05B' },
  { id: 'coral', name: 'Coral', sent: '#F24E42' },
  { id: 'orange', name: 'Orange', sent: '#F5811E' },
  { id: 'pink', name: 'Pink', sent: '#E2417D' },
  { id: 'indigo', name: 'Indigo', sent: '#4156D7' },
];

export function hexBlend(a, b, t) {
  const pa = /^#([0-9a-fA-F]{6})$/.exec(a || '');
  const pb = /^#([0-9a-fA-F]{6})$/.exec(b || '');
  if (!pa || !pb) return a;
  const ca = [1, 3, 5].map((i) => parseInt(pa[1].slice(i - 1, i + 1), 16));
  const cb = [1, 3, 5].map((i) => parseInt(pb[1].slice(i - 1, i + 1), 16));
  const m = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export { lightTheme, darkTheme };
