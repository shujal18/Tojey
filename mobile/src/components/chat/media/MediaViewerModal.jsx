import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Modal, StatusBar, StyleSheet, View } from 'react-native';
import Toast from '../../Toast';
import { fs } from '../../../utils/size';
import { setImmersive } from '../../../services/orientation';
import FullscreenImageViewer from './FullscreenImageViewer';
import FullscreenVideoViewer from './FullscreenVideoViewer';

export default function MediaViewerModal({
  visible,
  item,
  onClose,
  onExternal,
  onReact,
  onReply,
  onSave,
  onCopy,
  onDelete,
  onSendDrawing,
  currentUserId,
  theme,
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hiddenRef = useRef(false);
  const [saveToast, setSaveToast] = useState(null);

  const handleSave = async (message) => {
    if (typeof onSave !== 'function') return;
    const result = await onSave(message);
    if (result && result.message) setSaveToast({ id: Date.now(), message: result.message });
  };

  useEffect(() => {
    setSaveToast(null);
  }, [visible, item && item.id]);

  useEffect(() => {
    if (!visible) return undefined;

    StatusBar.setHidden(true, 'fade');
    hiddenRef.current = true;
    setImmersive(true);

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (typeof onCloseRef.current === 'function') onCloseRef.current();
      return true;
    });

    return () => {
      subscription.remove();
      if (hiddenRef.current) StatusBar.setHidden(false, 'fade');
      hiddenRef.current = false;
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
            <FullscreenVideoViewer item={item} onClose={onClose} onExternal={onExternal} onSave={handleSave} />
          ) : (
            <FullscreenImageViewer
              item={item}
              onClose={onClose}
              onExternal={onExternal}
              onReact={onReact}
              onReply={onReply}
              onSave={handleSave}
              onCopy={onCopy}
              onDelete={onDelete}
              onSendDrawing={onSendDrawing}
              currentUserId={currentUserId}
              theme={theme}
            />
          )
        ) : null}
        <Toast
          key={saveToast ? saveToast.id : 'save-toast'}
          message={saveToast ? saveToast.message : ''}
          bottom={fs(72)}
          duration={3000}
          variant="media"
        />
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
