import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import VideoTopOverlay from './VideoTopOverlay';
import VideoCenterOverlay from './VideoCenterOverlay';
import VideoBottomBar from './VideoBottomBar';
import { videoStyles } from './videoStyles';
import { CONTROL_HIDE_MS, CONTROL_SHOW_MS } from './videoConfig';

export default function TojeyVideoControls({ visible, compact, ...props }) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? CONTROL_SHOW_MS : CONTROL_HIDE_MS,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, visible]);

  return (
    <Animated.View
      style={[videoStyles.fill, { opacity }]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      {compact ? null : (
        <VideoTopOverlay
          title={props.title}
          watchTogether={props.watchTogether}
          onBack={props.onBack}
          fullscreen={props.state.fullscreen}
        />
      )}
      <VideoCenterOverlay
        playing={props.state.playing}
        disabled={props.guest}
        onToggle={props.onTogglePlay}
      />
      {compact ? null : (
        <VideoBottomBar
          state={props.state}
          fullscreen={props.state.fullscreen}
          guest={props.guest}
          pipOk={props.pipOk}
          previewTime={props.previewTime}
          onSeekPreview={props.onSeekPreview}
          onSeekCommit={props.onSeekCommit}
          onToggleMute={props.onToggleMute}
          onSettings={props.onSettings}
          onFullscreen={props.onToggleFullscreen}
          onPip={props.onPip}
        />
      )}
    </Animated.View>
  );
}
