export const colors = {
  primary: '#6C3CE9',
  primaryDeep: '#4E22B8',
  primaryLight: '#EEE8FF',
  primarySoft: '#D8CCFF',
  primaryGradient: ['#6C3CE9', '#4E22B8'],
  backgroundLight: '#F8F7FC',
  backgroundDark: '#121116',
  bubbleReceivedLight: '#FFFFFF',
  bubbleReceivedDark: '#2A2733',
  bubbleSentLight: '#6C3CE9',
  bubbleSentDark: '#6C3CE9',
  textLight: '#1A1720',
  textDark: '#F2F0F7',
  textSecondary: '#6B6773',
  white: '#FFFFFF',
  danger: '#E53935',
  online: '#7C4DFF',
  black: '#000000',
  divider: '#E6E2F0',
};

export const lightTheme = {
  isDark: false,
  background: colors.backgroundLight,
  card: '#FFFFFF',
  text: colors.textLight,
  textSecondary: colors.textSecondary,
  primary: colors.primary,
  primaryDeep: colors.primaryDeep,
  primaryLight: colors.primaryLight,
  border: colors.divider,
  sentBubble: colors.bubbleSentLight,
  sentText: colors.white,
  receivedBubble: colors.bubbleReceivedLight,
  receivedText: colors.textLight,
  composerBg: '#FFFFFF',
  inputBg: '#F0EDF8',
  navBg: '#FFFFFF',
  shadow: '0 2px 12px rgba(76, 35, 184, 0.08)',
  unreadBg: colors.primary,
  unreadText: colors.white,
};

export const darkTheme = {
  isDark: true,
  background: colors.backgroundDark,
  card: '#1C1922',
  text: colors.textDark,
  textSecondary: '#9B96A8',
  primary: colors.primary,
  primaryDeep: colors.primaryDeep,
  primaryLight: '#241F2E',
  border: '#2E2A38',
  sentBubble: colors.bubbleSentDark,
  sentText: colors.white,
  receivedBubble: colors.bubbleReceivedDark,
  receivedText: colors.textDark,
  composerBg: '#1C1922',
  inputBg: '#2B2733',
  navBg: '#1C1922',
  shadow: '0 2px 12px rgba(0, 0, 0, 0.5)',
  unreadBg: colors.primary,
  unreadText: colors.white,
};

export function getTheme(mode) {
  if (mode === 'dark') return darkTheme;
  if (mode === 'light') return lightTheme;
  const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return systemDark ? darkTheme : lightTheme;
}

export const wallpapers = [
  { id: 'purple-gradient', name: 'Purple Gradient', url: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)', type: 'gradient' },
  { id: 'dark-purple', name: 'Dark Purple', url: 'radial-gradient(circle at 20% 20%, #3A2A6B, #1A122E)', type: 'gradient' },
  { id: 'minimal-dots', name: 'Minimal Dots', url: 'radial-gradient(circle, rgba(108,60,233,0.35) 1.5px, transparent 1.5px), #F0ECFC; background-size: 24px 24px', type: 'pattern' },
  { id: 'waves', name: 'Abstract Waves', url: 'radial-gradient(600px circle at 0% 0%, rgba(108,60,233,0.25), transparent 40%), radial-gradient(500px circle at 100% 100%, rgba(78,34,184,0.25), transparent 40%), #181226', type: 'gradient' },
  { id: 'solid', name: 'Solid Light', url: 'linear-gradient(#F8F7FC, #F8F7FC)', type: 'solid' },
];

export const quickReactions = ['❤️', '😂', '😮', '😢', '👍', '👎'];
