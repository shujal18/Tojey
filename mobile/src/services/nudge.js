import { Vibration } from 'react-native';
import { getNudgeVibrationEnabled, NUDGE_PATTERN } from './chatHead';

export async function playNudgeVibration() {
  try {
    const enabled = await getNudgeVibrationEnabled();
    if (enabled) Vibration.vibrate(NUDGE_PATTERN);
  } catch (e) {}
}