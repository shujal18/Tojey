import React, { memo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { fs } from '../../utils/size';

const GRADIENT_STOPS = [0, 1, 2, 3, 4];

function VideoTopOverlay({ title, watchTogether = false, onBack, safeTop = 0 }) {
  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={styles.gradient} pointerEvents="none">
        {GRADIENT_STOPS.map((index) => (
          <View
            key={index}
            style={[
              styles.gradientLayer,
              {
                top: index * 28,
                height: 28,
                backgroundColor: `rgba(2, 6, 14, ${0.5 - index * 0.085})`,
              },
            ]}
          />
        ))}
      </View>

      <View style={[styles.topRow, { paddingTop: 10 + safeTop }]} pointerEvents="box-none">
        {onBack ? (
          <TouchableOpacity
            style={styles.backButton}
            onPress={onBack}
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
          >
            <Icon name="chevron-back" size={26} color="#fff" />
          </TouchableOpacity>
        ) : (
          <View style={styles.backButton} />
        )}
        <Text style={styles.title} numberOfLines={1}>{title || 'Tojey Player'}</Text>
        <View style={styles.emptyRight} />
      </View>

      {watchTogether ? (
        <View style={[styles.watchPill, { marginTop: 4 + Math.max(0, safeTop - 8) }]} pointerEvents="none">
          <Icon name="people-outline" size={13} color="rgba(210,232,255,0.92)" />
          <Text style={styles.watchText}>Watching Together</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 12 },
  gradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 150, overflow: 'hidden' },
  gradientLayer: { position: 'absolute', left: 0, right: 0 },
  topRow: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  emptyRight: { width: 40 },
  title: {
    flex: 1,
    marginLeft: 4,
    color: '#fff',
    fontSize: fs(15),
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  watchPill: {
    alignSelf: 'flex-start',
    marginLeft: 18,
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: 'rgba(18, 44, 78, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(140, 195, 255, 0.22)',
  },
  watchText: { color: '#F2F8FF', fontSize: fs(11), fontWeight: '700', letterSpacing: 0.2 },
});

export default memo(VideoTopOverlay);
