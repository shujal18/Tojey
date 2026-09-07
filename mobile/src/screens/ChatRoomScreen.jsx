import React, { useEffect, useRef, useState, useCallback, memo, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Keyboard, Linking, Modal, ActivityIndicator, Alert,
  Animated, PanResponder, Dimensions,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { quickReactions } from '../theme';
import { absUrl, SERVER_URL } from '../config';
import Clipboard from '@react-native-clipboard/clipboard';
import RNFetchBlob from 'rn-fetch-blob';
import DocumentPicker, { types as DocTypes } from 'react-native-document-picker';
import { ensureCameraPermission, ensureMediaPermission, ensureMicPermission } from '../services/permissions';
import { loadMessages, saveMessages, clearConversationCache } from '../services/cache';
import MediaViewer from '../components/MediaViewer';
import MediaPreview from '../components/MediaPreview';

const { width: APP_W } = Dimensions.get('window');

export default function ChatRoomScreen({ socket, currentUser, otherUser, onBack }) {
  const { theme } = useTheme();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [reactionMenu, setReactionMenu] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [showAttach, setShowAttach] = useState(false);
  const [presence, setPresence] = useState(null);
  const listRef = useRef(null);
  const recTimer = useRef(null);
  const typingTimer = useRef(null);
  const [mediaViewer, setMediaViewer] = useState(null);
  const [previewAsset, setPreviewAsset] = useState(null);
  const [atBottomNear, setAtBottomNear] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const atBottomRef = useRef(true);
  const atBottomNearRef = useRef(true);
  const scrolledToEndOnMount = useRef(false);
  const uploadTasks = useRef(new Map());

  // Defensive: ensure otherUser has all required properties
  const safeOtherUser = otherUser || { id: 0, display_name: 'Unknown', username: '', profile_pic_url: '', online: false, last_seen: null };
  const otherUserId = safeOtherUser.id;
  const otherUserName = safeOtherUser.display_name || safeOtherUser.username || 'Unknown';
  const otherUserAvatar = safeOtherUser.profile_pic_url || '';
  const otherUserOnline = safeOtherUser.online ?? false;
  const otherUserLastSeen = safeOtherUser.last_seen ?? null;

  const mediaItems = useMemo(
    () => messages.filter((m) =>
      (m.type === 'IMAGE' || m.type === 'VIDEO') &&
      m.media_url &&
      !m._uploading &&
      !m._pending &&
      (m.media_url.startsWith('/uploads/') || m.media_url.startsWith('http'))
    ),
    [messages]
  );

  const openMedia = useCallback((message) => {
    if (!message || !message.media_url) return;
    if (message.type === 'IMAGE' || message.type === 'VIDEO') {
      const idx = mediaItems.findIndex((m) => m.id === message.id);
      if (idx >= 0) {
        setMediaViewer({ items: mediaItems, index: idx });
        return;
      }
      Linking.openURL(absUrl(message.media_url)).catch(() => {});
    } else if (message.type === 'VOICE') {
      Linking.openURL(absUrl(message.media_url)).catch(() => {});
    } else if (message.type === 'FILE' || message.type === 'DOCUMENT') {
      const name = message.file_name || message.content || '';
      if (/\.(mp4|mov|mkv|webm|3gp|m4v|avi|wmv)(\?|#|$)/i.test(name)) {
        setMediaViewer({ items: [{ id: message.id, type: 'VIDEO', media_url: message.media_url, file_name: name, content: name, sender_id: message.sender_id }], index: 0 });
        return;
      }
      downloadAndOpen(message);
    } else {
      Linking.openURL(absUrl(message.media_url)).catch(() => {});
    }
  }, [mediaItems]);

  const handleContentSizeChange = useCallback(() => {
    if (atBottomRef.current && scrolledToEndOnMount.current) listRef.current?.scrollToEnd({ animated: false });
  }, []);

  const handleScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    const h = e.nativeEvent.layoutMeasurement.height;
    const cs = e.nativeEvent.contentSize.height;
    const nearBottom = y + h >= cs - 50;
    atBottomRef.current = nearBottom;
    if (nearBottom) setPendingCount(0);
    if (nearBottom !== atBottomNearRef.current) {
      atBottomNearRef.current = nearBottom;
      setAtBottomNear(nearBottom);
    }
  }, []);

  const handleLongPress = useCallback((msg) => setReactionMenu(msg), []);

  const toggleLike = useCallback((msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const mine = (msg.reactions || []).find((r) => r.user_id === currentUser.id);
    reactTo(msg.id, mine && mine.reaction === '❤️' ? '' : '❤️');
  }, [currentUser.id]);

  const replyIndex = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const replyPreviewOf = useCallback((id) => {
    const ref = replyIndex.get(id);
    return ref ? replyPreview(ref) : '…';
  }, [replyIndex]);

  const renderMessage = useCallback(({ item, index }) => {
    const isSent = item.sender_id === currentUser.id;
    const prev = index > 0 ? messages[index - 1] : null;
    const grouped = !!prev && prev.sender_id === item.sender_id;
    return (
      <MessageRow
        message={item}
        isSent={isSent}
        grouped={grouped}
        theme={theme}
        onLongPress={handleLongPress}
        onOpenMedia={openMedia}
        onRetry={retrySendMedia}
        onReply={setReplyingTo}
        onDoubleTap={toggleLike}
        replyPreviewOf={replyPreviewOf}
        suggestEdit={isSent && item.type === 'TEXT' && !!item.content && !item._pending}
        onEditRow={(m) => doAction('edit', m)}
        onCancelUpload={cancelUpload}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, theme, handleLongPress, openMedia, toggleLike, replyPreviewOf, cancelUpload]);

  const onType = (t) => {
    setText(t);
    if (socket && t.trim()) {
      if (!typingTimer.current) {
        socket.emit('typing:start', { otherUserId });
      }
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        if (socket) socket.emit('typing:stop', { otherUserId });
        typingTimer.current = null;
      }, 1500);
    }
  };

  useEffect(() => {
    if (!socket || !otherUserId || !currentUser?.id) return;

    socket.emit('conversation:open', { otherUserId });

    // Seed UI with offline cache immediately, then server history overwrites
    loadMessages(currentUser.id, otherUserId).then((cached) => {
      if (cached && cached.length) {
        setMessages(cached);
        atBottomRef.current = true;
        atBottomNearRef.current = true;
        setAtBottomNear(true);
        setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 80);
      }
    });

    const hHistory = (msgs) => {
      setMessages(msgs);
      saveMessages(currentUser.id, otherUserId, msgs);
      atBottomNearRef.current = true;
      setAtBottomNear(true);
      setPendingCount(0);
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: false });
        scrolledToEndOnMount.current = true;
      }, 80);
    };
    const hReceive = ({ message }) => {
      // Deduplicate: check if message already exists
      setMessages((prev) => {
        if (prev.some((m) => m.id === message.id)) return prev;
        return [...prev, { ...message, _local: message.sender_id === currentUser.id }];
      });
      if (message.sender_id !== currentUser.id) {
        if (!atBottomRef.current) {
          setPendingCount((n) => n + 1);
        } else {
          setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
        }
        socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
      }
    };
    const hDelivered = ({ messageId }) => updateStatus(messageId, 'DELIVERED');
    const hRead = ({ messageIds }) => {
      setMessages((prev) => prev.map((m) => (messageIds.includes(m.id) ? { ...m, status: 'READ' } : m)));
    };
    const hTyping = ({ userId }) => { if (userId === otherUserId) setTyping(true); };
    const hTypingStop = ({ userId }) => { if (userId === otherUserId) setTyping(false); };
    const hEdited = ({ messageId, content }) =>
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content, is_edited: true } : m)));
    const hDeleted = ({ messageId, mode }) =>
      setMessages((prev) =>
        mode === 'everyone'
          ? prev.map((m) => (m.id === messageId ? { ...m, is_deleted_for_everyone: true, content: null } : m))
          : prev.filter((m) => m.id !== messageId)
      );
    const hReaction = ({ messageId, reactions }) =>
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions } : m)));

    socket.on('messages:history', hHistory);
    socket.on('message:receive', hReceive);
    socket.on('message:delivered', hDelivered);
    socket.on('message:read', hRead);
    socket.on('typing:start', hTyping);
    socket.on('typing:stop', hTypingStop);
    socket.on('message:edited', hEdited);
    socket.on('message:deleted', hDeleted);
    socket.on('message:reaction', hReaction);
    const hCleared = ({ conversationId }) => { setMessages([]); setShowAttach(false); setReplyingTo(null); setEditing(null); setText(''); clearConversationCache(currentUser.id, otherUserId); };
    socket.on('conversation:cleared', hCleared);
    const hPresence = ({ userId, isOnline, lastSeen }) => {
      if (userId === otherUserId) setPresence({ isOnline, lastSeen });
    };
    socket.on('presence:update', hPresence);

    // Re-emit conversation:open on socket reconnect to ensure message sync
    const onReconnect = () => {
      if (socket && otherUserId) {
        socket.emit('conversation:open', { otherUserId });
      }
    };
    socket.on('connect', onReconnect);
    socket.io?.off('reconnect', onReconnect);
    socket.io?.on('reconnect', onReconnect);

    return () => {
      socket.off('messages:history', hHistory);
      socket.off('message:receive', hReceive);
      socket.off('message:delivered', hDelivered);
      socket.off('message:read', hRead);
      socket.off('typing:start', hTyping);
      socket.off('typing:stop', hTypingStop);
      socket.off('message:edited', hEdited);
      socket.off('message:deleted', hDeleted);
      socket.off('message:reaction', hReaction);
      socket.off('conversation:cleared', hCleared);
      socket.off('presence:update', hPresence);
      socket.off('connect', onReconnect);
      socket.io?.off('reconnect', onReconnect);
    };
  }, [socket, otherUserId, currentUser.id]);

  // Persist messages to offline cache whenever they change
  useEffect(() => {
    if (!currentUser?.id || !otherUserId || !messages.length) return;
    saveMessages(currentUser.id, otherUserId, messages);
  }, [messages, otherUserId, currentUser.id]);

  function updateStatus(id, status) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
  }

  const setUploadProgress = useCallback((tempId, p) => {
    setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _uploadProgress: p } : m)));
  }, []);

  const uploadAsset = useCallback(({ uri, name, type }, onProgress) => {
    return new Promise((resolve, reject) => {
      let done = false;
      const task = RNFetchBlob.fetch('POST', `${SERVER_URL}/api/upload`, {
        'Content-Type': 'multipart/form-data',
        Authorization: `Bearer ${currentUser.token || ''}`,
      }, [
        { name: 'file', filename: name, type, data: RNFetchBlob.wrap(uri) },
      ]).uploadProgress({ interval: 120 }, (sent, total) => {
        if (done || total <= 0) return;
        if (onProgress) onProgress(Math.min(1, sent / total));
      }).then((res) => {
        if (done) return;
        done = true;
        let d = null;
        try { d = res.data ? JSON.parse(res.data) : null; } catch (err) { d = null; }
        if (!d || !d.url) reject(new Error((d && d.error) || 'Upload failed'));
        else resolve(d);
      }).catch((err) => {
        if (done) return;
        done = true;
        reject(err);
      });
      uploadTasks.current.set(name, task);
    });
  }, [currentUser.token]);

  const cancelUpload = useCallback((msg) => {
    if (!msg) return;
    const key = msg._uploadKey;
    if (key) {
      const t = uploadTasks.current.get(key);
      try { if (t && t.cancel) t.cancel(); } catch (e) { console.error('cancel err', e); }
      uploadTasks.current.delete(key);
    }
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
  }, []);

  const sendText = () => {
    const content = text.trim();
    if (!content) return;
    if (editing) {
      socket.emit('message:edit', { messageId: editing.id, content });
      setMessages((prev) => prev.map((m) => (m.id === editing.id ? { ...m, content, is_edited: true } : m)));
      setEditing(null);
      setText('');
      return;
    }
    const tempId = `tmp-${Date.now()}`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'TEXT',
      content,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reply_to: replyingTo?.id || null,
      reactions: [],
      _local: true,
      _pending: true,
    };
    setMessages((prev) => [...prev, localMsg]);
    const payload = {
      otherUserId,
      type: 'TEXT',
      content,
      replyTo: replyingTo?.id || null,
    };
    if (socket) socket.emit('typing:stop', { otherUserId });
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
    socket.emit('message:send', payload, (ack) => {
      if (ack?.ok) {
        atBottomRef.current = true;
        setAtBottomNear(true);
        setPendingCount(0);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? ack.message : m)));
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
      }
    });
    setText('');
    setReplyingTo(null);
  };

  const sendVoice = () => {
    const tempId = `tmp-${Date.now()}`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'VOICE',
      content: 'Voice message',
      media_url: '',
      thumb_url: '',
      duration: recordTime || 8,
      waveform: 'waveform',
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
    };
    setMessages((prev) => [...prev, localMsg]);
    if (atBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    }
    socket.emit('message:send', {
      otherUserId,
      type: 'VOICE',
      content: 'Voice message',
      duration: recordTime || 8,
      waveform: 'waveform',
    }, (ack) => {
      if (ack?.ok) {
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
      }
    });
    setRecording(false);
    setRecordTime(0);
  };

  const startRecording = async () => {
    const ok = await ensureMicPermission();
    if (!ok) {
      alert('Microphone permission is required to record voice messages.');
      return;
    }
    setRecording(true);
    setRecordTime(0);
    recTimer.current = setInterval(() => setRecordTime((t) => t + 1), 1000);
  };

  const stopRecording = (cancel) => {
    clearInterval(recTimer.current);
    if (cancel) { setRecording(false); setRecordTime(0); return; }
    setRecording(false);
    sendVoice();
  };

  const reactTo = (id, reaction) => {
    socket.emit('message:react', { messageId: id, reaction });
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m;
        const existing = (m.reactions || []).filter((r) => r.user_id !== currentUser.id);
        return { ...m, reactions: reaction ? [...existing, { user_id: currentUser.id, reaction }] : existing };
      })
    );
    setReactionMenu(null);
  };

  const deleteMessage = (message, mode) => {
    if (mode === 'everyone') {
      socket.emit('message:delete', { messageId: message.id, mode: 'everyone' });
    } else {
      socket.emit('message:delete', { messageId: message.id, mode: 'me' });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    }
  };

  const doAction = (action, message) => {
    setReactionMenu(null);
    if (action === 'reply') { setReplyingTo(message); }
    else if (action === 'edit') { setEditing(message); setText(message.content || ''); }
    else if (action === 'deleteMe') { deleteMessage(message, 'me'); }
    else if (action === 'deleteAll') { deleteMessage(message, 'everyone'); }
  };

  const sendFile = (asset) => {
    if (!asset || !asset.uri) return;
    const fileName = asset.name || `file_${Date.now()}`;
    const fileSize = asset.size || 0;
    const mimeType = asset.type || 'application/octet-stream';
    const tempId = `tmp-${Date.now()}`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'FILE',
      content: fileName,
      file_name: fileName,
      media_size: fileSize,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    if (atBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    }
    uploadAsset({ uri: asset.uri, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: 'FILE',
          content: fileName,
          fileName,
          mediaSize: fileSize,
          mediaUrl: upData.url,
        }, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('sendFile upload failed:', e);
        setMessages((prev) => prev.map((m) =>
          m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m
        ));
      });
  };

  const pickMedia = (kind) => {
    setShowAttach(false);
    if (kind === 'photo' || kind === 'camera') {
      (async () => {
        try {
          const ImagePicker = require('react-native-image-picker');
          if (kind === 'camera') {
            const ok = await ensureCameraPermission();
            if (!ok) {
              alert('Camera permission is required to take photos.');
              return;
            }
            ImagePicker.launchCamera({ mediaType: 'photo' }, (r) => {
              if (r.didCancel) return;
              if (r.errorCode) {
                alert('Failed to open camera: ' + (r.errorMessage || 'Unknown error'));
                return;
              }
              if (r.assets && r.assets.length) openEditor(r.assets[0]);
            });
          } else {
            const ok = await ensureMediaPermission();
            if (!ok) {
              alert('Media permission is required to select photos.');
              return;
            }
            ImagePicker.launchImageLibrary({ mediaType: 'mixed', selectionLimit: 1 }, (r) => {
              if (r.didCancel) return;
              if (r.errorCode) {
                alert('Failed to open gallery: ' + (r.errorMessage || 'Unknown error'));
                return;
              }
              if (r.assets && r.assets.length) openEditor(r.assets[0]);
            });
          }
        } catch (e) {
          console.error('pickMedia error:', e);
          alert('Failed to open media picker: ' + e.message);
        }
      })();
    } else if (kind === 'files') {
      (async () => {
        try {
          const res = await DocumentPicker.pick({
            type: [DocTypes.allFiles],
            copyTo: 'cachesDirectory',
          });
          if (res && res[0]) {
            const asset = res[0];
            const uri = asset.fileCopyUri || asset.uri;
            sendFile({ uri, name: asset.name, size: asset.size, type: asset.type || 'application/octet-stream' });
          }
        } catch (e) {
          if (DocumentPicker.isCancel(e)) return;
          console.error('DocumentPicker error:', e);
          alert('Failed to pick file: ' + (e.message || 'Unknown error'));
        }
      })();
    }
  };

  const openEditor = (asset) => {
    if (!asset || !asset.uri) return;
    const isVideo = !!(asset.type && asset.type.toLowerCase().startsWith('video'));
    setPreviewAsset({
      uri: asset.uri,
      type: isVideo ? 'VIDEO' : 'IMAGE',
      fileName: asset.fileName || (isVideo ? 'video' : 'photo'),
      mimeType: asset.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
    });
  };

  const handlePreviewSend = (out) => {
    if (!out || !out.uri) return;
    const isVideo = previewAsset ? previewAsset.type === 'VIDEO' : false;
    sendMediaAsset({
      uri: out.uri,
      isVideo,
      mimeType: out.mimeType,
      fileName: out.fileName,
      caption: out.caption,
    });
    setPreviewAsset(null);
  };

  const sendMedia = (asset) => {
    if (!asset || !asset.uri) return;
    const isVideo = !!(asset.type && asset.type.toLowerCase().startsWith('video'));
    sendMediaAsset({
      uri: asset.uri,
      isVideo,
      mimeType: asset.type || (isVideo ? 'video/mp4' : 'image/jpeg'),
      fileName: asset.fileName || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`),
      caption: '',
    });
  };

  const sendMediaAsset = (opts) => {
    if (!opts || !opts.uri) return;
    const isVideo = !!opts.isVideo;
    const tempId = `tmp-${Date.now()}`;
    const content = opts.caption && opts.caption.length ? opts.caption : (isVideo ? '🎬 Video' : '📷 Photo');
    const mimeType = opts.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
    const fileName = opts.fileName || (isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`);
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: isVideo ? 'VIDEO' : 'IMAGE',
      content,
      media_url: opts.uri,
      thumb_url: opts.uri,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    if (atBottomRef.current) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    }
    uploadAsset({ uri: opts.uri, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        const payload = {
          otherUserId,
          type: isVideo ? 'VIDEO' : 'IMAGE',
          content,
          mediaUrl: upData.url,
          thumbUrl: upData.url,
        };
        socket.emit('message:send', payload, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('sendMedia upload failed:', e);
        setMessages((prev) => prev.map((m) =>
          m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m
        ));
      });
  };

  const retrySendMedia = useCallback((msg) => {
    if (!msg || !msg.media_url) return;
    const isFile = msg.type === 'FILE' || msg.type === 'DOCUMENT';
    const isVideo = msg.type === 'VIDEO';
    const tempId = `tmp-${Date.now()}-r`;
    const fileName = isFile
      ? (msg.file_name || msg.content || `file_${Date.now()}`)
      : isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`;
    const mimeType = isFile
      ? (mimeFor(msg) || 'application/octet-stream')
      : isVideo ? 'video/mp4' : 'image/jpeg';
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, id: tempId, _pending: true, _uploading: true, _uploadError: false, _uploadKey: fileName, _uploadProgress: 0 } : m)));
    uploadAsset({ uri: msg.media_url, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: msg.type,
          content: isFile ? fileName : (isVideo ? '🎬 Video' : '📷 Photo'),
          fileName: isFile ? fileName : '',
          mediaSize: isFile ? (msg.media_size || 0) : 0,
          mediaUrl: upData.url,
          thumbUrl: isFile ? '' : upData.url,
        }, (ack) => {
          if (ack?.ok) {
            setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== tempId));
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('retry sendMedia failed:', e);
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _pending: false, _uploading: false, _uploadError: true } : m)));
      });
  }, [otherUserId, socket, currentUser.token, uploadAsset, setUploadProgress]);

  const uploadDrawing = useCallback(async (filePath, onDone) => {
    if (!filePath) return;
    const tempId = `tmp-draw-${Date.now()}`;
    const fileName = `drawing_${Date.now()}.png`;
    const localMsg = {
      id: tempId,
      sender_id: currentUser.id,
      type: 'IMAGE',
      content: '🖌️ Drawing',
      media_url: filePath,
      thumb_url: filePath,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    try {
      const upData = await uploadAsset({ uri: filePath, name: fileName, type: 'image/png' }, (p) => setUploadProgress(tempId, p));
      uploadTasks.current.delete(fileName);
      socket.emit('message:send', {
        otherUserId,
        type: 'IMAGE',
        content: '🖌️ Drawing',
        mediaUrl: upData.url,
        thumbUrl: upData.url,
      }, (ack) => {
        if (ack?.ok) {
          setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...ack.message, _local: true } : m)));
          if (onDone) onDone();
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== tempId));
        }
      });
    } catch (e) {
      uploadTasks.current.delete(fileName);
      console.error('uploadDrawing failed:', e);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _uploading: false, _uploadError: true } : m)));
    }
  }, [otherUserId, socket, currentUser.token, uploadAsset, setUploadProgress]);

  const downloadAndOpen = useCallback(async (message) => {
    if (!message || !message.media_url) return;
    const mime = mimeFor(message);
    const name = message.file_name || fileNameFromUrl(message.media_url) || 'tojey_file';
    try {
      const { dirs } = RNFetchBlob.fs;
      const target = `${dirs.DownloadDir}/${name}`;
      const res = await RNFetchBlob.config({
        fileCache: false,
        path: target,
        addAndroidDownloads: {
          useDownloadManager: true,
          notification: true,
          path: target,
          description: `Tojey file: ${name}`,
          mime,
        },
      }).fetch('GET', absUrl(message.media_url));
      if (Platform.OS === 'android') {
        if (mime === 'application/octet-stream') {
          Alert.alert('Saved', `Downloaded to Download/${name}\nOpen it from your Files app.`);
        } else {
          try {
            await RNFetchBlob.android.actionViewIntent(res.path(), mime);
          } catch (e) {
            console.error('actionViewIntent failed, no handler for mime', mime, e);
            Alert.alert('Saved', `Downloaded to Download/${name}.\nNo app found to preview it here — open it from your Files app.`);
          }
        }
      } else {
        Linking.openURL(absUrl(message.media_url)).catch(() => {});
      }
    } catch (e) {
      console.error('downloadAndOpen failed:', e);
      alert('Could not download file: ' + (e.message || 'Unknown error'));
    }
  }, []);

const isOnline = presence !== null ? presence.isOnline : otherUserOnline;
  const lastSeen = presence !== null ? presence.lastSeen : otherUserLastSeen;
  const headerStatus = typing ? 'typing…' : (isOnline ? 'Online' : lastSeenText(lastSeen));

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Icon name="chevron-back" size={28} color={theme.primary} />
        </TouchableOpacity>
        <View style={[styles.avatarSmall, { backgroundColor: otherUserId === 1 ? theme.primary : theme.primaryDeep }]}>
          {otherUserAvatar ? (
            <Image source={{ uri: absUrl(otherUserAvatar) }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarSmallText}>{otherUserName[0].toUpperCase()}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerName, { color: theme.text }]}>{otherUserName}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {typing && <Icon name="pulse" size={12} color={theme.primary} />}
            <Text style={[styles.headerStatus, { color: typing ? theme.primary : (isOnline ? theme.online : theme.textSecondary) }]}>
              {headerStatus}
            </Text>
          </View>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item, idx) => String(item.id || `tmp-${idx}`)}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
        initialNumToRender={15}
        maxToRenderPerBatch={10}
        updateCellsBatchingPeriod={30}
        windowSize={11}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
      />

      {!atBottomNear && (
        <TouchableOpacity
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setAtBottomNear(true);
            setPendingCount(0);
          }}
          style={[styles.fab, { backgroundColor: theme.primary }]}
          accessibilityLabel="Scroll to bottom"
        >
          {pendingCount > 0 && (
            <View style={[styles.fabBadge, { backgroundColor: theme.danger }]}>
              <Text style={styles.fabBadgeText}>{pendingCount > 99 ? '99+' : pendingCount}</Text>
            </View>
          )}
          <Icon name="arrow-down" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Action menu */}
      {reactionMenu && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={styles.menuBackdrop} onPress={() => setReactionMenu(null)} />
          <View style={[styles.menu, { backgroundColor: theme.card }]}>
            <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Message actions</Text>
            <View style={styles.reactionRow}>
              {quickReactions.map((r) => (
                <TouchableOpacity key={r} onPress={() => reactTo(reactionMenu.id, r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                  <Text style={{ fontSize: 22 }}>{r}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Reply" icon="return-down-back-outline" onPress={() => doAction('reply', reactionMenu)} theme={theme} />
              <ActionBtn label="Like" icon="heart-outline" onPress={() => reactTo(reactionMenu.id, '❤️')} theme={theme} />
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Edit" icon="create-outline" onPress={() => doAction('edit', reactionMenu)} theme={theme} visible={reactionMenu.sender_id === currentUser.id && reactionMenu.type === 'TEXT'} />
              <ActionBtn label="Copy" icon="copy-outline" onPress={() => { if (reactionMenu.content) Clipboard.setString(reactionMenu.content); }} theme={theme} visible={reactionMenu.type === 'TEXT' && !!reactionMenu.content} />
            </View>
            <View style={styles.actionRow}>
              <ActionBtn label="Delete for me" icon="trash-outline" onPress={() => doAction('deleteMe', reactionMenu)} theme={theme} danger visible={reactionMenu.sender_id === currentUser.id} />
              <ActionBtn label="Delete for all" icon="trash" onPress={() => doAction('deleteAll', reactionMenu)} theme={theme} danger visible={reactionMenu.sender_id === currentUser.id} />
            </View>
          </View>
        </View>
      )}

      {/* Replying bar */}
      {replyingTo && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <View style={[styles.replyLine, { backgroundColor: theme.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyTitle, { color: theme.primary }]}>
              Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUserName}
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreview, { color: theme.textSecondary }]}>
              {replyPreview(replyingTo)}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)}>
            <Icon name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Editing bar */}
      {editing && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <View style={[styles.replyLine, { backgroundColor: theme.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyTitle, { color: theme.primary }]}>
              Editing message
            </Text>
            <Text numberOfLines={1} style={[styles.replyPreview, { color: theme.textSecondary }]}>
              {editing.content || ''}
            </Text>
          </View>
          <TouchableOpacity onPress={() => { setEditing(null); setText(''); }}>
            <Icon name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Recording UI */}
      {recording && (
        <View style={[styles.recBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <View style={[styles.recPill, { backgroundColor: theme.primaryLight }]}>
            <View style={[styles.recDot, { backgroundColor: theme.danger }]} />
            <Icon name="mic" size={15} color={theme.danger} />
            <Text style={[styles.recTime, { color: theme.text }]}>
              0:{String(recordTime).padStart(2, '0')}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => stopRecording(true)} style={styles.recCancel} accessibilityLabel="Cancel recording">
            <Icon name="trash-outline" size={18} color={theme.danger} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => stopRecording(false)}
            style={[styles.recSend, { backgroundColor: theme.primary }]}
            accessibilityLabel="Send voice message"
          >
            <Icon name="send" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      )}

      {/* Attach options: Photo · Camera · Files */}
      {showAttach && !recording && (
        <View style={[styles.attachBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <AttachBtn label="Photo" icon="image-outline" color={theme.primary} onPress={() => pickMedia('photo')} theme={theme} />
          <AttachBtn label="Camera" icon="camera-outline" color={theme.primaryDeep} onPress={() => pickMedia('camera')} theme={theme} />
          <AttachBtn label="Files" icon="folder-open-outline" color={theme.primary} onPress={() => pickMedia('files')} theme={theme} />
        </View>
      )}

      {/* Composer */}
      <View style={[styles.composer, { backgroundColor: theme.composerBg, borderTopColor: theme.border }]}>
        {recording ? (
          <View style={{ flex: 1, alignItems: 'center' }}>
            <TouchableOpacity onPress={() => stopRecording(false)} style={[styles.micBtnRec, { backgroundColor: theme.danger }]}>
              <Icon name="stop" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.composerRow}>
            <TouchableOpacity
              style={[styles.composerBtn, { backgroundColor: showAttach ? theme.primary : theme.inputBg }]}
              onPress={() => { Keyboard.dismiss(); setShowAttach(!showAttach); setRecording(false); }}
              accessibilityLabel="Add attachments"
            >
              <Icon name="add" size={24} color={showAttach ? '#fff' : theme.primary} />
            </TouchableOpacity>
            <View style={[styles.inputWrap, { backgroundColor: theme.inputBg }]}>
              <TextInput
                value={text}
                onChangeText={onType}
                placeholder="Type a message"
                placeholderTextColor={theme.textSecondary}
                style={[styles.input, { color: theme.text }]}
                multiline
              />
            </View>
            {text.trim() ? (
              <TouchableOpacity style={[styles.sendBtn, { backgroundColor: theme.primary }]} onPress={sendText} accessibilityLabel="Send message">
                <Icon name="send" size={18} color="#fff" />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.micBtn, { backgroundColor: theme.primary }]}
                onPressIn={startRecording}
                onPressOut={() => stopRecording(false)}
                accessibilityLabel="Record voice message"
              >
                <Icon name="mic" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {mediaViewer && (
        <MediaViewer
          items={mediaViewer.items}
          startIndex={mediaViewer.index}
          headerText={otherUserName}
          currentUserId={currentUser.id}
          theme={theme}
          onClose={() => setMediaViewer(null)}
          onReact={reactTo}
          onReply={(item) => setReplyingTo(item)}
          onDelete={(item, mode) => deleteMessage(item, mode)}
          onSendDrawing={uploadDrawing}
        />
      )}

      {previewAsset && (
        <MediaPreview
          uri={previewAsset.uri}
          type={previewAsset.type}
          fileName={previewAsset.fileName}
          mimeType={previewAsset.mimeType}
          theme={theme}
          onCancel={() => setPreviewAsset(null)}
          onSend={handlePreviewSend}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function ActionBtn({ label, icon, onPress, theme, danger, visible = true }) {
  if (!visible) return null;
  return (
    <TouchableOpacity onPress={onPress} style={[styles.actionBtn, { backgroundColor: theme.primaryLight }]}>
      <Icon name={icon} size={16} color={danger ? theme.danger : theme.primary} />
      <Text style={{ color: danger ? theme.danger : theme.primary, fontWeight: '600', fontSize: 13, marginLeft: 6 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function AttachBtn({ label, icon, color, onPress, theme }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.attachBtn}>
      <View style={[styles.attachIcon, { backgroundColor: theme.inputBg }]}>
        <Icon name={icon} size={24} color={color} />
      </View>
      <Text style={[styles.attachLabel, { color: theme.text }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function lastSeenText(ts) {
  if (!ts) return 'Offline';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'Offline';
  const now = new Date();
  const mins = Math.floor((now - d) / 60000);
  if (mins < 1) return 'Active now';
  if (mins < 60) return `Last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last seen today at ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `Last seen ${d.getDate()}/${d.getMonth() + 1}`;
}

function replyPreview(m) {
  if (!m) return '';
  if (m.is_deleted_for_everyone) return 'This message was deleted';
  if (m.type === 'IMAGE') return '📷 Photo';
  if (m.type === 'VIDEO') return '🎬 Video';
  if (m.type === 'VOICE') return 'Voice message';
  if (m.type === 'FILE' || m.type === 'DOCUMENT') return '📄 ' + (m.content || 'File');
  return m.content || 'Message';
}

function mimeFor(m) {
  if (m.type === 'VIDEO') return 'video/mp4';
  if (m.type === 'IMAGE') return 'image/jpeg';
  const n = (m.content || m.file_name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z')) return 'application/zip';
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (n.endsWith('.m4a')) return 'audio/mp4';
  if (n.endsWith('.ogg')) return 'audio/ogg';
  if (n.endsWith('.mp4') || n.endsWith('.m4v')) return 'video/mp4';
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.3gp')) return 'video/3gpp';
  if (n.endsWith('.mkv')) return 'video/x-matroska';
  if (n.endsWith('.avi')) return 'video/x-msvideo';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.doc') || n.endsWith('.docx')) return 'application/msword';
  if (n.endsWith('.xls') || n.endsWith('.xlsx')) return 'application/vnd.ms-excel';
  if (n.endsWith('.ppt') || n.endsWith('.pptx')) return 'application/vnd.ms-powerpoint';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function fileNameFromUrl(url) {
  if (!url) return null;
  const parts = url.split('/');
  const last = parts[parts.length - 1];
  return last || null;
}

function formatBytes(b) {
  if (!b || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function MessageRowFn({ message, isSent, grouped, theme, onLongPress, onOpenMedia, onRetry, onReply, onDoubleTap, replyPreviewOf, suggestEdit, onEditRow, onCancelUpload }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const translateRef = useRef(0);
  const swipeDirection = isSent ? -1 : 1; // sent bubbles swipe right→left, received left→right
  const replied = useRef(false);

  const swipeAction = (m) => (suggestEdit && onEditRow ? onEditRow(m) : onReply(m));

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && Math.abs(g.dx) < 200,
    onPanResponderMove: (_, g) => {
      let v = swipeDirection === 1 ? Math.max(0, g.dx) : Math.min(0, g.dx);
      translateX.setValue(Math.max(-110, Math.min(110, v)));
    },
    onPanResponderRelease: (_, g) => {
      const trigger = swipeDirection === 1 ? g.dx > 70 : g.dx < -70;
      if (trigger) {
        replied.current = true;
        Animated.spring(translateX, { toValue: swipeDirection * 110, useNativeDriver: true, bounciness: 0, speed: 30 }).start(() => {
          swipeAction(message);
          replied.current = false;
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        });
      } else {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 30 }).start();
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;

  const hasMedia = !!(message.media_url || message.thumb_url);
  const statusIcon = message.status === 'READ'
    ? 'checkmark-done' : message.status === 'DELIVERED'
      ? 'checkmark-done' : 'checkmark';
  const statusColor = message.status === 'READ' ? theme.readBlue : (isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary);

  // Double-tap ↔ single-tap detection (WhatsApp style)
  const lastTap = useRef(0);
  const singleTimer = useRef(null);
  const handlePress = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      clearTimeout(singleTimer.current);
      lastTap.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTap.current = now;
    clearTimeout(singleTimer.current);
    singleTimer.current = setTimeout(() => {
      tapAction(message);
    }, 290);
  };

  const tapAction = (m) => {
    if (m._uploadError && onRetry) {
      onRetry(m);
      return;
    }
    if (m.type === 'IMAGE' || m.type === 'VIDEO' || m.type === 'FILE' || m.type === 'DOCUMENT' || m.type === 'VOICE') {
      onOpenMedia(m);
    }
  };

  const replyRevealStyle = isSent ? styles.revealRight : styles.revealLeft;

  return (
    <View style={[styles.msgRow, { justifyContent: isSent ? 'flex-end' : 'flex-start' }]}>
      <View style={{ maxWidth: '80%', position: 'relative' }}>
        {/* Swipe affordance revealed behind the bubble (reply, or edit for your own text) */}
        <View style={[styles.swipeReveal, replyRevealStyle, { backgroundColor: isSent ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)' }]}>
          <Icon name={suggestEdit ? 'create-outline' : 'arrow-back'} size={14} color="#fff" />
        </View>
        <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
            <TouchableOpacity
              style={[
                styles.bubble,
                isSent ? [styles.sentBubble, { backgroundColor: theme.sentBubble }] : [styles.recvBubble, { backgroundColor: theme.receivedBubble }],
                grouped && { borderBottomRightRadius: isSent ? 6 : 14, borderBottomLeftRadius: isSent ? 14 : 6 },
              ]}
              onPress={handlePress}
              onLongPress={() => { clearTimeout(singleTimer.current); onLongPress(message); }}
              delayLongPress={350}
            >
              {message.is_deleted_for_everyone ? (
                <Text style={{ fontStyle: 'italic', opacity: 0.7, color: isSent ? '#fff' : theme.textSecondary }}>
                  This message was deleted
                </Text>
              ) : message.type === 'IMAGE' || message.type === 'VIDEO' ? (
                <View>
                  <Image
                    source={{ uri: absUrl(message.thumb_url || message.media_url) }}
                    style={[styles.mediaImage, { backgroundColor: isSent ? 'rgba(255,255,255,0.12)' : theme.primaryLight }]}
                    resizeMode="cover"
                  />
                  {(message.type === 'VIDEO' || message._uploading) && (
                    <View style={styles.videoPlayWrap}>
                      {message.type === 'VIDEO' && !message._pending && !message._uploading ? (
                        <View style={styles.videoPlay}>
                          <Icon name="play" size={26} color="#fff" />
                        </View>
                      ) : message._uploading ? (
                        <UploadOverlay progress={message._uploadProgress} onCancel={onCancelUpload ? () => onCancelUpload(message) : null} />
                      ) : null}
                    </View>
                  )}
                  {message._uploadError && (
                    <TouchableOpacity
                      style={[StyleSheet.absoluteFillObject, styles.mediaError, { backgroundColor: 'rgba(0,0,0,0.35)' }]}
                      onPress={() => (onRetry ? onRetry(message) : null)}
                    >
                      <Icon name="alert-circle-outline" size={26} color="#fff" />
                      <Text style={{ color: '#fff', fontSize: 12, marginTop: 4, fontWeight: '600' }}>
                        Tap to retry
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : message.type === 'VOICE' ? (
                <TouchableOpacity onPress={() => onOpenMedia(message)} activeOpacity={0.7} style={{ minWidth: 180 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={[styles.voicePlay, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight }]}>
                      <Icon name="play" size={18} color={isSent ? '#fff' : theme.primary} />
                    </View>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                        {[5, 9, 13, 7, 15, 11, 8, 13, 7, 10].map((h, i) => (
                          <View key={i} style={{ width: 3, height: h, backgroundColor: isSent ? 'rgba(255,255,255,0.9)' : theme.primary, borderRadius: 2 }} />
                        ))}
                      </View>
                      <Text style={{ marginTop: 5, fontSize: 11, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary }}>
                        0:{String(message.duration || 26).padStart(2, '0')} · 1×
                      </Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ) : message.type === 'FILE' || message.type === 'DOCUMENT' ? (
                <View style={[styles.docRow, { backgroundColor: isSent ? 'rgba(255,255,255,0.14)' : theme.primaryLight, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center', minWidth: 200 }]}>
                  <View style={[styles.docIcon, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primary }]}>
                    <Icon name="document" size={18} color="#fff" />
                  </View>
                  <View style={{ marginLeft: 10, flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: isSent ? '#fff' : theme.receivedText, maxWidth: 150 }}>
                      {(message.file_name || message.content || 'Document')}
                    </Text>
                    <Text style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.7)' : theme.textSecondary, marginTop: 2 }}>
                      {formatBytes(message.media_size || 0) || 'File'}
                    </Text>
                    {message._uploading ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                        <ArcProgress size={30} thickness={3} progress={message._uploadProgress} color={isSent ? '#fff' : theme.primary} track={isSent ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.1)'} />
                        <Text style={{ fontSize: 10, marginLeft: 6, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary, fontWeight: '600' }}>
                          {Math.round((message._uploadProgress || 0) * 100)}%
                        </Text>
                        {onCancelUpload && (
                          <TouchableOpacity onPress={() => onCancelUpload(message)} style={{ marginLeft: 8, padding: 3 }} accessibilityLabel="Cancel upload">
                            <Icon name="close" size={14} color={isSent ? '#fff' : theme.textSecondary} />
                          </TouchableOpacity>
                        )}
                      </View>
                    ) : null}
                    {message._uploadError && (
                      <Text style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.85)' : theme.danger, marginTop: 2 }}>
                        Upload failed · tap to retry
                      </Text>
                    )}
                  </View>
                </View>
              ) : (
                <View>
                  {message.reply_to ? (
                    <View style={[styles.replyRef, { backgroundColor: isSent ? 'rgba(255,255,255,0.15)' : theme.primaryLight }]}>
                      <Text style={{ fontWeight: '700', fontSize: 11, color: isSent ? '#fff' : theme.primary }}>Reply</Text>
                      <Text numberOfLines={2} style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary }}>
                        {replyPreviewOf ? replyPreviewOf(message.reply_to) : '…'}
                      </Text>
                    </View>
                  ) : null}
                  <Text style={{ fontSize: 15, color: isSent ? '#fff' : theme.receivedText }}>{message.content}</Text>
                </View>
              )}

              {!message.is_deleted_for_everyone && (
                <View style={styles.msgMeta}>
                  {message.is_view_once && <Icon name="lock-closed" size={10} color={isSent ? '#fff' : theme.textSecondary} />}
                  {message.is_edited && <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.7)' }]}>edited</Text>}
                  <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.75)' }]}>
                    {message.created_at ? timeOf(message.created_at) : ''}
                  </Text>
                  {isSent && <Icon name={statusIcon} size={13} color={statusColor} />}
                </View>
              )}
            </TouchableOpacity>
          </Animated.View>

        {message.reactions && message.reactions.length > 0 && (
          <TouchableOpacity
            onPress={() => onLongPress(message)}
            style={[
              styles.reactionBadge,
              { backgroundColor: theme.primaryLight },
              isSent ? { right: -8 } : { left: -8 },
            ]}
          >
            {message.reactions.map((r, i) => (
              <Text key={i} style={{ fontSize: 11 }}>{r.reaction}</Text>
            ))}
          </TouchableOpacity>
        )}
        </View>
      </View>
  );
}

const MessageRow = memo(MessageRowFn);

function ArcProgress({ size = 56, thickness = 4, progress, color = '#fff', track = 'rgba(255,255,255,0.3)' }) {
  const p = Math.min(Math.max(progress || 0, 0), 1);
  const deg = p * 360 - 90;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: thickness, borderColor: track }} />
      <View
        style={{
          position: 'absolute', width: size, height: size, borderRadius: size / 2,
          borderWidth: thickness,
          borderColor: color, borderTopColor: 'transparent', borderLeftColor: 'transparent',
          transform: [{ rotate: `${deg}deg` }],
        }}
      />
      <Text style={{ color: '#fff', fontSize: Math.max(10, Math.round(size * 0.22)), fontWeight: '700' }}>{Math.round(p * 100)}</Text>
    </View>
  );
}

function UploadOverlay({ progress, onCancel }) {
  return (
    <View style={styles.uploadOverlay}>
      <ArcProgress size={54} thickness={4} progress={progress} />
      <View style={{ height: 4 }} />
      {onCancel && (
        <TouchableOpacity onPress={onCancel} style={styles.uploadCancel} accessibilityLabel="Cancel upload">
          <Icon name="close" size={14} color="#fff" />
        </TouchableOpacity>
      )}
    </View>
  );
}

function timeOf(t) {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1,
  },
  backBtn: { marginRight: 8 },
  avatarSmall: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginRight: 10, overflow: 'hidden' },
  avatarSmallText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  avatarImg: { width: '100%', height: '100%' },
  headerName: { fontSize: 16, fontWeight: '700' },
  headerStatus: { fontSize: 12, marginLeft: 4 },
  messageList: { padding: 14, paddingBottom: 20 },
  msgRow: { flexDirection: 'row', marginVertical: 3 },
  bubble: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, overflow: 'hidden' },
  sentBubble: { borderBottomRightRadius: 4 },
  recvBubble: { borderBottomLeftRadius: 4, borderWidth: 1, borderColor: '#F0EDF8' },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 3 },
  metaText: { fontSize: 10, color: '#9B96A8' },
  replyRef: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, marginBottom: 4, marginLeft: -2, borderLeftWidth: 3, borderLeftColor: '#6C3CE9' },
  reactionBadge: { position: 'absolute', bottom: -8, borderRadius: 12, paddingHorizontal: 6, paddingVertical: 2, flexDirection: 'row', zIndex: 5, elevation: 3 },
  composer: { borderTopWidth: 1, padding: 10, paddingBottom: Platform.OS === 'ios' ? 20 : 12 },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  composerBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  attachBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1 },
  attachBtn: { alignItems: 'center', marginRight: 20 },
  attachIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: 12, marginTop: 6 },
  inputWrap: { flex: 1, borderRadius: 22, paddingHorizontal: 12, maxHeight: 100, justifyContent: 'center' },
  input: { fontSize: 14, paddingVertical: 8, maxHeight: 100 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#6C3CE9', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  micBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#6C3CE9', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  micBtnRec: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', elevation: 5, shadowColor: '#E53935', shadowOpacity: 0.35, shadowRadius: 7, shadowOffset: { width: 0, height: 3 } },
  recBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1 },
  recCancel: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(229,57,53,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  recSend: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  recPill: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  recDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  recTime: { fontSize: 14, fontWeight: '700', marginLeft: 6, fontVariant: ['tabular-nums'] },
  replyBar: { flexDirection: 'row', alignItems: 'center', padding: 10, borderTopWidth: 1 },
  replyLine: { width: 3, height: 32, borderRadius: 2, marginRight: 10 },
  replyTitle: { fontWeight: '700', fontSize: 12 },
  replyPreview: { fontSize: 12 },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  menu: { position: 'absolute', bottom: 90, left: 24, right: 24, borderRadius: 18, padding: 14, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 8 },
  menuTitle: { fontSize: 13, fontWeight: '700' },
  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 12 },
  reactionBtn: { borderRadius: 14, width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  actionRow: { flexDirection: 'row', gap: 10, marginVertical: 6 },
  actionBtn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center' },
  mediaImage: { width: Math.min(APP_W * 0.62, 250), height: Math.min(APP_W * 0.62, 250) * 0.81, borderRadius: 12, marginBottom: 4 },
  uploadOverlay: { alignItems: 'center', justifyContent: 'center', padding: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.35)' },
  uploadCancel: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 16, bottom: 84, width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
  fabBadge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  fabBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  videoPlayWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 6, alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  mediaError: { alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginBottom: 4 },
  voicePlay: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  docIcon: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  swipeReveal: { position: 'absolute', top: 6, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', zIndex: 0 },
  revealLeft: { left: 2 },
  revealRight: { right: 2 },
});