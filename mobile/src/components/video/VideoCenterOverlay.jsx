import React, { memo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';
import { VIDEO_ACCENT } from './videoConfig';

function VideoCenterOverlay({
  playing = false,
  controlsVisible = true,
  buffering = false,
  error = null,
  disabled = false,
  locked = false,
  onToggle,
  onRetry,
}) {
  const showRetry = !!error;
  const showSpinner = !showRetry && buffering;
  const showPlayPause = !showRetry && !showSpinner && controlsVisible && !disabled && !locked;

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <View style={styles.center} pointerEvents="box-none">
        {showRetry ? (
          <TouchableOpacity
            style={styles.retryButton}
            onPress={onRetry}
            accessibilityLabel="Retry video"
            accessibilityRole="button"
            activeOpacity={0.8}
          >
            <Icon name="refresh-outline" size={30} color="#fff" />
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        ) : null}
        {showSpinner ? <ActivityIndicator color={VIDEO_ACCENT} size="large" /> : null}
        {showPlayPause ? (
          <TouchableOpacity
            style={styles.button}
            onPress={onToggle}
            disabled={disabled}
            accessibilityLabel={playing ? 'Pause video' : 'Play video'}
            accessibilityRole="button"
            activeOpacity={0.78}
          >
            <Icon name={playing ? 'pause' : 'play'} size={34} color="#fff" />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(4, 10, 20, 0.58)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  retryButton: {
    width: 94,
    minHeight: 84,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(5, 12, 24, 0.84)',
    borderWidth: 1,
    borderColor: 'rgba(61,155,255,0.24)',
  },
  retryText: { color: '#fff', fontSize: fs(11), fontWeight: '800' },
});

export default memo(VideoCenterOverlay);
