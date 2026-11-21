import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { videoStyles } from './videoStyles';

export default function VideoCenterControls({ playing = false, disabled = false, onRewind, onToggle, onForward, compact = false }) {
  const iconColor = disabled ? 'rgba(255,255,255,0.45)' : '#fff';
  return (
    <View style={[videoStyles.centerRow, compact && { gap: 16 }]} pointerEvents="box-none">
      {!compact && (
        <TouchableOpacity
          style={[videoStyles.centerButton, disabled && videoStyles.disabled]}
          onPress={onRewind}
          disabled={disabled}
          accessibilityLabel="Rewind 10 seconds"
          accessibilityRole="button"
        >
          <Icon name="play-back" size={24} color={iconColor} />
        </TouchableOpacity>
      )}
      <TouchableOpacity
        style={[videoStyles.centerButton, videoStyles.centerPrimary, disabled && videoStyles.disabled]}
        onPress={onToggle}
        disabled={disabled}
        accessibilityLabel={playing ? 'Pause video' : 'Play video'}
        accessibilityRole="button"
      >
        <Icon name={playing ? 'pause' : 'play'} size={30} color="#fff" />
      </TouchableOpacity>
      {!compact && (
        <TouchableOpacity
          style={[videoStyles.centerButton, disabled && videoStyles.disabled]}
          onPress={onForward}
          disabled={disabled}
          accessibilityLabel="Forward 10 seconds"
          accessibilityRole="button"
        >
          <Icon name="play-forward" size={24} color={iconColor} />
        </TouchableOpacity>
      )}
    </View>
  );
}
