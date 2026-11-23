import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../../AppIcon';
import {
  BOTTOM_SHADE_LAYERS,
  FADE_DURATION,
  MEDIA_COLORS,
  mediaAccessibilityLabel,
  mediaSource,
  progressPercent,
  receiptVisual,
  resolveImageBackground,
  resolveMediaSize,
  stopTouchPropagation,
  styles,
} from './chatMediaStyles';

export default function ChatImageMessage(props) {
  const {
    uri,
    thumbnailUri,
    aspect,
    width,
    height,
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

  const fullSource = mediaSource(uri);
  const backgroundSource = resolveImageBackground(thumbnailUri, uri);
  const fade = useRef(new Animated.Value(0)).current;
  const activeRef = useRef(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    activeRef.current = true;
    fade.setValue(0);
    setLoaded(false);
    setFailed(false);
    setBackgroundFailed(false);
    return () => {
      activeRef.current = false;
      fade.stopAnimation();
    };
  }, [uri, thumbnailUri, retryKey, fade]);

  const handleLoad = () => {
    if (!activeRef.current) return;
    setLoaded(true);
    Animated.timing(fade, {
      toValue: 1,
      duration: FADE_DURATION,
      useNativeDriver: true,
    }).start();
  };

  const handleError = () => {
    if (!activeRef.current) return;
    setLoaded(false);
    setFailed(true);
  };

  const handleRetry = (event) => {
    stopTouchPropagation(event);
    setRetryKey((key) => key + 1);
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
    maxHeightRatio: 0.56,
  });
  const hasError = !!(error || failed);
  const showLoading = !hasError && !uploading && !!fullSource && !loaded;
  const percent = progressPercent(uploadProgress);
  const visibleReceipt = isSent && receipt ? receiptVisual(receipt) : null;
  const bubbleBorder = borderColor || (isSent ? 'rgba(255,255,255,0.2)' : MEDIA_COLORS.border);
  const accessibilityLabel = mediaAccessibilityLabel('image', {
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
      {backgroundSource && !backgroundFailed ? (
        <Image
          source={backgroundSource}
          style={styles.fillImage}
          resizeMode="cover"
          onError={() => setBackgroundFailed(true)}
        />
      ) : null}

      {fullSource ? (
        <Animated.View style={[styles.absoluteFill, { opacity: fade }]} pointerEvents="none">
          <Image
            key={retryKey}
            source={fullSource}
            style={styles.fillImage}
            resizeMode="cover"
            onLoad={handleLoad}
            onError={handleError}
          />
        </Animated.View>
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
            accessibilityLabel="Retry image"
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <Icon name="refresh" size={15} color={MEDIA_COLORS.white} />
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
                <Icon name="close" size={13} color={MEDIA_COLORS.white} />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : null}

      {timeLabel || edited || visibleReceipt ? (
        <View style={styles.metaRowRight} pointerEvents="none">
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
        </View>
      ) : null}
    </TouchableOpacity>
  );
}
