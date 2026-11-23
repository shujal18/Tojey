import React, { useEffect, useRef } from 'react';
import { BackHandler, Modal, StatusBar, StyleSheet, View } from 'react-native';
import { setImmersive } from '../../../services/orientation';
import FullscreenImageViewer from './FullscreenImageViewer';
import FullscreenVideoViewer from './FullscreenVideoViewer';

export default function MediaViewerModal({ visible, item, onClose, onExternal, theme }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!visible) return undefined;

    StatusBar.setHidden(true, 'fade');
    setImmersive(true);

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (typeof onCloseRef.current === 'function') onCloseRef.current();
      return true;
    });

    return () => {
      subscription.remove();
      StatusBar.setHidden(false, 'fade');
      setImmersive(false);
    };
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        {visible && item ? (
          item.type === 'VIDEO' ? (
            <FullscreenVideoViewer item={item} onClose={onClose} onExternal={onExternal} />
          ) : (
            <FullscreenImageViewer item={item} onClose={onClose} />
          )
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
});
