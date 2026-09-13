import { NativeModules, Platform, Vibration } from 'react-native';
import { getNudgeVibrationEnabled, NUDGE_PATTERN } from './chatHead';

export async function playNudgeVibration() {
  try {
    const enabled = await getNudgeVibrationEnabled();
    if (!enabled) return;
    const Mod = NativeModules.TojeyChatHead;
    if (Platform.OS === 'android' && Mod && Mod.vibrate) {
      Mod.vibrate(NUDGE_PATTERN.join(','));
    } else {
      Vibration.vibrate(NUDGE_PATTERN);
    }
  } catch (e) {}
}