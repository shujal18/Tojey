import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useChat } from '../services/ChatContext';
import { useCall } from '../services/CallContext';
import { useAuth } from '../services/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import {
  ArrowLeft, Mic, Paperclip, Smile, Camera, Send, X, Reply as ReplyIcon,
  Copy, Pencil, Trash, Check, CheckCheck, Lock, Image as ImageIcon, Video, FileText,
  MoreVertical, ChevronRight, Bell,
} from 'lucide-react';
import EmojiPicker from 'emoji-picker-react';
import { VoiceBubble } from '../components/MessageBubble';
import MediaViewer from '../components/MediaViewer';
import DrawingCanvas from '../components/DrawingCanvas';
import MediaPreview from '../components/MediaPreview';
import { quickReactions, getChatColor } from '../theme';
import { uploadFile, makeThumbnail, resolveUrl, formatBytes, isVideoMime, isImageMime } from '../services/upload';

const API = import.meta.env.VITE_API_URL || '';

export default function ChatRoomScreen({ otherUser, currentUser, onBack }) {
  const { theme } = useTheme();
  const { token } = useAuth();
  const { conversation, presence, openConversation, sendMessage, sendNudge, setConversation, showToast, clearConversation } = useChat();
  const { startCall } = useCall();
  const { messages, typing, wallpaper } = conversation;

  useEffect(() => {
    openConversation(otherUser);
  }, [otherUser?.id]);

  useEffect(() => {
    return () => setConversation({ id: null, other: null, messages: [], typing: false });
  }, []);

  // Teardown a still-running recording if the chat unmounts mid-recording.
  useEffect(() => {
    return () => {
      const mr = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      if (mr) {
        mr.onstop = () => {};
        try { if (mr.state !== 'inactive') mr.stop(); } catch (e) {}
      }
      audioChunksRef.current = [];
      if (waveRAFRef.current) cancelAnimationFrame(waveRAFRef.current);
      stopVoiceTracks();
      stopTypingNow();
    };
  }, []);

  const [text, setText] = useState('');
  const [editing, setEditing] = useState(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [reactionBar, setReactionBar] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [lockedRecord, setLockedRecord] = useState(false);
  const [pendingMedia, setPendingMedia] = useState([]);
  const [caption, setCaption] = useState('');
  const [isSendingMedia, setIsSendingMedia] = useState(false);
  const [drawingItem, setDrawingItem] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [showNotifComposer, setShowNotifComposer] = useState(false);
  const [notifMsg, setNotifMsg] = useState('');
  const [notifSending, setNotifSending] = useState(false);
  const [notifResult, setNotifResult] = useState(null);

  const listRef = useRef(null);
  const recTimer = useRef(null);
  const holdTimer = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const analyserRef = useRef(null);
  const audioCtxRef = useRef(null);
  const waveSamplesRef = useRef([]);
  const waveRAFRef = useRef(null);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const typingStopTimerRef = useRef(null);
  const typingActiveRef = useRef(false);
  const recordGenRef = useRef(0);

  const [waveBars, setWaveBars] = useState([5, 9, 13, 18, 11, 7, 15, 20, 9, 14]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, viewing]);

  useEffect(() => {
    if (recording) {
      recTimer.current = setInterval(() => setRecordTime(t => t + 1), 1000);
    } else if (recTimer.current) {
      clearInterval(recTimer.current);
    }
    return () => clearInterval(recTimer.current);
  }, [recording]);

  const emitTyping = () => {
    const s = window.__socket;
    if (!s) return;
    // Only send typing:start once per burst (not on every keystroke); the timer
    // debounces typing:stop so the indicator clears after a pause or on blur/send.
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      s.emit('typing:start', { otherUserId: otherUser.id });
    }
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => {
      if (s && s.connected) s.emit('typing:stop', { otherUserId: otherUser.id });
      typingActiveRef.current = false;
    }, 2500);
  };

  const stopTypingNow = () => {
    const s = window.__socket;
    if (s) s.emit('typing:stop', { otherUserId: otherUser.id });
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingActiveRef.current = false;
  };

  useEffect(() => {
    return () => stopTypingNow();
  }, [otherUser?.id]);

  // The explicit "Send Notification" option: pushes a real notification popup to
  // the other user's device (socket when they are online, FCM when closed).
  const sendNotification = async () => {
    const msg = notifMsg.trim();
    if (!msg) { setNotifResult({ error: 'Write a message first' }); return; }
    setNotifSending(true);
    setNotifResult(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${API}/api/notifications/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` },
        body: JSON.stringify({
          receiverId: otherUser.id,
          message: msg,
          conversationId: conversation.id || null,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        setNotifResult({ error: (data && (data.error || data.message)) || `Server error (${res.status})` });
        return;
      }
      if (data && data.status === 'failed') {
        let errorMsg = data.note || 'Delivery failed';
        if (data.fcmNote === 'fcm-unconfigured') errorMsg = 'Push is disabled on the server. Configure FIREBASE_SERVICE_ACCOUNT_B64 in the Render backend environment to enable FCM.';
        else if (data.fcmNote === 'fcm-rejected') errorMsg = 'FCM rejected the token(s). The receiver may need to reinstall for a fresh push token.';
        setNotifResult({ error: errorMsg });
        return;
      }
      if (!data || !data.ok) {
        setNotifResult({ error: (data && data.error) || 'No response from server' });
        return;
      }
      const via = data.deliveryMethod === 'socket' ? 'live connection' : 'push notification';
      setNotifResult({ ok: true, text: `Notification sent (${via})` });
      setTimeout(() => {
        setShowNotifComposer(false);
        setNotifMsg('');
        setNotifResult(null);
      }, 1600);
    } catch (e) {
      console.error('sendNotification failed:', e);
      if (e.name === 'AbortError') setNotifResult({ error: 'Request timed out. Try again.' });
      else setNotifResult({ error: e.message || 'Failed to send notification' });
    } finally {
      setNotifSending(false);
    }
  };

  const sendText = () => {
    if (!text.trim()) return;
    stopTypingNow();
    if (editing) {
      window.__socket.emit('message:edit', { messageId: editing.id, content: text.trim() });
      setEditing(null);
      setText('');
      return;
    }
    const _tempId = Date.now();
    sendMessage({
      otherUserId: otherUser.id,
      type: 'TEXT',
      content: text.trim(),
      replyTo: replyingTo?.id || null,
      _tempId,
    });
    setText('');
    setReplyingTo(null);
    setShowEmoji(false);
  };

  // ---- Voice recording (real MediaRecorder -> upload -> VOICE message) ----
  const startRecording = async () => {
    const gen = ++recordGenRef.current;
    setRecording(true);
    setRecordTime(0);
    holdTimer.current = setTimeout(() => setLockedRecord(true), 500);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // The user may have cancelled while the permission prompt was open - bail out
      // instead of silently re-activating the recorder.
      if (gen !== recordGenRef.current) {
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        return;
      }
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data && e.data.size) audioChunksRef.current.push(e.data); };
      mr.onstop = () => { const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' }); audioChunksRef.current = []; uploadVoice(blob); };
      mr.start();
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyserRef.current = analyser;
        waveSamplesRef.current = [];
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const liveBars = [5, 9, 13, 18, 11, 7, 15, 20, 9, 14];
        const sample = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
          waveSamplesRef.current.push(Math.sqrt(sum / buf.length));
          const rms = Math.sqrt(sum / buf.length);
          const newBars = liveBars.map((b, i) => Math.max(4, Math.round(rms * 260 * (0.3 + (i % 3) * 0.3))));
          setWaveBars(newBars);
          waveRAFRef.current = requestAnimationFrame(sample);
        };
        waveRAFRef.current = requestAnimationFrame(sample);
      } catch (e) {}
    } catch (e) {
      setRecording(false);
      setLockedRecord(false);
      setRecordTime(0);
      showToast('Microphone access denied');
    }
  };

  const stopRecording = (cancel) => {
    clearTimeout(holdTimer.current);
    if (cancel) {
      cancelVoice();
      return;
    }
    if (recordTime < 1) {
      cancelVoice();
      return;
    }
    finalizeVoice(true);
  };

  const handleHoldEnd = () => {
    if (!lockedRecord) stopRecording(false);
  };

  const cancelVoice = () => {
    cancelRecordingGen();
    setRecording(false);
    setLockedRecord(false);
    setRecordTime(0);
    setWaveBars([5, 9, 13, 18, 11, 7, 15, 20, 9, 14]);
    const mr = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (mr) {
      // Neutralize the upload handler BEFORE stopping so a cancelled recording
      // never gets sent.
      mr.onstop = () => {};
      try { if (mr.state !== 'inactive') mr.stop(); } catch (e) {}
    }
    audioChunksRef.current = [];
    if (waveRAFRef.current) cancelAnimationFrame(waveRAFRef.current);
    waveRAFRef.current = null;
    stopVoiceTracks();
  };

  const cancelRecordingGen = () => { recordGenRef.current += 1; };

  const finalizeVoice = (send) => {
    cancelRecordingGen();
    if (waveRAFRef.current) cancelAnimationFrame(waveRAFRef.current);
    const mr = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    setRecording(false);
    setLockedRecord(false);
    const barsSnapshot = waveBars;
    setWaveBars([5, 9, 13, 18, 11, 7, 15, 20, 9, 14]);
    if (mr) {
      mr.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        if (send) {
          uploadVoice(blob, recordTime, barsSnapshot);
        }
      };
      try { if (mr.state !== 'inactive') mr.stop(); } catch (e) {}
    }
    setRecordTime(0);
    stopVoiceTracks();
  };

  const stopVoiceTracks = () => {
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach(t => t.stop()); } catch (e) {}
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch (e) {}
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  };

  const uploadVoice = async (blob, duration, bars) => {
    try {
      const wave = buildWaveform(waveSamplesRef.current, bars);
      const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
      const up = await uploadFile(file);
      const dur = duration || Math.max(1, Math.round(blob.size / 16000));
      sendMessage({
        otherUserId: otherUser.id,
        type: 'VOICE',
        content: 'Voice message',
        mediaUrl: up.url,
        duration: dur,
        waveform: JSON.stringify(wave),
        fileName: up.filename,
        fileSize: up.size,
        mimeType: up.mimetype,
        replyTo: replyingTo?.id || null,
        _tempId: Date.now() + Math.random(),
      });
    } catch (e) {
      showToast('Voice upload failed');
    }
  };

  // ---- Media attachments ----
  const handleFiles = (files) => {
    setShowAttach(false);
    const fileList = Array.from(files || []);
    if (!fileList.length) return;
    const items = fileList.map((file) => {
      const kind = isImageMime(file.type) ? 'image'
        : isVideoMime(file.type) ? 'video'
          : 'file';
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        kind,
        fileName: file.name || '',
        size: file.size,
        preview: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : '',
      };
    });
    setPendingMedia(prev => [...prev, ...items]);
  };

  const removePending = (id) => setPendingMedia(prev => prev.filter(i => i.id !== id));

  const sendAttachments = async () => {
    if (!pendingMedia.length || isSendingMedia) return;
    setIsSendingMedia(true);
    stopTypingNow();
    // Each item is sent independently; successful ones are dropped from the pending
    // list so a later failure can't cause a retry that re-sends already-sent files.
    const remaining = [];
    const sent = [];
    try {
      for (const item of pendingMedia) {
        try {
          const up = await uploadFile(item.file);
          let thumbUrl = '';
          if (item.kind === 'image') thumbUrl = await makeThumbnail(item.file, 400);
          const type = item.kind === 'image' ? 'IMAGE' : item.kind === 'video' ? 'VIDEO' : 'FILE';
          sendMessage({
            otherUserId: otherUser.id,
            type,
            content: caption.trim(),
            mediaUrl: up.url,
            thumbUrl,
            fileName: item.fileName || up.filename,
            fileSize: item.size || up.size,
            mimeType: up.mimetype,
            replyTo: replyingTo?.id || null,
            _tempId: Date.now() + Math.random(),
          });
          sent.push(item.id);
        } catch (e) {
          remaining.push(item);
        }
      }
      if (sent.length) {
        setPendingMedia(prev => prev.filter(i => !sent.includes(i.id)));
        setCaption('');
        setReplyingTo(null);
      }
      if (remaining.length) {
        showToast(`${remaining.length} item${remaining.length > 1 ? 's' : ''} failed to upload - retry or remove`);
      }
    } finally {
      setIsSendingMedia(false);
    }
  };

  const doneDrawing = (file) => {
    const item = drawingItem;
    setDrawingItem(null);
    if (!item) return;
    setPendingMedia(prev => prev.map(p =>
      p.id === item.id
        ? { ...p, file, kind: 'image', preview: URL.createObjectURL(file), fileName: 'drawing.png' }
        : p
    ));
  };

  const handleLongPress = (e, message) => {
    e.preventDefault();
    e.stopPropagation();
    setReactionBar(message);
  };

  const pres = presence[otherUser.id];
  const isOnline = pres ? !!pres.isOnline : !!(otherUser.is_online ?? otherUser.online);
  const lastSeen = pres?.lastSeen || otherUser.last_seen || otherUser.lastSeen || null;
  const headerText = typing
    ? 'typing…'
    : (isOnline ? 'online' : lastSeenText(lastSeen));

  const sentName = (mid) => messages.find(m => m.id === mid);

  return (
    <div style={{
      height: '100vh',
      maxWidth: 480,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      background: wallpaper ? parseWallpaper(wallpaper, theme) : theme.background,
      position: 'relative',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5, pointerEvents: 'none' }}>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '10px 12px',
        background: wallpaper ? 'rgba(28,25,34,0.85)' : theme.navBg,
        backdropFilter: 'blur(8px)',
        borderBottom: `1px solid ${theme.border}`,
        zIndex: 6,
      }}>
        <button onClick={onBack} style={{ color: wallpaper ? '#fff' : theme.text, padding: 6, marginRight: 4 }}>
          <ArrowLeft size={22} />
        </button>
        <div style={{
          width: 40, height: 40, borderRadius: 20, marginRight: 10,
          background: otherUser.id === 1 ? '#6C3CE9' : '#4E22B8',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 16, overflow: 'hidden', flexShrink: 0,
        }}>
          {otherUser.profile_pic_url
            ? <img src={otherUser.profile_pic_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : otherUser.display_name[0].toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: wallpaper ? '#fff' : theme.text, fontSize: 16, fontWeight: 600 }}>
            {otherUser.display_name}
          </div>
          <div style={{ color: typing ? '#7C4DFF' : (wallpaper ? 'rgba(255,255,255,0.7)' : theme.textSecondary), fontSize: 12 }}>
            {typing ? <TypingDots /> : headerText}
          </div>
        </div>
        <button
          title="Video call"
          onClick={() => startCall(otherUser)}
          style={{ color: '#7C4DFF', padding: 6 }}
        >
          <Video size={21} />
        </button>
        <button
          title="Nudge"
          onClick={() => sendNudge(otherUser.id, otherUser.display_name)}
          style={{
            color: '#7C4DFF',
            padding: 6,
            fontSize: 22,
            lineHeight: 1,
            animation: conversation.nudgePulse && Date.now() - conversation.nudgePulse < 800 ? 'nudgeShake 0.5s ease' : 'none',
          }}
        >
          👋
        </button>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setShowHeaderMenu(s => !s)} style={{ color: wallpaper ? '#fff' : theme.textSecondary, padding: 6 }}>
            <MoreVertical size={20} />
          </button>
          {showHeaderMenu && (
            <div style={{
              position: 'absolute', right: 0, top: 34, zIndex: 30,
              background: theme.card, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.22)',
              padding: 6, minWidth: 180,
            }}>
              <button
                onClick={() => {
                  setShowNotifComposer(true);
                  setShowHeaderMenu(false);
                }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, color: theme.text, fontSize: 14 }}
              >
                <Bell size={16} /> Send Notification
              </button>
              <button
                onClick={() => {
                  clearConversation(otherUser.id);
                  setShowHeaderMenu(false);
                }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, color: theme.danger, fontSize: 14 }}
              >
                <Trash size={16} /> Clear chat
              </button>
              <button
                onClick={() => {
                  setShowAttach(false);
                  setShowEmoji(false);
                  setShowHeaderMenu(false);
                }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, color: theme.text, fontSize: 14 }}
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} style={{
        flex: 1, overflowY: 'auto',
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: 40, color: theme.textSecondary }}>
            <Lock size={28} style={{ margin: '0 auto 10px', opacity: 0.5 }} />
            <p style={{ fontSize: 14 }}>Messages are private</p>
            <p style={{ fontSize: 12, opacity: 0.7 }}>Say hello to {otherUser.display_name}</p>
          </div>
        )}

        {messages.map((m, idx) => {
          const isSent = m.sender_id === currentUser.id;
          const prev = messages[idx - 1];
          const grouped = prev && prev.sender_id === m.sender_id;
          return (
            <MessageRow
              key={m.id || idx}
              message={m}
              myId={currentUser.id}
              isSent={isSent}
              grouped={grouped}
              theme={theme}
              senderName={isSent ? 'You' : otherUser.display_name}
              repliedMessage={m.reply_to ? messages.find(x => x.id === m.reply_to) || null : null}
              onLongPress={handleLongPress}
              onReply={() => { setReplyingTo(m); setReactionBar(null); }}
              onCopy={() => { if (m.content) navigator.clipboard?.writeText(m.content); setReactionBar(null); }}
              onEdit={() => { setText(m.content || ''); setReactionBar(null); }}
              onDelete={(mode) => { deleteMessage(m.id, mode); setReactionBar(null); }}
              onReact={() => setReactionBar(m)}
              onOpenMedia={() => setViewing(m)}
            />
          );
        })}
      </div>

      {/* Reactions bar */}
      {reactionBar && (
        <ReactionMenu message={reactionBar} theme={theme} onReact={(r) => { reactTo(reactionBar.id, r); setReactionBar(null); }} onReply={() => { setReplyingTo(reactionBar); setReactionBar(null); }} onCopy={() => { if (reactionBar.content) navigator.clipboard?.writeText(reactionBar.content); setReactionBar(null); }} onEdit={() => { setEditing(reactionBar); setText(reactionBar.content || ''); setReactionBar(null); }} onDelete={(mode) => { deleteMessage(reactionBar.id, mode); setReactionBar(null); }} isMine={reactionBar.sender_id === currentUser.id} />
      )}

      {/* Replying bar */}
      {replyingTo && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '8px 14px', background: theme.card,
          borderTop: `1px solid ${theme.border}`,
          fontSize: 13,
        }}>
          <div style={{ width: 3, height: 32, background: theme.primary, borderRadius: 2, marginRight: 10 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: theme.primary, fontWeight: 600, fontSize: 12 }}>
              Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUser.display_name}
            </div>
            <div style={{ color: theme.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {replyPreview(replyingTo)}
            </div>
          </div>
          <button onClick={() => setReplyingTo(null)} style={{ color: theme.textSecondary }}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Editing bar */}
      {editing && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '8px 14px', background: theme.card,
          borderTop: `1px solid ${theme.border}`,
          fontSize: 13,
        }}>
          <div style={{ width: 3, height: 32, background: theme.primary, borderRadius: 2, marginRight: 10 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: theme.primary, fontWeight: 600, fontSize: 12 }}>
              Editing message
            </div>
            <div style={{ color: theme.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {editing.content || ''}
            </div>
          </div>
          <button onClick={() => { setEditing(null); setText(''); }} style={{ color: theme.textSecondary }}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Pending media strip */}
      <MediaPreview
        items={pendingMedia}
        isSending={isSendingMedia}
        onRemove={removePending}
        onCancel={() => setPendingMedia([])}
        onDraw={setDrawingItem}
        onCaption={setCaption}
        caption={caption}
        onSend={sendAttachments}
      />

      {/* Recording UI */}
      {recording && (
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '12px 16px', background: theme.card,
          borderTop: `1px solid ${theme.border}`,
        }}>
          <button onClick={() => stopRecording(true)} style={{ color: theme.danger, marginRight: 12 }}>
            <X size={22} />
          </button>
          {waveBars.map((h, i) => (
            <span key={i} className="wave-bar" style={{
              width: 3, height: `${h}px`,
              background: theme.primary, marginRight: 2,
              animationDelay: `${i * 0.08}s`,
            }} />
          ))}
          <span style={{ marginLeft: 'auto', color: theme.text, fontWeight: 600, fontSize: 14 }}>
            0:{String(recordTime).padStart(2, '0')}
          </span>
        </div>
      )}

      {/* Composer + attachment menu */}
      {showAttach && !recording && (
        <div style={{
          display: 'flex', gap: 6,
          padding: '8px 14px', background: theme.card,
          borderTop: `1px solid ${theme.border}`,
        }}>
          {[
            { icon: <ImageIcon size={18} />, label: 'Gallery', action: () => fileInputRef.current?.click() },
            { icon: <Camera size={18} />, label: 'Camera', action: () => cameraInputRef.current?.click() },
            { icon: <FileText size={18} />, label: 'File', action: () => { const el = fileInputRef.current; if (el) { el.removeAttribute('accept'); el.click(); el.setAttribute('accept', ''); } } },
          ].map(opt => (
            <button key={opt.label} onClick={opt.action} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              padding: '10px 0', borderRadius: 12, background: theme.inputBg, color: theme.text,
              fontSize: 13, fontWeight: 600,
            }}>
              <span style={{ color: theme.primary }}>{opt.icon}</span>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <div style={{
        background: theme.composerBg,
        borderTop: `1px solid ${theme.border}`,
        padding: '8px 10px',
        paddingBottom: 14,
      }}>
        {showEmoji && (
          <div style={{ marginBottom: 8, borderRadius: 12, overflow: 'hidden' }}>
            <EmojiPicker onEmojiClick={(e) => setText(t => t + e.emoji)} width="100%" height={260} theme={theme.isDark ? 'dark' : 'light'} />
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconBtn onClick={() => setShowEmoji(!showEmoji)} icon={<Smile size={22} />} theme={theme} active={showEmoji} />
          <IconBtn onClick={() => { setShowAttach(!showAttach); setShowEmoji(false); }} icon={<Paperclip size={20} />} theme={theme} active={showAttach} />

          <div style={{
            flex: 1, display: 'flex', alignItems: 'center',
            background: theme.inputBg, borderRadius: 22, padding: '8px 14px',
          }}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendText()}
              onInput={() => emitTyping()}
              onBlur={() => stopTypingNow()}
              placeholder="Message"
              style={{ flex: 1, background: 'transparent', color: theme.text, fontSize: 14 }}
            />
          </div>

          <IconBtn onClick={() => cameraInputRef.current?.click()} icon={<Camera size={22} />} theme={theme} />

          {text.trim() ? (
            <button onClick={sendText} style={{
              width: 42, height: 42, borderRadius: 21,
              background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 3px 10px rgba(108,60,233,0.4)',
            }}>
              <Send size={18} />
            </button>
          ) : (
            <div style={{ position: 'relative' }}
              onMouseDown={startRecording}
              onMouseUp={handleHoldEnd}
              onMouseLeave={() => recording && !lockedRecord && stopRecording(true)}
            >
              {recording ? (
                <button onClick={() => stopRecording(false)} style={{
                  width: 42, height: 42, borderRadius: 21,
                  background: theme.danger, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  animation: 'splashPulse 1s infinite',
                }}>
                  <Send size={16} />
                </button>
              ) : (
                <button style={{
                  width: 42, height: 42, borderRadius: 21,
                  background: 'linear-gradient(135deg, #6C3CE9 0%, #4E22B8 100%)',
                  color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 3px 10px rgba(108,60,233,0.4)',
                }}>
                  <Mic size={18} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {viewing && (
        <MediaViewer
          message={viewing}
          senderName={viewing.sender_id === currentUser.id ? 'You' : otherUser.display_name}
          onClose={() => setViewing(null)}
        />
      )}

      {drawingItem && (
        <DrawingCanvas
          imageUrl={drawingItem.preview}
          onCancel={() => setDrawingItem(null)}
          onDone={doneDrawing}
        />
      )}

      {/* Send Notification composer */}
      {showNotifComposer && (
        <div onClick={() => { if (!notifSending) { setShowNotifComposer(false); setNotifResult(null); } }} style={{
          position: 'absolute', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: '100%', maxWidth: 360, background: theme.card, borderRadius: 16,
            padding: 18, boxShadow: '0 14px 50px rgba(0,0,0,0.35)',
          }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: theme.text }}>Send Notification</div>
            <div style={{ fontSize: 13, color: theme.textSecondary, marginTop: 3 }}>To {otherUser.display_name}</div>
            <textarea
              value={notifMsg}
              onChange={(e) => { setNotifMsg(e.target.value); setNotifResult(null); }}
              placeholder="Notification message…"
              maxLength={200}
              rows={3}
              autoFocus
              style={{
                width: '100%', marginTop: 12, padding: '10px 12px', borderRadius: 10,
                border: `1px solid ${theme.border}`,
                background: theme.inputBg, color: theme.text, fontSize: 14, resize: 'none',
                outline: 'none', fontFamily: 'inherit',
              }}
            />
            {notifResult && (
              <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: notifResult.error ? theme.danger : theme.online }}>{notifResult.error || notifResult.text}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
              <button onClick={() => { setShowNotifComposer(false); setNotifResult(null); }} disabled={notifSending} style={{
                padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: theme.inputBg, color: theme.text, fontWeight: 600, fontSize: 14,
              }}>Cancel</button>
              <button onClick={sendNotification} disabled={notifSending} style={{
                padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
                background: 'linear-gradient(135deg,#6C3CE9,#4E22B8)', color: '#fff', fontWeight: 700, fontSize: 14,
              }}>{notifSending ? 'Sending…' : 'Send'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function deleteMessage(id, mode) {
    if (!window.__socket) return;
    window.__socket.emit('message:delete', { messageId: id, mode });
    if (mode === 'everyone') {
      setConversation(prev => ({
        ...prev,
        messages: prev.messages.map(m => (m.id === id ? { ...m, is_deleted_for_everyone: true, content: null, media_url: null } : m)),
      }));
    } else {
      setConversation(prev => ({ ...prev, messages: prev.messages.filter(m => m.id !== id) }));
    }
  }

  function reactTo(id, r) {
    if (!window.__socket) return;
    window.__socket.emit('message:react', { messageId: id, reaction: r });
    setConversation(prev => ({
      ...prev,
      messages: prev.messages.map(m => {
        if (m.id !== id) return m;
        const existing = (m.reactions || []).filter(x => x.user_id !== currentUser.id);
        return { ...m, reactions: r ? [...existing, { user_id: currentUser.id, reaction: r }] : existing };
      }),
    }));
  }
}

function buildWaveform(samples, fallbackBars) {
  const n = 28;
  const out = [];
  if (!samples || !samples.length) {
    if (fallbackBars && fallbackBars.length > 1) return [...fallbackBars];
    return Array(n).fill(10);
  }
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * samples.length) / n);
    const end = Math.floor(((i + 1) * samples.length) / n);
    let max = 0;
    for (let j = start; j < end; j++) max = Math.max(max, samples[j] || 0);
    out.push(Math.round(6 + Math.min(max, 1) * 18));
  }
  return out;
}

function replyPreview(m) {
  if (!m) return '';
  if (m.type === 'VOICE') return '🎤 Voice message';
  if (m.type === 'IMAGE') return '📷 Photo';
  if (m.type === 'VIDEO') return '🎬 Video';
  if (m.type === 'FILE') return '📎 File';
  return m.content || 'Media message';
}

function parseWallpaper(wp, theme) {
  if (!wp) return theme.background;
  if (wp.url.startsWith('linear') || wp.url.startsWith('radial')) return wp.url;
  return theme.background;
}

function IconBtn({ icon, onClick, theme, active }) {
  return (
    <button onClick={onClick} style={{
      color: active ? theme.primary : theme.textSecondary,
      padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {icon}
    </button>
  );
}

function TypingDots() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      typing{' '}
      {[0, 1, 2].map(i => (
        <span key={i} className="typing-dot" style={{
          background: '#7C4DFF', animationDelay: `${i * 0.2}s`,
          width: 5, height: 5,
        }} />
      ))}
    </span>
  );
}

function MessageRow({ message, myId, isSent, grouped, theme, senderName, repliedMessage, onLongPress, onReply, onCopy, onEdit, onDelete, onReact, onOpenMedia }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: isSent ? 'flex-end' : 'flex-start',
      marginTop: grouped ? 2 : 12,
    }}>
      <div style={{
        maxWidth: '80%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isSent ? 'flex-end' : 'flex-start',
      }}>
        <div
          onContextMenu={(e) => onLongPress(e, message)}
          onDoubleClick={(e) => onLongPress(e, message)}
          style={{
            background: isSent ? getChatColor() : '#1e2529',
            color: isSent ? '#fff' : '#E8EAEC',
            padding: message.type === 'IMAGE' || message.type === 'VIDEO' ? 4 : '7px 11px',
            paddingLeft: message.type === 'IMAGE' || message.type === 'VIDEO' ? 4 : undefined,
            paddingRight: message.type === 'IMAGE' || message.type === 'VIDEO' ? 4 : undefined,
            borderRadius: 14,
            borderBottomRightRadius: isSent ? (grouped ? 6 : 4) : 14,
            borderBottomLeftRadius: isSent ? 14 : (grouped ? 6 : 4),
            border: isSent ? 'none' : '1px solid rgba(255,255,255,0.07)',
            boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
            animation: 'message-enter 0.25s ease',
            position: 'relative',
            userSelect: 'text',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            maxWidth: '100%',
          }}
        >
          {message.reply_to && (
            <div style={{
              marginBottom: 4, marginLeft: -2, padding: '3px 8px',
              background: isSent ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)',
              borderRadius: 6, borderLeft: '3px solid #6C3CE9',
              fontSize: 11, cursor: 'pointer',
            }} onClick={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 700, color: isSent ? '#fff' : '#9C86F5' }}>
                {repliedMessage ? (repliedMessage.sender_id === myId ? 'You' : senderName) : 'Reply'}
              </div>
              <div style={{ color: isSent ? 'rgba(255,255,255,0.8)' : 'rgba(232,234,236,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                {repliedMessage ? replyPreview(repliedMessage) : '…'}
              </div>
            </div>
          )}

          {renderContent(message, isSent, theme, onOpenMedia)}
          {message.media_url && message.type === 'FILE' && <FileCard message={message} isSent={isSent} theme={theme} onOpen={() => window.open(resolveUrl(message.media_url), '_blank')} />}

          {!message.is_deleted_for_everyone && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 3, padding: '0 4px 2px' }}>
              {message.is_view_once && <Lock size={10} color={isSent ? '#fff' : '#9B96A8'} />}
              {message.is_edited && <span style={{ fontSize: 10, opacity: 0.7, color: isSent ? 'rgba(255,255,255,0.7)' : '#9B96A8' }}>edited</span>}
              <span style={{ fontSize: 10, color: isSent ? 'rgba(255,255,255,0.75)' : '#9B96A8' }}>
                {timeOf(message.created_at)}
              </span>
              {isSent && (message.status === 'READ'
                ? <CheckCheck size={message.status === 'READ' ? 15 : 13} color="#53C3FF" />
                : message.status === 'DELIVERED'
                  ? <CheckCheck size={13} color="rgba(255,255,255,0.85)" />
                  : <Check size={13} color="rgba(255,255,255,0.85)" />)}
            </div>
          )}

          {message.is_deleted_for_everyone && (
            <div style={{ fontStyle: 'italic', opacity: 0.7, fontSize: 13, color: isSent ? 'rgba(255,255,255,0.8)' : '#9B96A8' }}>
              This message was deleted
            </div>
          )}
        </div>

        {message.is_view_once && (
          <div style={{ fontSize: 10, color: theme.textSecondary, marginTop: 2, display: 'flex', gap: 3, alignItems: 'center' }}>
            <Lock size={10} /> View once
          </div>
        )}

        {message.reactions && message.reactions.length > 0 && (
          <div style={{
            background: theme.primaryLight,
            borderRadius: 14, padding: '2px 8px',
            marginTop: -8, position: 'relative',
            fontSize: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          }}>
            {message.reactions.map((r, i) => (
              <span key={i} style={{ marginRight: 4 }}>{r.reaction}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  function renderContent(m, sent, th, openMedia) {
    switch (m.type) {
      case 'VOICE':
        return <div style={{ padding: '3px' }}><VoiceBubble message={m} isSent={sent} /></div>;
      case 'IMAGE':
        return (
          <div>
            {m.media_url ? (
              <img
                src={resolveUrl(m.media_url)}
                alt=""
                onClick={(e) => { e.stopPropagation(); openMedia(); }}
                style={{
                  display: 'block', maxWidth: 250, maxHeight: 300, borderRadius: 10, cursor: 'zoom-in',
                  background: '#1C1922',
                }}
              />
            ) : (
              <div style={{ opacity: 0.9 }}>📷 Photo</div>
            )}
            {m.content && <div style={{ padding: '2px 8px 4px', fontSize: 14, marginTop: 2 }}>{m.content}</div>}
          </div>
        );
      case 'VIDEO':
        return (
          <div>
            {m.media_url ? (
              <video
                src={resolveUrl(m.media_url)}
                controls
                preload="metadata"
                onClick={(e) => e.stopPropagation()}
                style={{ display: 'block', maxWidth: 250, maxHeight: 300, borderRadius: 10, background: '#000' }}
              />
            ) : (
              <div style={{ opacity: 0.9 }}>🎬 Video</div>
            )}
            {m.content && <div style={{ padding: '2px 8px 4px', fontSize: 14 }}>{m.content}</div>}
          </div>
        );
      default:
        return <span style={{ fontSize: 15 }}>{m.content || ''}</span>;
    }
  }
}

function FileCard({ message, isSent, theme, onOpen }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onOpen(); }} style={{
      display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
      background: isSent ? 'rgba(255,255,255,0.14)' : theme.primaryLight,
      borderRadius: 10, padding: '8px 10px', margin: 2,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: isSent ? 'rgba(255,255,255,0.2)' : theme.primary,
        color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <FileText size={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: isSent ? '#fff' : '#E8EAEC', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
          {message.file_name || message.content || 'File'}
        </div>
        <div style={{ fontSize: 11, color: isSent ? 'rgba(255,255,255,0.75)' : theme.textSecondary }}>
          {formatBytes(message.file_size || message.media_size)}
        </div>
      </div>
      <ChevronRight size={16} style={{ marginLeft: 4, color: isSent ? 'rgba(255,255,255,0.8)' : theme.textSecondary }} />
    </button>
  );
}

function timeOf(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ReactionMenu({ message, theme, onReact, onReply, onCopy, onEdit, onDelete, isMine }) {
  return (
    <div style={{
      position: 'absolute', bottom: 90, left: 0, right: 0,
      display: 'flex', justifyContent: 'center',
      zIndex: 20, animation: 'pop 0.2s ease',
      pointerEvents: 'none',
    }}>
      <div style={{
        background: theme.card, borderRadius: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.2)',
        padding: 12, width: 'min(92%, 380px)',
        pointerEvents: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ color: theme.textSecondary, fontSize: 12 }}>Message actions</span>
          <button onClick={onReact} style={{ color: theme.primary, fontSize: 13, fontWeight: 600 }}>React +</button>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 10 }}>
          {quickReactions.map(r => (
            <button key={r} onClick={() => onReact(r)} style={{
              fontSize: 22, background: theme.primaryLight, borderRadius: 12,
              width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'transform 0.1s',
            }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 6 }}>
          {[
            { icon: <ReplyIcon size={16} />, label: 'Reply', action: onReply },
            { icon: <Copy size={16} />, label: 'Copy', action: onCopy },
            ...(isMine ? [{ icon: <Pencil size={16} />, label: 'Edit', action: onEdit }] : []),
            ...(isMine ? [{ icon: <Trash size={16} />, label: 'Delete for everyone', action: () => onDelete('everyone') }] : []),
            ...(isMine ? [{ icon: <Trash size={16} />, label: 'Delete for me', action: () => onDelete('me') }] : []),
          ].map(item => (
            <button key={item.label} onClick={item.action} style={{
              width: '100%', display: 'flex', alignItems: 'center',
              padding: '8px 10px', borderRadius: 10, color: theme.text,
              fontSize: 14, gap: 10, textAlign: 'left',
            }}>
              <span style={{ color: theme.primary }}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function lastSeenText(ts) {
  if (!ts) return 'offline';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return 'offline';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'active now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen today at ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `last seen ${d.getDate()}/${d.getMonth() + 1}`;
}