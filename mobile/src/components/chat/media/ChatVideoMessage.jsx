import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../../AppIcon';
import { fs } from '../../../utils/size';
import {
  BOTTOM_SHADE_LAYERS,
  FADE_DURATION,
  MEDIA_COLORS,
  mediaAccessibilityLabel,
  progressPercent,
  receiptVisual,
  resolveMediaSize,
  resolveVideoThumbnail,
  stopTouchPropagation,
  styles,
} from './chatMediaStyles';

export default function ChatVideoMessage(props) {
  const {
    uri,
    thumbnailUri,
    aspect,
    width,
    height,
    durationLabel,
    timeLabel,
    edited,
    receipt,
    isSent,
    uploading,
    uploadProgress,
    error,
    onCancelUpload,
    onRetry,
    borderColor,
    ...touchProps
  } = props;

  const thumbSource = resolveVideoThumbnail(thumbnailUri, uri);
  const fade = useRef(new Animated.Value(0)).current;
  const activeRef = useRef(true);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [thumbRetryKey, setThumbRetryKey] = useState(0);

  useEffect(() => {
    activeRef.current = true;
    fade.setValue(0);
    setThumbLoaded(false);
    setThumbFailed(false);
    return () => {
      activeRef.current = false;
      fade.stopAnimation();
    };
  }, [thumbnailUri, uri, thumbRetryKey, fade]);

  const handleThumbLoad = () => {
    if (!activeRef.current) return;
    setThumbLoaded(true);
    Animated.timing(fade, {
      toValue: 1,
      duration: FADE_DURATION,
      useNativeDriver: true,
    }).start();
  };

  const handleThumbError = () => {
    if (!activeRef.current) return;
    setThumbLoaded(false);
    setThumbFailed(true);
  };

  const handleRetry = (event) => {
    stopTouchPropagation(event);
    setThumbRetryKey((key) => key + 1);
    if (onRetry) onRetry();
  };

  const handleCancel = (event) => {
    stopTouchPropagation(event);
    if (onCancelUpload) onCancelUpload();
  };

  const size = resolveMediaSize({
    width,
    height,
    aspect,
    maxWidthRatio: 0.8,
    maxHeightRatio: 0.52,
    fallbackAspect: 16 / 9,
  });
  const hasError = !!error;
  const showFallback = !thumbSource || thumbFailed;
  const showLoading = !hasError && !uploading && !!thumbSource && !thumbLoaded && !thumbFailed;
  const percent = progressPercent(uploadProgress);
  const visibleReceipt = isSent && receipt ? receiptVisual(receipt) : null;
  const bubbleBorder = borderColor || (isSent ? 'rgba(255,255,255,0.2)' : MEDIA_COLORS.border);
  const accessibilityLabel = mediaAccessibilityLabel('video', {
    durationLabel,
    timeLabel,
    edited,
    error: hasError,
  });

  return (
    <TouchableOpacity
      {...touchProps}
      activeOpacity={touchProps.activeOpacity == null ? 0.9 : touchProps.activeOpacity}
      style={[
        styles.bubble,
        { width: size.width, height: size.height, borderColor: bubbleBorder },
        touchProps.style,
      ]}
      accessibilityRole={touchProps.accessibilityRole || 'button'}
      accessibilityLabel={accessibilityLabel}
    >
      {thumbSource && !thumbFailed ? (
        <Animated.View style={[styles.absoluteFill, { opacity: fade }]} pointerEvents="none">
          <Image
            key={thumbRetryKey}
            source={thumbSource}
            style={styles.fillImage}
            resizeMode="cover"
            onLoad={handleThumbLoad}
            onError={handleThumbError}
          />
        </Animated.View>
      ) : null}

      {showFallback ? (
        <View style={styles.fallbackIcon} pointerEvents="none">
          <Icon name="videocam-outline" size={fs(42)} color="rgba(255,255,255,0.38)" />
        </View>
      ) : null}

      <View pointerEvents="none" style={styles.absoluteFill}>
        {BOTTOM_SHADE_LAYERS.map((layer, index) => (
          <View
            key={index}
            style={[
              styles.bottomShadeLayer,
              { height: layer.height, backgroundColor: layer.color },
            ]}
          />
        ))}
      </View>

      <View style={styles.centerOverlay} pointerEvents="none">
        <View style={styles.playButton}>
          <Icon
            name="play"
            size={fs(24)}
            color={MEDIA_COLORS.white}
            style={styles.playTriangle}
          />
        </View>
      </View>

      {showLoading ? (
        <View style={styles.centerOverlay} pointerEvents="none">
          <View style={styles.loadingPill}>
            <ActivityIndicator color={MEDIA_COLORS.white} size="small" />
            <Text style={styles.loadingText}>Loading</Text>
          </View>
        </View>
      ) : null}

      {hasError ? (
        <View style={[styles.centerOverlay, { backgroundColor: MEDIA_COLORS.overlaySoft }]} pointerEvents="box-none">
          <TouchableOpacity
            onPress={handleRetry}
            style={styles.retryPill}
            accessibilityLabel="Retry video"
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <Icon name="refresh" size={fs(15)} color={MEDIA_COLORS.white} />
            <Text style={styles.retryText}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {uploading && !hasError ? (
        <View style={[styles.centerOverlay, { backgroundColor: MEDIA_COLORS.overlaySoft }]} pointerEvents="box-none">
          <View style={styles.uploadPill}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${percent}%` }]} />
            </View>
            <Text style={styles.progressText}>{percent}%</Text>
            {onCancelUpload ? (
              <TouchableOpacity
                onPress={handleCancel}
                style={styles.cancelButton}
                accessibilityLabel="Cancel upload"
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Icon name="close" size={fs(13)} color={MEDIA_COLORS.white} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={styles.metaRow} pointerEvents="none">
        {durationLabel ? (
          <View style={styles.durationGroup}>
            <Icon
              name="videocam"
              size={fs(12)}
              color={MEDIA_COLORS.white}
              style={styles.durationIcon}
            />
            <Text style={styles.metaText}>{durationLabel}</Text>
          </View>
        ) : null}

        {timeLabel || edited || visibleReceipt ? (
          <View style={styles.metaPill}>
            {edited ? <Text style={[styles.metaTextMuted, styles.metaSpacer]}>edited</Text> : null}
            {timeLabel ? <Text style={styles.metaText}>{timeLabel}</Text> : null}
            {visibleReceipt ? (
              <Icon
                name={visibleReceipt.name}
                size={visibleReceipt.size}
                color={visibleReceipt.color}
                style={styles.receipt}
              />
            ) : null}
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}
