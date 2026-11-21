import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Icon } from '../AppIcon';
import { videoStyles } from './videoStyles';

export default function VideoTopBar({ title, badge, onBack, onMinimize, onMore }) {
  return (
    <View style={videoStyles.topRow} pointerEvents="box-none">
      {onBack ? (
        <TouchableOpacity style={videoStyles.iconButton} onPress={onBack} accessibilityLabel="Back" accessibilityRole="button">
          <Icon name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
      ) : null}
      <Text style={videoStyles.title} numberOfLines={1}>{title || 'Tojey Player'}</Text>
      {badge ? (
        <View style={videoStyles.badge}>
          <Icon name="people" size={11} color="#E9DDFF" />
          <Text style={videoStyles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      {onMinimize ? (
        <TouchableOpacity style={videoStyles.iconButton} onPress={onMinimize} accessibilityLabel="Minimize player" accessibilityRole="button">
          <Icon name="arrow-down" size={20} color="#fff" />
        </TouchableOpacity>
      ) : null}
      {onMore ? (
        <TouchableOpacity style={videoStyles.iconButton} onPress={onMore} accessibilityLabel="Video settings" accessibilityRole="button">
          <Icon name="ellipsis-vertical" size={20} color="#fff" />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
