import React, { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import VideoTopBar from './VideoTopBar';
import VideoCenterControls from './VideoCenterControls';
import VideoBottomControls from './VideoBottomControls';
import { videoStyles } from './videoStyles';

export default function TojeyVideoControls({ visible, compact, ...props }) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: visible ? 150 : 220,
      useNativeDriver: true,
    }).start();
  }, [opacity, visible]);

  return (
    <Animated.View
      style={[videoStyles.fill, { opacity }]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <View style={videoStyles.topShade} pointerEvents="none" />
      <View style={videoStyles.bottomShade} pointerEvents="none" />
      {!compact ? (
        <VideoTopBar
          title={props.title}
          badge={props.badge}
          onBack={props.onBack}
          onMinimize={props.onMinimize}
          onMore={props.onSettings}
        />
      ) : null}
      <VideoCenterControls
        playing={props.state.playing}
        disabled={props.sharedDisabled}
        onRewind={props.onRewind}
        onToggle={props.onTogglePlay}
        onForward={props.onForward}
        compact={compact}
      />
      {!compact ? (
        <VideoBottomControls
          state={props.state}
          fullscreen={props.state.fullscreen}
          guest={props.guest}
          watchTogether={props.watchTogether}
          pipOk={props.pipOk}
          onSeekPreview={props.onSeekPreview}
          onSeekCommit={props.onSeekCommit}
          onToggleMute={props.onToggleMute}
          onSettings={props.onSettings}
          onFullscreen={props.onToggleFullscreen}
          onPip={props.onPip}
          onLock={props.onLock}
          onRepeat={props.onRepeat}
          onSubtitles={props.onToggleSubtitles}
        />
      ) : null}
    </Animated.View>
  );
}
