import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, Modal,
  Dimensions, Image, ActivityIndicator, Alert, Animated, PanResponder,
} from 'react-native';
import Video from 'react-native-video';
import { Icon } from './AppIcon';
import { absUrl } from '../config';
import { quickReactions } from '../theme';
import RNFetchBlob from 'rn-fetch-blob';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

function ZoomableImage({ uri, style }) {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [loading, setLoading] = useState(true);

  const lastScale = useRef(1);
  const pinchStart = useRef(null);
  const baseTrans = useRef({ x: 0, y: 0 });
  const lastTap = useRef(0);
  const tapStart = useRef(0);
  const didGesture = useRef(false);

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const animateTo = (s, tx, ty) => {
    Animated.parallel([
      Animated.spring(scale, { toValue: s, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: tx, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: ty, useNativeDriver: true }),
    ]).start();
    lastScale.current = s;
  };

  const doubleTapZoom = () => {
    if (lastScale.current > 1.05) {
      animateTo(1, 0, 0);
    } else {
      animateTo(2.6, 0, 0);
    }
  };

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 320) {
      lastTap.current = 0;
      doubleTapZoom();
    } else {
      lastTap.current = now;
    }
  };

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (e, g) => {
      if (e.nativeEvent.touches.length === 2) return true;
      return lastScale.current > 1.02 && (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8);
    },
    onPanResponderGrant: (e) => {
      didGesture.current = true;
      baseTrans.current = { x: translateX.__getValue(), y: translateY.__getValue() };
      if (e.nativeEvent.touches.length === 2) {
        pinchStart.current = { distance: dist(e.nativeEvent.touches[0], e.nativeEvent.touches[1]), scale: lastScale.current };
      }
    },
    onPanResponderMove: (e, g) => {
      if (e.nativeEvent.touches.length === 2) {
        const t0 = e.nativeEvent.touches[0];
        const t1 = e.nativeEvent.touches[1];
        const d = dist(t0, t1);
        const base = pinchStart.current;
        if (!base || !base.distance) return;
        const s = clamp(base.scale * (d / base.distance), 1, 4);
        lastScale.current = s;
        scale.setValue(s);
      } else if (lastScale.current > 1.02) {
        translateX.setValue(clamp(baseTrans.current.x + g.dx, -160, 160));
        translateY.setValue(clamp(baseTrans.current.y + g.dy, -240, 240));
      }
    },
    onPanResponderRelease: () => {
      const s = lastScale.current;
      if (s < 1.15) {
        animateTo(1, 0, 0);
      } else if (s < 1.5) {
        animateTo(1, 0, 0);
      } else {
        animateTo(s, clamp(translateX.__getValue(), -160, 160), clamp(translateY.__getValue(), -240, 240));
      }
      pinchStart.current = null;
    },
    onPanResponderTerminate: () => {
      pinchStart.current = null;
    },
  })).current;

  return (
    <View
      style={[{ flex: 1, overflow: 'hidden' }, style]}
      {...pan.panHandlers}
      onTouchStart={() => { tapStart.current = Date.now(); didGesture.current = false; }}
      onTouchEnd={() => {
        if (!didGesture.current && Date.now() - tapStart.current < 320) handleTap();
      }}
    >
      <Animated.View style={[styles.zoomWrap, { transform: [{ translateX }, { translateY }, { scale }] }]}>
        {loading && (
          <View style={styles.imgLoading}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
        <Image
          source={{ uri }}
          style={[styles.zoomImg, { width: SCREEN_W }]}
          resizeMode="contain"
          onLoad={() => setLoading(false)}
        />
      </Animated.View>
    </View>
  );
}

function dist(a, b) {
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

export default function MediaViewer({ items = [], startIndex = 0, headerText = '', onClose, currentUserId, theme, onReact, onReply, onDelete }) {
  const [index, setIndex] = useState(startIndex);
  const [showMenu, setShowMenu] = useState(false);
  const [videoErrors, setVideoErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const listRef = useRef(null);
  const item = items[index] || null;
  const canShare = !!item && !!item.media_url;

  useEffect(() => {
    setIndex(startIndex);
  }, [startIndex]);

  const download = useCallback(async () => {
    if (!item || saving) return;
    setSaving(true);
    try {
      const url = absUrl(item.media_url);
      const isVideo = item.type === 'VIDEO';
      const ext = isVideo ? '.mp4' : '.jpg';
      const name = (item.file_name || ('tojey_media_' + item.id)) + ext;
      const { dirs } = RNFetchBlob.fs;
      const dlPath = `${dirs.DownloadDir}/${name}`;
      const res = await RNFetchBlob.config({
        fileCache: false,
        path: dlPath,
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          path: dlPath,
          description: 'Tojey media',
          mime: isVideo ? 'video/mp4' : 'image/jpeg',
        },
      }).fetch('GET', url);
      Alert.alert('Saved', `Downloaded to ${res.path()}`);
    } catch (e) {
      console.error('download failed', e);
      Alert.alert('Download failed', e.message || 'Could not save media');
    } finally {
      setSaving(false);
    }
  }, [item, saving]);

  const renderItem = useCallback(({ item: m }) => {
    const uri = absUrl(m.media_url);
    const isVideo = m.type === 'VIDEO';
    if (isVideo) {
      return (
        <View style={styles.slide}>
          {videoErrors[m.id] ? (
            <View style={styles.vidError}>
              <Icon name="alert-circle-outline" size={44} color="#fff" />
              <Text style={{ color: '#fff', marginTop: 10, fontSize: 14 }}>Video unavailable</Text>
            </View>
          ) : (
            <Video
              source={{ uri }}
              style={styles.video}
              resizeMode="contain"
              controls
              repeat={false}
              paused={true}
              onError={() => setVideoErrors((prev) => ({ ...prev, [m.id]: true }))}
              onLoad={() => setVideoErrors((prev) => ({ ...prev, [m.id]: false }))}
            />
          )}
        </View>
      );
    }
    return <ZoomableImage uri={uri} />;
  }, [videoErrors]);

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems && viewableItems.length) {
      setIndex(viewableItems[0].index);
    }
  }).current;

  const doReact = (r) => {
    if (onReact && item) onReact(item.id, r);
    setShowMenu(false);
  };

  const actionMenu = [
    { key: 'reply', label: 'Reply', icon: 'return-down-back-outline', onPress: () => { if (onReply && item) onReply(item); setShowMenu(false); } },
    { key: 'react', label: 'React', icon: 'heart-outline', onPress: () => setShowMenu(false) },
    { key: 'download', label: 'Download', icon: 'download-outline', onPress: () => { setShowMenu(false); download(); } },
    { key: 'delete', label: 'Delete for me', icon: 'trash-outline', danger: true, onPress: () => { if (onDelete && item) onDelete(item, 'me'); setShowMenu(false); } },
  ];
  if (item && item.sender_id === currentUserId) {
    actionMenu.push({ key: 'deleteAll', label: 'Delete for everyone', icon: 'trash', danger: true, onPress: () => { if (onDelete && item) onDelete(item, 'everyone'); setShowMenu(false); } });
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: 'rgba(0,0,0,0.97)' }]}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={onClose} style={styles.topBtn} accessibilityLabel="Close media viewer">
            <Icon name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={styles.topTitle} numberOfLines={1}>{headerText}</Text>
            {item && (
              <Text style={styles.topSub}>
                {item.content}
                {items.length > 1 ? ` · ${index + 1}/${items.length}` : ''}
              </Text>
            )}
          </View>
          <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.topBtn} accessibilityLabel="More actions">
            <Icon name="ellipsis-horizontal" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(m, idx) => String(m.id || idx)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          initialScrollIndex={startIndex}
          getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
          renderItem={renderItem}
          style={{ flex: 1 }}
        />

        {canShare && (
          <View style={[styles.bottomBar, { backgroundColor: theme.card }]}>
            <View style={styles.bottomTitleBar}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Icon name="images-outline" size={14} color={theme.textSecondary} />
                <Text style={[styles.bottomText, { color: theme.textSecondary }]}>
                  Tap video to play · Two fingers to zoom
                </Text>
              </View>
              <TouchableOpacity onPress={download} disabled={saving} style={[styles.dlBtn, { backgroundColor: theme.primary }]} accessibilityLabel="Download media">
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Icon name="download" size={16} color="#fff" />}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {showMenu && (
          <View style={styles.menuOverlay}>
            <TouchableOpacity style={styles.menuBackdrop} onPress={() => setShowMenu(false)} />
            <View style={[styles.menu, { backgroundColor: theme.card }]}>
              <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Media actions</Text>
              <View style={styles.reactionRow}>
                {quickReactions.map((r) => (
                  <TouchableOpacity key={r} onPress={() => doReact(r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                    <Text style={{ fontSize: 22 }}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {actionMenu.map((a) => (
                  <TouchableOpacity key={a.key} onPress={a.onPress} style={[styles.menuItem, { backgroundColor: theme.primaryLight }]}>
                    <Icon name={a.icon} size={16} color={a.danger ? theme.danger : theme.primary} />
                    <Text style={{ color: a.danger ? theme.danger : theme.primary, fontWeight: '600', fontSize: 13, marginLeft: 6 }}>{a.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 44, paddingBottom: 10,
  },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  topTitle: { color: '#fff', fontSize: 15, fontWeight: '700', maxWidth: SCREEN_W - 140 },
  topSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 2 },
  slide: { width: SCREEN_W, height: '100%', alignItems: 'center', justifyContent: 'center' },
  video: { width: SCREEN_W, height: SCREEN_H - 180 },
  vidError: { alignItems: 'center', justifyContent: 'center' },
  zoomWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  zoomImg: { height: '100%' },
  imgLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  bottomBar: { paddingVertical: 8, paddingHorizontal: 14, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.1)' },
  bottomTitleBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottomText: { fontSize: 12, marginLeft: 5 },
  dlBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menu: { position: 'absolute', right: 12, top: 90, width: SCREEN_W - 60, borderRadius: 16, padding: 14, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 16, elevation: 8 },
  menuTitle: { fontSize: 13, fontWeight: '700', marginBottom: 8 },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 10 },
  reactionBtn: { borderRadius: 14, width: 44, height: 40, alignItems: 'center', justifyContent: 'center' },
  menuItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 9, paddingVertical: 9, paddingHorizontal: 12 },
});