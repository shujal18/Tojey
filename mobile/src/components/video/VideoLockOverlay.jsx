import React from 'react';
import { TouchableOpacity } from 'react-native';
import { Icon } from '../AppIcon';
import { videoStyles } from './videoStyles';

export default function VideoLockOverlay({ onUnlock }) {
  return (
    <TouchableOpacity
      style={[videoStyles.iconButton, videoStyles.lockButton]}
      onPress={onUnlock}
      accessibilityLabel="Unlock video controls"
      accessibilityRole="button"
    >
      <Icon name="lock-closed" size={20} color="#fff" />
    </TouchableOpacity>
  );
}
