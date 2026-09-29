import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Icon } from './AppIcon';
import { fs } from '../utils/size';

const ITEMS = [
  { key: 'home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { key: 'shorts', label: 'Shorts', icon: 'play-circle-outline', activeIcon: 'play-circle' },
  { key: 'downloads', label: 'Downloads', icon: 'download-outline', activeIcon: 'download' },
];

export default function BottomTabBar({ active, onChange, theme }) {
  return (
    <View style={[styles.shell, { backgroundColor: theme.background }]}>
      <View style={[styles.bar, { backgroundColor: theme.navBg, borderColor: theme.border }]}>
        {ITEMS.map((it) => {
          const isActive = active === it.key;
          return (
            <TouchableOpacity
              key={it.key}
              style={styles.btn}
              activeOpacity={0.7}
              onPress={() => onChange(it.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <View style={[styles.iconWrap, isActive && { backgroundColor: theme.primaryLight }]}>
                <Icon name={isActive ? it.activeIcon : it.icon} size={22} color={isActive ? theme.primary : theme.textSecondary} />
              </View>
              <Text
                style={[
                  styles.label,
                  { color: isActive ? theme.primary : theme.textSecondary },
                  isActive && styles.labelActive,
                ]}
              >
                {it.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
  },
  bar: {
    flexDirection: 'row',
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 6,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  btn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 4,
  },
  iconWrap: {
    width: 46,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: fs(11),
    marginTop: 2,
    fontWeight: '500',
  },
  labelActive: {
    fontWeight: '800',
  },
});