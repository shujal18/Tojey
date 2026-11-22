import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Icon } from '../AppIcon';
import { tickHaptic } from './videoConfig';
import { videoStyles } from './videoStyles';

export default function VideoLockOverlay({ onUnlock }) {
  return (
    <TouchableOpacity
      style={[videoStyles.iconButton, videoStyles.lockButton]}
      onLongPress={() => {
        tickHaptic();
        if (onUnlock) onUnlock();
      }}
      delayPressIn={500}
      accessibilityLabel="Long press to unlock video controls"
      accessibilityRole="button"
    >
      <Icon name="lock-closed" size={20} color="#fff" />
    </TouchableOpacity>
  );
}
