import React, { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect, memo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, Image, Keyboard, Linking, Modal, ActivityIndicator, Alert,
  Animated, PanResponder, Dimensions, ScrollView, AppState, LayoutAnimation, UIManager, DeviceEventEmitter,
} from 'react-native';
import { useTheme } from '../theme/ThemeContext';
import { Icon } from '../components/AppIcon';
import { reactionPopRow } from '../theme';
import ColorEmoji, { emojiRuns, splitEmoji, EmojiOnlyView } from '../components/ColorEmoji';
import { fs } from '../utils/size';
import Toast from '../components/Toast';
import { playNudgeVibration } from '../services/nudge';
import {
  getChatHeadEnabled, showChatHead, hideChatHead, canDrawOverlay, getNudgeVibrationEnabled,
  getEnterToSend,
} from '../services/chatHead';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Full reaction set shown when the + on the reaction bar is tapped (reactions only).
const sheetReactions = ['❤️', '😂', '😁', '😮', '😢', '🙏', '🫂', '🎉', '🔥', '😍', '👏', '💯'];
import { absUrl, SERVER_URL, CHAT_BACKGROUND } from '../config';
import Clipboard from '@react-native-clipboard/clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFetchBlob from 'rn-fetch-blob';
import DocumentPicker, { types as DocTypes } from 'react-native-document-picker';
import { ensureCameraPermission, ensureMediaPermission, ensureMicPermission, getMicPermissionStatus } from '../services/permissions';
import { useCall } from '../services/CallContext';
import { loadMessages, saveMessages, clearConversationCache, enqueueOutgoing, loadOutgoingQueue, dequeueOutgoing, flushAllOutgoingQueues } from '../services/cache';
import MediaViewer from '../components/MediaViewer';
import MediaPreview from '../components/MediaPreview';
import {
  startVoiceRecording, trackVoiceRecording, stopVoiceRecording, deleteVoiceFile,
  playVoice, stopVoicePlayback, resetVoice, pauseVoiceRecording, resumeVoiceRecording,
  getVoiceRecordingElapsedMs, parseDuration, voiceErrorMessage,
} from '../services/voice';

const { width: APP_W, height: APP_H } = Dimensions.get('window');
const VOICE_QUEUE_KEY = '@tojey_voice_outbox';
const VOICE_BARS = 34;
const REC_BARS = 28;

// WhatsApp-like fixed incoming bubble color (constant, never tinted by theme/chat color).
const INCOMING_MESSAGE_COLOR = '#1e2529';
// Emoji quick-pick strip used by the composer's emoji button (unique set).
const emojiQuick = ['😁','❤️','😂','😮','😢','🙏','🫂','🎉','🔥','😍','👏','💯','😄','😁','😘','🤗','😅','🙃','🫡','💀','👻','🎂','⚽','🎧','☕','🚗','✌️','🙌','🤝','🥳'];

// Defensive shape guard: every row rendered by MessageRow goes through this, so a
// single malformed/cached/legacy payload can never crash the whole chat screen.
function normalizeMessage(m) {
  const base = (m && typeof m === 'object') ? m : {};
  let reactions = base.reactions;
  if (typeof reactions === 'string') {
    try { reactions = JSON.parse(reactions); } catch (e) { reactions = []; }
  }
  if (!Array.isArray(reactions)) reactions = [];
  // Server ids are positive integers; coerce numeric-looking ids so identity checks
  // (isServerId / dedup set) stay robust even after a JSON round-trip through cache.
  const rawId = base.id;
  const numId = /^\d+$/.test(String(rawId)) ? Number(rawId) : NaN;
  return {
    ...base,
    id: Number.isFinite(numId) && numId > 0 ? numId : (rawId || `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    type: base.type || 'TEXT',
    sender_id: Number(base.sender_id) || 0,
    content: base.content == null ? null : String(base.content),
    media_url: base.media_url || '',
    thumb_url: base.thumb_url || '',
    file_name: base.file_name || '',
    media_size: Number(base.media_size) || 0,
    duration: parseDuration(base.duration),
    status: base.status || 'SENT',
    reactions,
    created_at: base.created_at || null,
    client_id: base.client_id || base.clientId || null,
    _tempId: base._tempId || base.client_id || base.clientId || null,
  };
}

// True for rows with a real (positive numeric) server id. Temp/pending rows carry the
// clientId string instead and are never treated as mergeable server identity.
function isServerId(m) {
  return !!m && typeof m.id === 'number' && m.id > 0;
}
function isLocalOnly(m) {
  return !!m && (!isServerId(m) || !!(m._queued || m._uploading || m._pending || m._uploadError));
}
function keepReceiptStatus(current, incoming) {
  return current === 'READ' || current === 'DELIVERED' ? current : (incoming || 'SENT');
}
function resample(values, count) {
  if (!values.length) return [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(values[Math.min(values.length - 1, Math.floor((i * values.length) / count))]);
  }
  return out;
}
function parseWaveform(raw, count = VOICE_BARS) {
  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim();
    if (t.startsWith('[')) {
      try { list = JSON.parse(t); } catch (e) { list = []; }
    } else {
      list = t.split(',');
    }
  }
  const nums = (Array.isArray(list) ? list : [])
    .map((v) => Number(v && typeof v === 'object' ? (v.level ?? v.amplitude ?? v.value ?? v.v) : v))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.abs(v));
  if (!nums.length) {
    return {
      real: false,
      bars: Array.from({ length: count }, (_, i) => 0.22 + 0.16 * Math.abs(Math.sin(i * 0.9))),
    };
  }
  const max = Math.max(...nums, 0.0001);
  const bars = resample(nums, count).map((v) => Math.min(1, Math.max(0.12, v / max)));
  return { real: true, bars };
}
function serializeWaveform(bars) {
  if (!Array.isArray(bars) || !bars.length) return '';
  return bars.map((b) => Math.max(1, Math.min(20, Math.round(Number(b) * 20 || 1)))).join(',');
}
async function readVoiceQueue() {
  try {
    const raw = await AsyncStorage.getItem(VOICE_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}
async function writeVoiceQueue(list) {
  try {
    await AsyncStorage.setItem(VOICE_QUEUE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  } catch (e) {
    console.warn('voice queue write failed', e);
  }
}
function deriveRecordingLevel(elapsedMs) {
  const t = Math.max(0, Number(elapsedMs) || 0);
  return Math.min(1, Math.max(0.12, 0.2 + 0.62 * Math.abs(Math.sin(t / 210)) * (0.55 + 0.45 * Math.abs(Math.sin(t / 67)))));
}
function mergeServerRow(prev, incoming, ownId, allowUpdate = true) {
  const m = normalizeMessage(incoming);
  if (!isServerId(m)) return prev;
  const id = Number(m.id);
  const idx = prev.findIndex((x) => isServerId(x) && Number(x.id) === id);
  if (idx >= 0) {
    if (!allowUpdate) return prev;
    const cur = prev[idx];
    const same = cur.content === m.content && cur.type === m.type &&
      (cur.media_url || '') === (m.media_url || '') && (cur.thumb_url || '') === (m.thumb_url || '') &&
      cur.is_edited === m.is_edited && cur.is_deleted_for_everyone === m.is_deleted_for_everyone &&
      cur.reply_to === m.reply_to && cur.is_view_once === m.is_view_once &&
      (cur.file_name || '') === (m.file_name || '') && (cur.duration || 0) === (m.duration || 0) &&
      (cur.waveform || '') === (m.waveform || '') && cur.status === m.status &&
      JSON.stringify(cur.reactions || []) === JSON.stringify(m.reactions || []);
    if (same) return prev;
    const copy = prev.slice();
    copy[idx] = {
      ...m,
      _local: cur._local,
      _queued: cur._queued,
      _uploading: cur._uploading,
      _pending: cur._pending,
      _uploadError: cur._uploadError,
      _uploadProgress: cur._uploadProgress,
      _tempId: cur._tempId || m._tempId || null,
      status: keepReceiptStatus(cur.status, m.status),
    };
    return copy;
  }
  const tempIdx = m.client_id
    ? prev.findIndex((x) => !isServerId(x) && String(x.client_id || x._tempId || '') === String(m.client_id))
    : -1;
  const row = { ...m, _local: m.sender_id === ownId };
  if (tempIdx >= 0) {
    const cur = prev[tempIdx];
    const copy = prev.slice();
    copy[tempIdx] = {
      ...row,
      _tempId: cur._tempId || row._tempId || null,
      _queued: false,
      _uploading: false,
      _pending: false,
      _uploadError: false,
      _uploadProgress: 1,
      status: keepReceiptStatus(cur.status, row.status),
    };
    return copy;
  }
  return insertSorted(prev, row);
}
function mergeServerBatch(prev, incoming, ownId, allowUpdate = true) {
  if (!Array.isArray(incoming) || !incoming.length) return prev;
  let next = prev;
  for (const raw of incoming) next = mergeServerRow(next, raw, ownId, allowUpdate);
  return next;
}
function sortKey(m) {
  const t = m && m.created_at ? new Date(m.created_at).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}
// Insert one message into an array sorted by (created_at, id), returning a new array.
// Fast path for the common chronological append avoids any scanning.
function insertSorted(arr, msg) {
  const k = sortKey(msg);
  const id = typeof msg.id === 'number' ? msg.id : -1;
  const last = arr[arr.length - 1];
  if (!last || sortKey(last) < k || (sortKey(last) === k && ((typeof last.id !== 'number' ? -1 : last.id)) <= id)) {
    return arr.concat(msg);
  }
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const mk = sortKey(arr[mid]);
    const midId = typeof arr[mid].id === 'number' ? arr[mid].id : -1;
    if (mk > k || (mk === k && midId > id)) hi = mid;
    else lo = mid + 1;
  }
  const next = arr.slice(0, lo);
  next.push(msg);
  next.push(...arr.slice(lo));
  return next;
}

// Isolates a single failing row so one bad message can't blank the whole chat.
// Renders a disabled placeholder bubble in its place.
class RowBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error('Chat row render error:', error && error.message);
  }
  componentDidUpdate(prev) {
    if (prev.rowKey !== this.props.rowKey && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) {
      return (
        <View style={[styles.msgRow, { justifyContent: this.props.isSent ? 'flex-end' : 'flex-start' }]}>
          <View style={[styles.bubble, { backgroundColor: INCOMING_MESSAGE_COLOR, opacity: 0.55 }]}>
            <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: fs(12) }}>Message could not be displayed</Text>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

export default function ChatRoomScreen({ socket, currentUser, otherUser, onBack }) {
  const { theme } = useTheme();
  const { callStatus, headerCallPress } = useCall();
  const safeOtherUser = otherUser || { id: 0, display_name: 'Unknown', username: '', profile_pic_url: '', online: false, last_seen: null };
  const otherUserId = safeOtherUser.id;
  const otherUserName = safeOtherUser.display_name || safeOtherUser.username || 'Unknown';
  const otherUsername = safeOtherUser.username || otherUserName;
  const otherUserBio = safeOtherUser.bio || '';
  const otherUserAvatar = safeOtherUser.profile_pic_url || '';
  const otherUserOnline = safeOtherUser.online ?? false;
  const otherUserLastSeen = safeOtherUser.last_seen ?? null;
  const currentUserAvatar = (currentUser && (currentUser.profile_pic_url || currentUser.profilePic)) || '';
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [reactionMenu, setReactionMenu] = useState(null);
  const [reactionPop, setReactionPop] = useState(null);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [selMenu, setSelMenu] = useState(false);
  const [nudgeToast, setNudgeToast] = useState('');
  const [sendFlash, setSendFlash] = useState(false);
  const sendScale = useRef(new Animated.Value(1)).current;
  const sendFlashTimerRef = useRef(null);
  const cameraTimeoutRef = useRef(null);
  const [nudgeMenuVisible, setNudgeMenuVisible] = useState(false);
  const chatHeadOnRef = useRef(false);
  // Enter-to-send is read into a ref, not state, so the input's props stay stable
  // while typing (a state change here would re-render the whole room per tap).
  const enterSendRef = useRef(false);
  const lastEnterSentRef = useRef(null);
  const allowNewlineRef = useRef(false);
  const appVisibleRef = useRef(true);
  const headUnreadRef = useRef(0);
  const [recording, setRecording] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [recWaveform, setRecWaveform] = useState(() => Array.from({ length: REC_BARS }, () => 0.14));
  const [playingVoiceId, setPlayingVoiceId] = useState(null);
  const [voiceProgress, setVoiceProgress] = useState(0);
  const [voiceDurationMs, setVoiceDurationMs] = useState(0);
  const playingIdRef = useRef(null);
  const recWaveRef = useRef([]);
  const recHasMeteringRef = useRef(false);
  const recDurationRef = useRef(0);
  const recPausedRef = useRef(false);
  const recStoppingRef = useRef(false);
  const recLastUiRef = useRef(0);
  const voiceNameRef = useRef(null);
  const voiceProgressRef = useRef(0);
  const voiceLastTickRef = useRef(0);
  const voiceQueueBusyRef = useRef(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [composerH, setComposerH] = useState(0);
  const [barHeights, setBarHeights] = useState({});
  const [kbOpen, setKbOpen] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);
  const kbHeightRef = useRef(0);
  const [msgAreaH, setMsgAreaH] = useState(0);
  const msgAreaClosedH = useRef(0);
  const setBarH = (k) => (e) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setBarHeights((prev) => (prev[k] === h ? prev : { ...prev, [k]: h }));
  };
  const [presence, setPresence] = useState(() => ({
    isOnline: otherUserOnline,
    lastSeen: otherUserLastSeen,
  }));
  const listRef = useRef(null);
  const voicePathRef = useRef(null);
  const recListenUnsub = useRef(null);
  const inputRef = useRef(null);
  const kbVisibleRef = useRef(Platform.OS === 'ios');
  const focusRetryRef = useRef(false);
  const typingTimer = useRef(null);
  const [mediaViewer, setMediaViewer] = useState(null);
  const [previewAsset, setPreviewAsset] = useState(null);
  const [atBottomNear, setAtBottomNear] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const atBottomRef = useRef(true);
  const atBottomNearRef = useRef(true);
  const scrolledToEndOnMount = useRef(false);
  const uploadTasks = useRef(new Map());
  // Pagination (lazy-loading older messages on scroll up).
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const oldestIdRef = useRef(null);
  const loadingSafetyTimer = useRef(null);
  // Scroll position tracking used to preserve the reading offset when older
  // messages are prepended (replaces maintainVisibleContentPosition, which pinned
  // the viewport and kept newly sent messages hidden below the bottom bar).
  const scrollMetricsRef = useRef({ y: 0, contentH: 0 });
  const prependPendingRef = useRef(false);
  const prependOffsetRef = useRef(0);
  const prependContentHRef = useRef(0);

  // Centralized scroll-to-bottom state: a single source of truth for all
  // "jump to latest message" actions (send, receive, keyboard, FAB).
  const pendingScrollToBottomRef = useRef(false);
  const lastContentHeightRef = useRef(0);
  const bottomInsetRef = useRef(0);
  const scrollActionRef = useRef(null);
  const scrollSettleTimerRef = useRef(null);
  const bottomSeekRef = useRef(false);
  const rafQueueRef = useRef([]);
  const userDragRef = useRef(false);
  const pendingCountRef = useRef(0);
  const scrollModeRef = useRef(null);
  const mobileDiffRef = useRef({ prev: null, aliases: new Map(), chatId: null });
  const listIntentRef = useRef(null);
  const historyLoadRef = useRef(false);
  const receiveIntentRef = useRef(false);
  const replaceIntentRef = useRef(false);

  const runScrollToEnd = useCallback((animated) => {
    const l = listRef.current;
    if (l) l.scrollToEnd({ animated });
  }, []);

  const scheduleRaf = useCallback((fn) => {
    const id = requestAnimationFrame(() => {
      rafQueueRef.current = rafQueueRef.current.filter((x) => x !== id);
      fn();
    });
    rafQueueRef.current.push(id);
    return id;
  }, []);

  const cancelScrollSettle = useCallback(() => {
    if (scrollSettleTimerRef.current) {
      clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
    bottomSeekRef.current = false;
  }, []);

  const stopScrollFollow = useCallback(() => {
    cancelScrollSettle();
    scrollModeRef.current = null;
    pendingScrollToBottomRef.current = false;
  }, [cancelScrollSettle]);

  const settleScrollToBottom = useCallback(() => {
    if (scrollSettleTimerRef.current) {
      clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
    if (!bottomSeekRef.current) return;
    bottomSeekRef.current = false;
    scrollModeRef.current = null;
    pendingScrollToBottomRef.current = false;
    runScrollToEnd(false);
  }, [runScrollToEnd]);

  const scrollToLatestInstant = useCallback(() => {
    cancelScrollSettle();
    scrollModeRef.current = 'instant';
    if (scrollActionRef.current) return;
    scrollActionRef.current = 'instant';
    scheduleRaf(() => {
      scheduleRaf(() => {
        scrollActionRef.current = null;
        scrollModeRef.current = null;
        pendingScrollToBottomRef.current = false;
        runScrollToEnd(false);
      });
    });
  }, [runScrollToEnd, cancelScrollSettle, scheduleRaf]);

  const scrollToLatestAnimated = useCallback(() => {
    cancelScrollSettle();
    scrollModeRef.current = 'animated';
    bottomSeekRef.current = true;
    if (scrollActionRef.current === 'animated') return;
    if (scrollActionRef.current === 'instant') {
      rafQueueRef.current.forEach((id) => cancelAnimationFrame(id));
      rafQueueRef.current = [];
      scrollActionRef.current = null;
    }
    scrollActionRef.current = 'animated';
    scheduleRaf(() => {
      scheduleRaf(() => {
        scrollActionRef.current = null;
        scrollModeRef.current = null;
        pendingScrollToBottomRef.current = false;
        runScrollToEnd(true);
        scrollSettleTimerRef.current = setTimeout(settleScrollToBottom, 320);
      });
    });
  }, [runScrollToEnd, cancelScrollSettle, settleScrollToBottom, scheduleRaf]);

  const listMeta = useMemo(() => {
    const state = mobileDiffRef.current;
    if (state.chatId !== otherUserId) {
      state.chatId = otherUserId;
      state.aliases.clear();
      state.prev = null;
      state.prevKeys = null;
    }
    const prev = state.prev;
    const aliases = state.aliases;
    const prevKeys = state.prevKeys || new Set();
    const seen = new Set();
    const raw = messages.map((m, i) => {
      const prevAt = prev ? prev[i] : null;
      if (prevAt && isServerId(m) && String(prevAt.id).startsWith('tmp-') && prevAt.sender_id === m.sender_id) {
        aliases.set(String(m.id), String(prevAt.id));
      }
      const base = String(m._tempId || m.client_id || m.id);
      let key = aliases.get(base) || base;
      if (seen.has(key)) key = `${key}-${i}`;
      seen.add(key);
      const matched = aliases.has(base);
      return { key, message: m, isNew: !!state.prevKeys && prevKeys.size > 0 && !prevKeys.has(key) && !matched };
    });
    const added = raw.filter(e => e.isNew).length;
    const addedSent = raw.filter(e => e.isNew && e.message.sender_id === currentUser.id).length;
    const addedReceived = added - addedSent;
    const nextKeys = new Set(raw.map(e => e.key));
    let removed = 0;
    if (state.prevKeys) {
      state.prevKeys.forEach((k) => { if (!nextKeys.has(k)) removed += 1; });
    }
    const userAppend = addedSent > 0 || (receiveIntentRef.current && addedReceived > 0);
    const replace = replaceIntentRef.current && added > 0;
    const prepend = prependPendingRef.current;
    const load = !prev || prev.length === 0 || messages.length === 0 || historyLoadRef.current || replace || (!userAppend && added > 1) || (removed > 0 && added === 0);
    const kind = prepend ? 'none' : load ? 'instant' : addedSent > 0 ? 'own' : addedReceived > 0 ? 'receive' : 'none';
    listIntentRef.current = { token: messages, kind };
    const entryMap = new Map();
    raw.forEach((e) => {
      entryMap.set(String(e.message.id), { key: e.key, animate: !load && !prepend && e.isNew && added === 1 });
    });
    state.prevKeys = nextKeys;
    return { entryMap };
  }, [messages, currentUser.id, otherUserId]);

  useEffect(() => {
    const intent = listIntentRef.current;
    if (!intent || intent.token !== messages) return;
    if (intent.kind === 'instant') {
      pendingScrollToBottomRef.current = true;
      scrollToLatestInstant();
    } else if (intent.kind === 'own') {
      atBottomRef.current = true;
      atBottomNearRef.current = true;
      setAtBottomNear(true);
      pendingCountRef.current = 0;
      setPendingCount(0);
      pendingScrollToBottomRef.current = true;
      scrollToLatestAnimated();
    } else if (intent.kind === 'receive' && atBottomNearRef.current) {
      atBottomRef.current = true;
      pendingScrollToBottomRef.current = true;
      scrollToLatestAnimated();
    }
    mobileDiffRef.current.prev = messages;
    historyLoadRef.current = false;
    receiveIntentRef.current = false;
    replaceIntentRef.current = false;
  }, [messages, scrollToLatestInstant, scrollToLatestAnimated]);

  useEffect(() => () => {
    cancelScrollSettle();
    rafQueueRef.current.forEach((id) => cancelAnimationFrame(id));
    rafQueueRef.current = [];
    scrollActionRef.current = null;
    userDragRef.current = false;
  }, [cancelScrollSettle]);

  // Send a message through the socket if connected, otherwise queue it for flush
  // on reconnect. Mirrors whatsapp's offline-queue behaviour.
  const socketReady = () => !!socket && socket.connected;

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
  // Ref mirror so openMedia stays referentially stable across message arrivals: a
  // changing onOpenMedia prop would defeat MessageRow memoization and re-render the
  // whole visible window on every incoming message.
  const mediaItemsRef = useRef(mediaItems);
  mediaItemsRef.current = mediaItems;

  const openMedia = useCallback((message) => {
    if (!message || !message.media_url) return;
    const items = mediaItemsRef.current;
    if (message.type === 'IMAGE' || message.type === 'VIDEO') {
      const idx = items.findIndex((m) => m.id === message.id);
      if (idx >= 0) {
        setMediaViewer({ items, index: idx });
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
  }, []);

  const handleContentSizeChange = useCallback((w, h) => {
    lastContentHeightRef.current = h;
    // After an older-messages prepend, keep the message under the user's thumb put:
    // RN grew the content above, so shift the offset down by exactly the added height.
    if (prependPendingRef.current) {
      prependPendingRef.current = false;
      const delta = h - prependContentHRef.current;
      const target = Math.max(0, (prependOffsetRef.current || 0) + delta);
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: target, animated: false }));
      return;
    }
    // Follow growth only when the user is at the bottom or a jump is explicitly owed.
    if ((atBottomRef.current || pendingScrollToBottomRef.current) && scrolledToEndOnMount.current) {
      pendingScrollToBottomRef.current = false;
      if (bottomSeekRef.current) return;
      if (scrollModeRef.current === 'animated') scrollToLatestAnimated();
      else scrollToLatestInstant();
    }
  }, [scrollToLatestInstant, scrollToLatestAnimated]);

  // Stable FlatList layout callback (memo comparison of <MessageList> requires it to
  // not be an inline arrow).
  const handleListLayout = useCallback(() => {
    if (atBottomRef.current || pendingScrollToBottomRef.current) {
      if (bottomSeekRef.current) return;
      if (scrollModeRef.current === 'animated') scrollToLatestAnimated();
      else scrollToLatestInstant();
    }
  }, [scrollToLatestInstant, scrollToLatestAnimated]);

  const handleScrollBeginDrag = useCallback(() => {
    userDragRef.current = true;
    stopScrollFollow();
  }, [stopScrollFollow]);

  const handleScrollEndDrag = useCallback(() => {
    userDragRef.current = false;
  }, []);

  const handleScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    const h = e.nativeEvent.layoutMeasurement.height;
    const cs = e.nativeEvent.contentSize.height;
    scrollMetricsRef.current = { y, contentH: cs, viewportH: h };
    if (userDragRef.current && bottomSeekRef.current) stopScrollFollow();
    // The contentContainer carries extra bottom padding while the keyboard overlaps
    // (ColorOS/OPPO: window never shrinks). That padding pushes the true "latest"
    // beyond reach, so the FAB would light up even at the newest message. Measure
    // distance against the content MINUS the inset so "at bottom" means the last
    // message, not the end of the invisible padding.
    const inset = bottomInsetRef.current || 0;
    const contentBottom = Math.max(0, cs - inset);
    const distToBottom = Math.max(0, contentBottom - (y + h));
    const trulyAtBottom = distToBottom <= 4;
    const nearBottom = distToBottom <= 32;
    atBottomRef.current = trulyAtBottom;
    // Update the near-bottom flag only when it actually flips (never per event),
    // so the FAB/badge state changes once instead of on every scroll tick.
    if (nearBottom !== atBottomNearRef.current) {
      atBottomNearRef.current = nearBottom;
      setAtBottomNear(nearBottom);
    }
    // Unread count clears only when truly at the bottom.
    if (trulyAtBottom && pendingCountRef.current > 0) {
      pendingCountRef.current = 0;
      setPendingCount(0);
    }
    // Scroll up near the top -> lazily load older messages (pagination).
    if (y <= 80 && hasMoreRef.current && !loadingMoreRef.current && oldestIdRef.current != null) {
      loadingMoreRef.current = true;
      clearTimeout(loadingSafetyTimer.current);
      loadingSafetyTimer.current = setTimeout(() => { loadingMoreRef.current = false; }, 6000);
      if (socketReady()) {
        socket.emit('messages:loadMore', {
          otherUserId,
          beforeId: oldestIdRef.current,
          limit: 50,
        }, (res) => {
          loadingMoreRef.current = false;
          clearTimeout(loadingSafetyTimer.current);
          if (res && res.ok && Array.isArray(res.messages) && res.messages.length) {
            const before = scrollMetricsRef.current || { y: 0, contentH: 0 };
            prependPendingRef.current = true;
            prependOffsetRef.current = before.y;
            prependContentHRef.current = before.contentH || 0;
            setMessages((prev) => {
              const ids = knownIdsRef.current || trackIds(prev);
              const older = res.messages.filter((m) => isServerId(m) && !ids.has(m.id));
              if (!older.length) return prev;
              for (const m of older) ids.add(m.id);
              // `older` is strictly older than beforeId (== first local row), so a plain
              // append keeps the array sorted with zero duplicate risk.
              const merged = older.concat(prev);
              oldestIdRef.current = merged[0] ? merged[0].id : null;
              return merged;
            });
          }
          hasMoreRef.current = !!(res && res.ok && res.hasMore);
        });
      } else {
        loadingMoreRef.current = false;
      }
    }
  }, [otherUserId, stopScrollFollow]);

  const REACTPOP_H = 60;
  const handleLongPress = useCallback((msg, evt) => {
    if (!msg) return;
    const pageX = (evt && evt.nativeEvent && evt.nativeEvent.pageX) || APP_W / 2;
    const pageY = (evt && evt.nativeEvent && evt.nativeEvent.pageY) || 260;
    const popW = 7 * 40 + 22 + 16;
    const left = Math.max(8, Math.min(pageX - popW / 2, APP_W - popW - 8));
    const top = pageY > REACTPOP_H + 70 ? pageY - REACTPOP_H - 20 : Math.min(pageY + 44, APP_H - REACTPOP_H - 12);
    setReactionPop({ msg, left, top, caretX: Math.max(10, Math.min(pageX - left - 7, popW - 20)) });
  }, []);

  const toggleLike = useCallback((msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const mine = (msg.reactions || []).find((r) => r.user_id === currentUser.id);
    reactTo(msg.id, mine && mine.reaction === '❤️' ? '' : '❤️');
  }, [currentUser.id]);

  // The message list (reply lookup, row rendering, tap-to-jump highlight and the
  // FlatList itself) lives in the memoized <MessageList> below, so typing, upload
  // progress and unrelated state changes never re-render the visible chat window.

  const onType = (t) => {
    if (enterSendRef.current && !allowNewlineRef.current && typeof t === 'string' && t.endsWith('\n')) {
      const stripped = t.slice(0, -1);
      const now = Date.now();
      const last = lastEnterSentRef.current;
      const echo = !!(last && stripped.trim() === last.content && now - last.at < 1500);
      const appended = t === text + '\n';
      if (echo || appended) {
        if (echo) lastEnterSentRef.current = null;
        else lastEnterSentRef.current = { content: stripped.trim(), at: now };
        setText('');
        if (!echo) sendText(stripped);
        return;
      }
    }
    allowNewlineRef.current = false;
    if (t !== text + '\n') lastEnterSentRef.current = null;
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

  // ---------------------------------------------------------------------------
  // Layer 3 - centralized merge + dedup.
  //
  // EVERY server message that reaches this screen (history snapshot, incremental
  // sync, Socket.IO receive, load-more) flows through the helpers below into the
  // SAME `messages` state, which the memoized list observes directly. The numeric
  // server id is the ONLY identity - never text/position/timestamp. Local-only rows
  // (temp clientIds, _queued/_uploading/_pending/_uploadError) are preserved across
  // server snapshots and reconciled into their canonical message on ack.
  // ---------------------------------------------------------------------------
  const knownIdsRef = useRef(null);
  const lastSyncedIdRef = useRef(null);

  const trackIds = useCallback((list) => {
    const set = new Set();
    for (const m of list) if (isServerId(m)) set.add(Number(m.id));
    knownIdsRef.current = set;
    return set;
  }, []);
  const addKnownId = useCallback((id) => {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) {
      if (!knownIdsRef.current) knownIdsRef.current = new Set();
      knownIdsRef.current.add(n);
    }
  }, []);
  const bumpCursor = useCallback((id) => {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0 && n > (lastSyncedIdRef.current || 0)) {
      lastSyncedIdRef.current = n;
    }
  }, []);

  const applyMessage = useCallback((raw, options) => {
    const m = normalizeMessage(raw);
    if (!isServerId(m)) return;
    addKnownId(m.id);
    bumpCursor(m.id);
    setMessages((prev) => mergeServerRow(prev, m, currentUser.id, !options || options.updateExisting !== false));
  }, [addKnownId, bumpCursor, currentUser.id]);

  const applyAck = useCallback((tempId, ackMessage, clientId) => {
    if (!ackMessage || !isServerId(ackMessage)) return;
    const canonical = normalizeMessage(ackMessage);
    const id = Number(canonical.id);
    const serverKey = String(id);
    const aliases = [tempId, clientId].filter(Boolean).map(String);
    aliases.forEach((key) => mobileDiffRef.current.aliases.set(serverKey, key));
    addKnownId(id);
    bumpCursor(id);
    setMessages((prev) => {
      const idx = prev.findIndex((m) => aliases.some((key) => String(m.id) === key || String(m.client_id || m._tempId || '') === key));
      const row = {
        ...canonical,
        _tempId: tempId || canonical._tempId || null,
        client_id: clientId || canonical.client_id || null,
        _local: true,
        _queued: false,
        _uploading: false,
        _pending: false,
        _uploadError: false,
        _uploadProgress: 1,
      };
      if (idx < 0) {
        const serverIdx = prev.findIndex((m) => isServerId(m) && Number(m.id) === id);
        if (serverIdx >= 0) {
          const copy = prev.slice();
          copy[serverIdx] = { ...copy[serverIdx], ...row, status: keepReceiptStatus(copy[serverIdx].status, row.status) };
          return copy;
        }
        return insertSorted(prev, row);
      }
      const existing = prev[idx];
      const next = [];
      prev.forEach((m, i) => {
        if (i !== idx && isServerId(m) && Number(m.id) === id) return;
        if (i === idx) next.push({ ...row, status: keepReceiptStatus(existing.status, row.status) });
        else next.push(m);
      });
      return next;
    });
  }, [addKnownId, bumpCursor]);

  const updateStatus = useCallback((id, status) => {
    if (id == null || !status) return;
    const ids = (Array.isArray(id) ? id : [id]).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        if (!isServerId(m) || !ids.includes(Number(m.id)) || m.status === status) return m;
        changed = true;
        return { ...m, status };
      });
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    const onCallMessage = (m) => {
      if (!m || !m.id) return;
      applyMessage(m);
    };
    const onToast = (message) => {
      if (message) setNudgeToast(message);
    };
    const subMsg = DeviceEventEmitter.addListener('tojey:call-message', onCallMessage);
    const subToast = DeviceEventEmitter.addListener('tojey:call-toast', onToast);
    return () => {
      subMsg.remove();
      subToast.remove();
    };
  }, [applyMessage]);

  const computeSyncCursor = (list) => {
    let max = 0;
    for (const m of list) if (isServerId(m) && Number(m.id) > max) max = Number(m.id);
    return max || null;
  };
  const incrementalAdvance = useCallback((prev, incoming) => {
    if (!Array.isArray(incoming) || !incoming.length) return prev;
    const ids = knownIdsRef.current || trackIds(prev);
    for (const raw of incoming) {
      const m = normalizeMessage(raw);
      if (!isServerId(m)) continue;
      ids.add(Number(m.id));
      bumpCursor(m.id);
    }
    return mergeServerBatch(prev, incoming, currentUser.id);
  }, [bumpCursor, currentUser.id, trackIds]);
  // Server snapshot (conversation:open last-200). The server wins on every server-owned
  // row; rows that are still local-only (pending/queued/uploads) survive; cached rows that
  // no longer exist on the server (deleted for everyone / beyond the window) are dropped.
  // Pointer rows are close to the tail, so any rows in the oldest real runs get dropped
  // exactly like the old "history replaces cache" behavior.
  const historyAdvance = (prev, serverRows) => {
    if (!Array.isArray(serverRows)) return prev;
    const srv = [];
    for (const raw of serverRows) {
      const m = normalizeMessage(raw);
      if (isServerId(m)) srv.push(m);
    }
    trackIds(srv);
    lastSyncedIdRef.current = computeSyncCursor(srv);
    srv.sort((a, b) => (sortKey(a) - sortKey(b)) || (Number(a.id) - Number(b.id)));
    const localOnly = prev.filter((m) => isLocalOnly(m));
    let merged = srv;
    for (const m of localOnly) merged = insertSorted(merged, m);
    return merged;
  };

  useEffect(() => {
    if (!socket || !otherUserId || !currentUser?.id) return;

    // Layer 2 - background server sync. Prefer incremental: fetch ONLY messages newer
    // than the last locally-known server id (messages:after) instead of re-downloading
    // the whole conversation. Falls back to the full last-200 snapshot when there is
    // no cursor (first open) or the server errors (>200 new, hiccup).
    const syncAfterCursor = (cursor) => {
      if (!socket || !socket.connected) return;
      if (cursor) {
        socket.emit('messages:after', { otherUserId, afterId: cursor, limit: 200 }, (res) => {
          if (res && res.ok && Array.isArray(res.messages)) {
            if (res.messages.length) {
              setMessages((prev) => incrementalAdvance(prev, res.messages));
            }
            if (res.hasMore) {
              // More than 200 new messages - full snapshot once is cheaper than paging.
              socket.emit('conversation:open', { otherUserId });
            }
          } else if (socket && socket.connected) {
            // Incremental sync unavailable - fall back to the full snapshot.
            socket.emit('conversation:open', { otherUserId });
          }
        });
      } else if (socket && socket.connected) {
        socket.emit('conversation:open', { otherUserId });
      }
    };

    // Layer 1: render cached messages instantly, never wait for the network. Then
    // synchronize in the background only the messages that are actually missing.
    let cancelled = false;
    loadMessages(currentUser.id, otherUserId).then((cached) => {
      if (cancelled) return;
      if (cached && cached.length) {
        trackIds(cached);
        lastSyncedIdRef.current = computeSyncCursor(cached);
        historyLoadRef.current = true;
        setMessages(cached);
        atBottomRef.current = true;
        atBottomNearRef.current = true;
        setAtBottomNear(true);
        pendingScrollToBottomRef.current = true;
        scrolledToEndOnMount.current = true;
        scrollToLatestInstant();
      }
      // Flush any pending outgoing messages for ALL conversations on initial connect
      if (currentUser?.id && socket?.connected) {
        flushAllOutgoingQueues(currentUser.id, socket, currentUser.id);
      }
      syncAfterCursor(lastSyncedIdRef.current);
    });

    const hHistory = (msgs) => {
      const list = Array.isArray(msgs) ? msgs : [];
      historyLoadRef.current = true;
      setMessages((prev) => historyAdvance(prev, list));
      oldestIdRef.current = list.length ? list[0].id : null;
      hasMoreRef.current = list.length >= 200;
      atBottomNearRef.current = true;
      setAtBottomNear(true);
      setPendingCount(0);
      pendingScrollToBottomRef.current = true;
      scrolledToEndOnMount.current = true;
      scrollToLatestInstant();
    };
    const hReceive = ({ message }) => {
      // Deduplicate by server id in O(1) (id-set) - a message arriving via socket AND
      // a sync/retry can never produce a second row. The updater re-checks the same set
      // so a concurrent duplicate is collapsed even between renders.
      if (!message || !isServerId(message)) return;
      const ids = knownIdsRef.current || trackIds([]);
      if (ids.has(Number(message.id))) {
        bumpCursor(message.id);
        return;
      }
      receiveIntentRef.current = true;
      applyMessage(message);
      // Warm the image caches right away so scrolling to a fresh media message
      // never shows a loader (prefetch both thumb + full so zooming is ready too).
      if (message && (message.thumb_url || message.media_url)) {
        try {
          if (message.thumb_url) Image.prefetch(absUrl(message.thumb_url)).catch(() => {});
          if (message.media_url && message.media_url !== message.thumb_url) Image.prefetch(absUrl(message.media_url)).catch(() => {});
        } catch (e) { /* prefetch is best-effort */ }
      }
      if (message.sender_id !== currentUser.id) {
        if (!appVisibleRef.current) {
          headUnreadRef.current += 1;
          updateChatHead();
        }
        if (!atBottomNearRef.current) {
          // Away from the bottom: count the unread badge, never steal position.
          pendingCountRef.current += 1;
          setPendingCount(pendingCountRef.current);
        } else {
          atBottomRef.current = true;
        }
        socket.emit('message:read', { messageIds: [message.id], otherUserId: message.sender_id });
      }
    };
    const hDelivered = ({ messageId }) => updateStatus(messageId, 'DELIVERED');
    const hRead = ({ messageIds, messageId }) => updateStatus(messageIds || messageId, 'READ');
    const hStatus = (payload) => {
      if (!payload) return;
      const id = payload.messageId != null ? payload.messageId : (payload.id != null ? payload.id : payload.messageIds);
      if (id != null) updateStatus(id, payload.status);
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
    socket.on('message:status', hStatus);
    socket.on('typing:start', hTyping);
    socket.on('typing:stop', hTypingStop);
    socket.on('message:edited', hEdited);
    socket.on('message:deleted', hDeleted);
    socket.on('message:reaction', hReaction);
    const hCleared = ({ conversationId }) => {
      setMessages([]);
      knownIdsRef.current = new Set();
      lastSyncedIdRef.current = null;
      setShowAttach(false); setReplyingTo(null); setEditing(null); setText(''); oldestIdRef.current = null; hasMoreRef.current = false; clearConversationCache(currentUser.id, otherUserId);
    };
    socket.on('conversation:cleared', hCleared);
    const hNudge = ({ from }) => {
      headUnreadRef.current += 1;
      if (!appVisibleRef.current) updateChatHead();
      playNudgeVibration();
      const who = (from && (from.displayName || from.username)) || 'Someone';
      setNudgeToast(`${who} nudged you`);
    };
    socket.on('nudge', hNudge);
    const hPresence = ({ userId, isOnline, lastSeen }) => {
      if (userId === otherUserId) setPresence({ isOnline, lastSeen });
    };
    socket.on('presence:update', hPresence);

    const onReconnect = () => {
      if (socket && otherUserId && currentUser?.id) {
        // Incremental: only refetch what the cache is missing. If we never synced a
        // cursor, fall back to the full snapshot.
        const cursor = lastSyncedIdRef.current;
        if (cursor) {
          socket.emit('messages:after', { otherUserId, afterId: cursor, limit: 200 }, (res) => {
            if (res && res.ok && Array.isArray(res.messages)) {
              if (res.messages.length) setMessages((prev) => incrementalAdvance(prev, res.messages));
              if (res.hasMore && socket && socket.connected) socket.emit('conversation:open', { otherUserId });
            } else if (socket && socket.connected) {
              socket.emit('conversation:open', { otherUserId });
            }
          });
        } else {
          socket.emit('conversation:open', { otherUserId });
        }
      }
      if (currentUser?.id) flushAllOutgoingQueues(currentUser.id, socket, currentUser.id);
    };
    socket.on('connect', onReconnect);
    socket.io?.off('reconnect', onReconnect);
    socket.io?.on('reconnect', onReconnect);
    if (socket.connected && currentUser?.id) flushAllOutgoingQueues(currentUser.id, socket, currentUser.id);

    return () => {
      cancelled = true;
      socket.off('messages:history', hHistory);
      socket.off('message:receive', hReceive);
      socket.off('message:delivered', hDelivered);
      socket.off('message:read', hRead);
      socket.off('message:status', hStatus);
      socket.off('typing:start', hTyping);
      socket.off('typing:stop', hTypingStop);
      socket.off('message:edited', hEdited);
      socket.off('message:deleted', hDeleted);
      socket.off('message:reaction', hReaction);
      socket.off('conversation:cleared', hCleared);
      socket.off('nudge', hNudge);
      socket.off('presence:update', hPresence);
      socket.off('connect', onReconnect);
      socket.io?.off('reconnect', onReconnect);
    };
  }, [socket, otherUserId, currentUser.id, applyMessage, bumpCursor, incrementalAdvance, trackIds, updateStatus]);

  // Single efficient persistence: only write when meaningful state changes
  // (status, reactions, edits, upload progress). Skip frequent _uploadProgress ticks.
  const persistSigRef = useRef('');
  useEffect(() => {
    if (!currentUser?.id || !otherUserId || !messages.length) return;
    // Only the newest 200 affect the signature: pagination keeps growing the array
    // and a full-text signature of thousands of messages is wasteful.
    const tail = messages.slice(-200);
    const sig = tail
      .map((m) => [m.id, m.status, m._uploadError ? 1 : 0, m._uploadProgress != null ? Math.round(m._uploadProgress * 40) : 0, m.is_edited ? 1 : 0, m.is_deleted_for_everyone ? 1 : 0].join('|'))
      .join(';');
    if (sig === persistSigRef.current) return;
    persistSigRef.current = sig;
    const t = setTimeout(() => saveMessages(currentUser.id, otherUserId, messages), 300);
    return () => clearTimeout(t);
  }, [messages, otherUserId, currentUser.id]);

  // Chat Head: show a floating bubble of the other person while the app is in the
  // background (only when enabled in Settings and overlay permission granted).
  // Hidden + unread reset on foreground.
  const updateChatHead = async () => {
    if (!chatHeadOnRef.current) return;
    if (!(await canDrawOverlay())) return;
    const pic = safeOtherUser.profile_pic_url ? absUrl(safeOtherUser.profile_pic_url) : otherUserName[0].toUpperCase();
    showChatHead(pic, otherUserName, headUnreadRef.current);
  };

  useEffect(() => {
    let mounted = true;
    getChatHeadEnabled().then((enabled) => {
      if (mounted) chatHeadOnRef.current = enabled;
    });
    getEnterToSend().then((enabled) => {
      if (mounted) enterSendRef.current = enabled;
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    appVisibleRef.current = AppState.currentState === 'active';
    const sub = AppState.addEventListener('change', (nextState) => {
      appVisibleRef.current = nextState === 'active';
      if (nextState === 'active') {
        headUnreadRef.current = 0;
        hideChatHead();
      } else if (nextState === 'background') {
        updateChatHead();
      }
    });
    return () => {
      sub.remove();
      hideChatHead();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendNudge = () => {
    if (socket && otherUserId) {
      socket.emit('nudge', { otherUserId });
      setNudgeToast(`You nudged ${otherUserName}`);
    }
  };

  // Ref mirror of the unread count so scroll handlers clear it without re-renders.
  useEffect(() => { pendingCountRef.current = pendingCount; }, [pendingCount]);

  const jumpToLatest = useCallback(() => {
    pendingCountRef.current = 0;
    setPendingCount(0);
    atBottomRef.current = true;
    atBottomNearRef.current = true;
    setAtBottomNear(true);
    pendingScrollToBottomRef.current = true;
    scrollToLatestAnimated();
  }, [scrollToLatestAnimated]);

  // Keyboard reopen fix: Android stops showing the keyboard on the focused input
  // after a manual dismiss. Track visibility and force a blur+refocus cycle.
  // Keyboard open/close is geometry-aware: change the inset state, then do ONE
  // instant correction only when already at the bottom (no timer storms).
  useEffect(() => {
    const show = (e) => {
      kbVisibleRef.current = true;
      setKbOpen(true);
      const h = e && e.endCoordinates ? e.endCoordinates.height : 0;
      if (h) kbHeightRef.current = h;
      setKbHeight(h || kbHeightRef.current || 0);
      if (atBottomRef.current) {
        pendingScrollToBottomRef.current = true;
        scrollToLatestInstant();
      }
    };
    const hide = () => {
      if (Platform.OS !== 'ios') kbVisibleRef.current = false;
      setKbOpen(false);
      setKbHeight(0);
      if (atBottomRef.current) {
        pendingScrollToBottomRef.current = true;
        scrollToLatestInstant();
      }
    };
    const subs = [
      Keyboard.addListener('keyboardDidShow', show),
      Keyboard.addListener('keyboardDidHide', hide),
      Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        if (Platform.OS !== 'ios') return;
        if (atBottomRef.current) {
          pendingScrollToBottomRef.current = true;
          scrollToLatestInstant();
        }
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [scrollToLatestInstant]);

  // Blur + refocus (with a fallback retry) so the keyboard reliably returns when the
  // user taps the input after dismissing it. Guarded by the visibility flag.
  const reopenKeyboard = () => {
    if (Platform.OS !== 'android') return;
    const t = inputRef.current;
    if (!t || kbVisibleRef.current) return;
    t.blur();
    setTimeout(() => {
      if (!inputRef.current || inputRef.current !== t) return;
      inputRef.current.focus();
      setTimeout(() => {
        if (kbVisibleRef.current || !inputRef.current || inputRef.current !== t) return;
        inputRef.current.blur();
        setTimeout(() => {
          if (inputRef.current === t && !kbVisibleRef.current) inputRef.current.focus();
        }, 60);
      }, 220);
    }, 50);
  };

  // OPPO/ColorOS safety net: a tap can regain focus without the OS raising the soft
  // keyboard (stale EditText focus after dismiss). If the keyboard is still hidden a
  // moment after focus, force one blur+refocus cycle.
  const ensureKeyboard = () => {
    if (Platform.OS !== 'android') return;
    if (focusRetryRef.current) return;
    focusRetryRef.current = true;
    setTimeout(() => {
      focusRetryRef.current = false;
      const t = inputRef.current;
      if (!t || kbVisibleRef.current) return;
      t.blur();
      setTimeout(() => {
        if (inputRef.current === t && !kbVisibleRef.current) inputRef.current.focus();
      }, 50);
    }, 400);
  };

  useEffect(() => {
    return () => {
      if (recListenUnsub.current) {
        recListenUnsub.current();
        recListenUnsub.current = null;
      }
      clearTimeout(typingTimer.current);
      clearTimeout(sendFlashTimerRef.current);
      clearTimeout(cameraTimeoutRef.current);
      clearTimeout(loadingSafetyTimer.current);
      resetVoice().catch(() => {});
    };
  }, []);

  // Upload progress is emitted ~8x/sec by RNFetchBlob; we bucket it to 2.5% steps so a
  // row (and the list memo) only re-renders ~40 times per upload instead of on every tick.
  const progressBucketsRef = useRef(new Map());
  const setUploadProgress = useCallback((tempId, p) => {
    const bucket = Math.round((p || 0) * 40);
    if (progressBucketsRef.current.get(tempId) === bucket) return;
    progressBucketsRef.current.set(tempId, bucket);
    if (bucket >= 40) progressBucketsRef.current.delete(tempId);
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

  const sendText = (override) => {
    const content = (override != null ? String(override) : text).trim();
    if (!content) return;
    if (editing) {
      socket.emit('message:edit', { messageId: editing.id, content });
      setMessages((prev) => prev.map((m) => (m.id === editing.id ? { ...m, content, is_edited: true } : m)));
      setEditing(null);
      setText('');
      return;
    }
    const clientId = `tmp-${currentUser.id}-${Date.now()}`;
    const localMsg = {
      id: clientId,
      sender_id: currentUser.id,
      type: 'TEXT',
      content,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reply_to: replyingTo?.id || null,
      reactions: [],
      client_id: clientId,
      _tempId: clientId,
      _local: true,
      _pending: true,
    };
    const replyTo = replyingTo?.id || null;
    // Clear the input immediately (spec: optimistic append, instant clear, send
    // disabled only when genuinely empty). Jump always lands at the latest.
    setText('');
    setReplyingTo(null);
    pendingScrollToBottomRef.current = true;
    atBottomRef.current = true;
    atBottomNearRef.current = true;
    setAtBottomNear(true);
    pendingCountRef.current = 0;
    setPendingCount(0);
    if (socketReady()) {
      // Optimistic render + instant scroll-to-latest: the message appears
      // immediately, then the ack swaps the temp id in place (no scroll jump).
      setMessages((prev) => [...prev, localMsg]);
      scrollToLatestAnimated();
      const payload = {
        otherUserId,
        type: 'TEXT',
        content,
        replyTo,
        clientId,
      };
      socket.emit('typing:stop', { otherUserId });
      if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; }
      socket.emit('message:send', payload, (ack) => {
        if (ack && ack.ok) applyAck(clientId, ack.message, clientId);
      });
    } else {
      // Offline: show the pending row immediately and queue the send for flush
      // on reconnect (idempotent by clientId).
      setMessages((prev) => [...prev, { ...localMsg, _queued: true }]);
      scrollToLatestAnimated();
      enqueueOutgoing(currentUser.id, otherUserId, { clientId, type: 'TEXT', content, replyTo });
    }
  };

  // Send button feedback: press darkens the button (WhatsApp-style dark tap) and
  // bursts a tiny scale bounce, then the button returns while the message flies.
  const pressSend = () => {
    if (!text.trim()) return;
    Animated.sequence([
      Animated.timing(sendScale, { toValue: 0.86, duration: 90, useNativeDriver: true }),
      Animated.spring(sendScale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
    ]).start();
    if (sendFlashTimerRef.current) clearTimeout(sendFlashTimerRef.current);
    setSendFlash(true);
    sendFlashTimerRef.current = setTimeout(() => setSendFlash(false), 320);
    sendText();
  };

  const sendReplyText = useCallback((target, content) => {
    const c = (content || '').trim();
    if (!target || !c) return;
    const clientId = `tmp-${currentUser.id}-${Date.now()}`;
    const localMsg = {
      id: clientId,
      sender_id: currentUser.id,
      type: 'TEXT',
      content: c,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reply_to: target.id || null,
      reactions: [],
      client_id: clientId,
      _tempId: clientId,
      _local: true,
      _pending: true,
    };
    const replyTo = target.id || null;
    pendingScrollToBottomRef.current = true;
    atBottomRef.current = true;
    atBottomNearRef.current = true;
    setAtBottomNear(true);
    pendingCountRef.current = 0;
    setPendingCount(0);
    if (socketReady()) {
      setMessages((prev) => [...prev, localMsg]);
      scrollToLatestAnimated();
      socket.emit('message:send', { otherUserId, type: 'TEXT', content: c, replyTo, clientId }, (ack) => {
        if (ack && ack.ok) applyAck(clientId, ack.message, clientId);
      });
    } else {
      setMessages((prev) => [...prev, { ...localMsg, _queued: true }]);
      scrollToLatestAnimated();
      enqueueOutgoing(currentUser.id, otherUserId, { clientId, type: 'TEXT', content: c, replyTo });
    }
  }, [socket, otherUserId, currentUser.id, scrollToLatestAnimated, applyAck]);

  const queueVoiceItem = useCallback(async (item) => {
    const queue = await readVoiceQueue();
    await writeVoiceQueue(queue.filter((it) => it.clientId !== item.clientId).concat(item));
  }, []);

  const flushQueuedVoice = useCallback(async () => {
    if (voiceQueueBusyRef.current || !socket || !socket.connected || !currentUser?.id) return;
    voiceQueueBusyRef.current = true;
    try {
      let queue = await readVoiceQueue();
      const pending = queue.slice();
      for (const item of pending) {
        if (!socket.connected) break;
        try {
          const upData = await uploadAsset({ uri: item.localPath, name: item.fileName, type: 'audio/mp4' });
          uploadTasks.current.delete(item.fileName);
          const ack = await new Promise((resolve) => {
            socket.emit('message:send', {
              otherUserId: item.otherUserId,
              type: 'VOICE',
              content: 'Voice message',
              mediaUrl: upData.url,
              duration: item.durationSec,
              waveform: item.waveform || '',
              clientId: item.clientId,
            }, resolve);
          });
          if (ack && ack.ok) {
            if (String(item.otherUserId) === String(otherUserId)) applyAck(item.clientId, ack.message, item.clientId);
            queue = queue.filter((it) => it.clientId !== item.clientId);
            await writeVoiceQueue(queue);
            deleteVoiceFile(item.localPath).catch(() => {});
          }
        } catch (e) {
          console.warn('queued voice send failed', e);
          break;
        }
      }
    } finally {
      voiceQueueBusyRef.current = false;
    }
  }, [socket, otherUserId, currentUser.id, uploadAsset, applyAck]);

  useEffect(() => {
    flushQueuedVoice();
    const onConnect = () => flushQueuedVoice();
    if (socket) socket.on('connect', onConnect);
    return () => { if (socket) socket.off('connect', onConnect); };
  }, [socket, flushQueuedVoice]);

  const sendVoiceMessage = useCallback((filePath, durationSec, waveformData) => {
    if (!filePath) return;
    const cleanPath = String(filePath).replace(/^file:\/\//, '');
    const clientId = `tmp-${currentUser.id}-${Date.now()}`;
    const fileName = `voice_${Date.now()}.m4a`;
    const duration = Math.max(1, Math.round(parseDuration(durationSec) || 1));
    const waveform = typeof waveformData === 'string' ? waveformData : '';
    const localMsg = {
      id: clientId,
      sender_id: currentUser.id,
      type: 'VOICE',
      content: 'Voice message',
      media_url: cleanPath,
      thumb_url: '',
      duration,
      waveform,
      created_at: new Date().toISOString(),
      status: 'SENT',
      reactions: [],
      client_id: clientId,
      _tempId: clientId,
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    const queuedItem = {
      clientId,
      otherUserId,
      localPath: cleanPath,
      fileName,
      durationSec: duration,
      waveform,
      createdAt: Date.now(),
    };
    pendingScrollToBottomRef.current = true;
    atBottomRef.current = true;
    atBottomNearRef.current = true;
    setAtBottomNear(true);
    pendingCountRef.current = 0;
    setPendingCount(0);
    if (!socketReady()) {
      setMessages((prev) => [...prev, { ...localMsg, _uploading: false, _queued: true }]);
      scrollToLatestAnimated();
      queueVoiceItem(queuedItem).catch((e) => console.warn('voice queue failed', e));
      return;
    }
    setMessages((prev) => [...prev, localMsg]);
    scrollToLatestAnimated();
    uploadAsset({ uri: cleanPath, name: fileName, type: 'audio/mp4' }, (p) => setUploadProgress(clientId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: 'VOICE',
          content: 'Voice message',
          mediaUrl: upData.url,
          duration,
          waveform,
          clientId,
        }, (ack) => {
          if (ack && ack.ok) {
            applyAck(clientId, ack.message, clientId);
          } else {
            setMessages((prev) => prev.filter((m) => m.id !== clientId));
            deleteVoiceFile(cleanPath).catch(() => {});
          }
        });
      })
      .catch((e) => {
        uploadTasks.current.delete(fileName);
        console.error('voice upload failed:', e);
        setMessages((prev) => prev.map((m) => (m.id === clientId ? { ...m, _uploading: false, _uploadError: true } : m)));
        queueVoiceItem(queuedItem).catch((err) => console.warn('voice queue failed', err));
      });
  }, [otherUserId, socket, currentUser.id, uploadAsset, setUploadProgress, scrollToLatestAnimated, applyAck, queueVoiceItem]);

  const showMicPermissionAlert = async () => {
    const status = await getMicPermissionStatus();
    Alert.alert(
      'Microphone permission',
      status === 'blocked'
        ? 'Microphone access is blocked. Open system settings to allow voice messages.'
        : 'Microphone access is required to record voice messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open settings', onPress: () => Linking.openSettings().catch(() => {}) },
      ]
    );
  };

  const startRecording = async () => {
    if (recording || recStoppingRef.current) return;
    const ok = await ensureMicPermission();
    if (!ok) {
      showMicPermissionAlert();
      return;
    }
    Keyboard.dismiss();
    try {
      const { path, name } = await startVoiceRecording();
      voicePathRef.current = path;
      voiceNameRef.current = name;
      recWaveRef.current = [];
      recHasMeteringRef.current = false;
      recDurationRef.current = 0;
      recPausedRef.current = false;
      recStoppingRef.current = false;
      recLastUiRef.current = 0;
      setRecordTime(0);
      setRecPaused(false);
      setRecWaveform(Array.from({ length: REC_BARS }, () => 0.14));
      setRecording(true);
      setShowAttach(false);
      setShowEmoji(false);
      recListenUnsub.current = trackVoiceRecording((e) => {
        if (!e) return;
        recDurationRef.current = Math.max(recDurationRef.current, e.elapsedMs || e.currentPosition || 0);
        if (e.hasMetering && typeof e.level === 'number') recHasMeteringRef.current = true;
        const level = e.hasMetering && typeof e.level === 'number'
          ? e.level
          : deriveRecordingLevel(recDurationRef.current);
        const now = Date.now();
        if (now - recLastUiRef.current < 90) return;
        recLastUiRef.current = now;
        const next = recWaveRef.current.concat(level).slice(-REC_BARS);
        while (next.length < REC_BARS) next.unshift(0.14);
        recWaveRef.current = next;
        setRecWaveform(next);
        setRecordTime(recDurationRef.current);
      });
    } catch (e) {
      console.error('startRecording failed', e);
      Alert.alert('Could not start recording', voiceErrorMessage(e));
    }
  };

  const toggleRecordPause = async () => {
    if (!recording || recStoppingRef.current) return;
    try {
      if (recPausedRef.current) {
        await resumeVoiceRecording();
        recPausedRef.current = false;
        setRecPaused(false);
      } else {
        await pauseVoiceRecording();
        recPausedRef.current = true;
        setRecPaused(true);
      }
    } catch (e) {
      console.error('record pause failed', e);
      Alert.alert('Could not change recording', voiceErrorMessage(e));
    }
  };

  const stopRecording = async (cancel) => {
    if (recStoppingRef.current) return;
    recStoppingRef.current = true;
    const path = voicePathRef.current;
    voicePathRef.current = null;
    if (recListenUnsub.current) {
      recListenUnsub.current();
      recListenUnsub.current = null;
    }
    setRecording(false);
    setRecPaused(false);
    setRecordTime(0);

    let result = null;
    try {
      result = await stopVoiceRecording();
    } catch (e) {
      console.warn('stopVoiceRecording failed', e);
      result = { path, durationMs: recDurationRef.current };
    }
    const filePath = (result && result.path) || path;
    const elapsedMs = (result && result.durationMs) || recDurationRef.current || getVoiceRecordingElapsedMs();
    const waveform = recHasMeteringRef.current ? serializeWaveform(recWaveRef.current) : '';
    const durationSec = Math.max(1, Math.round(elapsedMs / 1000));
    recPausedRef.current = false;
    recStoppingRef.current = false;
    setRecWaveform(Array.from({ length: REC_BARS }, () => 0.14));

    if (cancel || !filePath) {
      deleteVoiceFile(filePath || path).catch(() => {});
      return;
    }
    if (elapsedMs < 900) {
      deleteVoiceFile(filePath).catch(() => {});
      Alert.alert('Too short', 'Hold a little longer before sending.');
      return;
    }
    sendVoiceMessage(filePath, durationSec, waveform);
  };

  const toggleVoicePlayback = useCallback(async (msg) => {
    if (!msg || !msg.media_url) return;
    if (msg._pending || msg._uploading || msg._uploadError) return;
    const id = msg.id;
    if (playingIdRef.current === id) {
      await stopVoicePlayback();
      playingIdRef.current = null;
      setPlayingVoiceId(null);
      setVoiceProgress(0);
      setVoiceDurationMs(0);
      voiceProgressRef.current = 0;
      return;
    }
    await stopVoicePlayback();
    playingIdRef.current = id;
    setPlayingVoiceId(id);
    setVoiceProgress(0);
    setVoiceDurationMs(0);
    voiceProgressRef.current = 0;
    voiceLastTickRef.current = 0;
    try {
      await playVoice(absUrl(msg.media_url), (e) => {
        if (playingIdRef.current !== id) return;
        const fallbackMs = parseDuration(msg.duration) * 1000;
        const totalMs = (e && e.durationMs) || fallbackMs;
        const posMs = (e && e.positionMs) || 0;
        const ratio = totalMs > 0 ? Math.min(1, Math.max(0, posMs / totalMs)) : 0;
        if (totalMs > 0) setVoiceDurationMs((prev) => (prev === totalMs ? prev : totalMs));
        const now = Date.now();
        if ((Math.abs(ratio - voiceProgressRef.current) >= 0.02 && now - voiceLastTickRef.current >= 160) || (e && e.isFinished)) {
          voiceProgressRef.current = ratio;
          voiceLastTickRef.current = now;
          setVoiceProgress(e && e.isFinished ? 0 : ratio);
        }
        if (e && e.isFinished) {
          playingIdRef.current = null;
          setPlayingVoiceId(null);
          setVoiceProgress(0);
          setVoiceDurationMs(0);
          voiceProgressRef.current = 0;
        }
      });
    } catch (e) {
      console.error('voice play failed', e);
      playingIdRef.current = null;
      setPlayingVoiceId(null);
      setVoiceProgress(0);
      setVoiceDurationMs(0);
      voiceProgressRef.current = 0;
      Alert.alert('Could not play voice note', voiceErrorMessage(e));
    }
  }, []);

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
    else if (action === 'save') { if (message && message.media_url) downloadAndOpen(message); }
  };

  // Stable per-row edit handler (reads the latest doAction via ref so its identity is
  // constant and MessageRow memoization stays effective across message arrivals).
  const doActionRef = useRef(null);
  doActionRef.current = doAction;
  const doEditRow = useCallback((m) => doActionRef.current && doActionRef.current('edit', m), []);

  const clearChatLocal = () => {
    setMessages([]);
    setReplyingTo(null);
    setEditing(null);
    setText('');
    clearConversationCache(currentUser.id, otherUserId);
    setReactionPop(null);
    setSelMenu(false);
  };

  const sendFile = (asset) => {
    if (!asset || !asset.uri) return;
    const fileName = asset.name || `file_${Date.now()}`;
    const fileSize = asset.size || 0;
    const mimeType = asset.type || 'application/octet-stream';
    const tempId = `tmp-${currentUser.id}-${Date.now()}`;
    const clientId = tempId;
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
      client_id: clientId,
      _tempId: clientId,
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    pendingScrollToBottomRef.current = true;
    scrollToLatestAnimated();
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
          clientId,
        }, (ack) => {
          if (ack && ack.ok) {
            applyAck(clientId, ack.message, clientId);
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
            // Close the attach sheet and keyboard before firing the camera intent.
            // On ColorOS/OPPO the intent can be swallowed when it races a UI
            // transition, which made the camera tap appear to do nothing.
            Keyboard.dismiss();
            if (cameraTimeoutRef.current) clearTimeout(cameraTimeoutRef.current);
            await new Promise((res) => setTimeout(res, 80));
            cameraTimeoutRef.current = setTimeout(() => {
              cameraTimeoutRef.current = null;
              alert('The camera did not open. Grant the camera permission in system settings and try again.');
            }, 12000);
            ImagePicker.launchCamera({ mediaType: 'photo', includeBase64: false }, (r) => {
              if (cameraTimeoutRef.current) { clearTimeout(cameraTimeoutRef.current); cameraTimeoutRef.current = null; }
              if (r.didCancel) return;
              if (r.errorCode) {
                alert('Failed to open camera: ' + (r.errorMessage || r.errorCode || 'Unknown error'));
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

  const toCacheFile = async (uri) => {
    if (!uri || !String(uri).startsWith('content://')) return uri;
    try {
      const { dirs } = RNFetchBlob.fs;
      const ext = String(uri).split('.').pop() || 'img';
      const target = `${dirs.CacheDir}/tojey_pick_${Date.now()}.${ext}`;
      const res = await RNFetchBlob.config({ fileCache: true, path: target }).fetch('GET', uri);
      return res.path();
    } catch (e) {
      console.error('toCacheFile failed:', e.message);
      return uri;
    }
  };

  const openEditor = async (asset) => {
    if (!asset || !asset.uri) return;
    const isVideo = !!(asset.type && asset.type.toLowerCase().startsWith('video'));
    const uri = await toCacheFile(asset.uri);
    setPreviewAsset({
      uri,
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
    const tempId = `tmp-${currentUser.id}-${Date.now()}`;
    const clientId = tempId;
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
      client_id: clientId,
      _tempId: clientId,
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    pendingScrollToBottomRef.current = true;
    scrollToLatestAnimated();
    uploadAsset({ uri: opts.uri, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        const payload = {
          otherUserId,
          type: isVideo ? 'VIDEO' : 'IMAGE',
          content,
          mediaUrl: upData.url,
          thumbUrl: upData.url,
          fileName,
          clientId,
        };
        socket.emit('message:send', payload, (ack) => {
          if (ack && ack.ok) {
            applyAck(clientId, ack.message, clientId);
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
    const isVoice = msg.type === 'VOICE';
    const tempId = `tmp-${currentUser.id}-${Date.now()}-r`;
    const clientId = tempId;
    const fileName = isFile
      ? (msg.file_name || msg.content || `file_${Date.now()}`)
      : isVoice ? `voice_${Date.now()}.m4a`
      : isVideo ? `video_${Date.now()}.mp4` : `photo_${Date.now()}.jpg`;
    const mimeType = isFile
      ? (mimeFor(msg) || 'application/octet-stream')
      : isVoice ? 'audio/mp4'
      : isVideo ? 'video/mp4' : 'image/jpeg';
    replaceIntentRef.current = true;
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, id: tempId, client_id: clientId, _tempId: clientId, _pending: true, _uploading: true, _uploadError: false, _uploadKey: fileName, _uploadProgress: 0 } : m)));
    pendingScrollToBottomRef.current = true;
    scrollToLatestInstant();
    uploadAsset({ uri: msg.media_url, name: fileName, type: mimeType }, (p) => setUploadProgress(tempId, p))
      .then((upData) => {
        uploadTasks.current.delete(fileName);
        socket.emit('message:send', {
          otherUserId,
          type: msg.type,
          content: isFile ? fileName : (isVoice ? 'Voice message' : (isVideo ? '🎬 Video' : '📷 Photo')),
          mediaSize: isFile ? (msg.media_size || 0) : 0,
          mediaUrl: upData.url,
          thumbUrl: isFile || isVoice ? '' : upData.url,
          fileName,
          clientId,
          ...(isVoice ? { duration: msg.duration || 1, waveform: msg.waveform || '' } : {}),
        }, (ack) => {
          if (ack && ack.ok) {
            applyAck(clientId, ack.message, clientId);
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
  }, [otherUserId, socket, currentUser.id, uploadAsset, setUploadProgress, applyAck]);

  const uploadDrawing = useCallback(async (filePath, onDone) => {
    if (!filePath) return;
    const tempId = `tmp-${currentUser.id}-draw-${Date.now()}`;
    const clientId = tempId;
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
      client_id: clientId,
      _tempId: clientId,
      _local: true,
      _pending: true,
      _uploading: true,
      _uploadKey: fileName,
      _uploadProgress: 0,
    };
    setMessages((prev) => [...prev, localMsg]);
    pendingScrollToBottomRef.current = true;
    scrollToLatestAnimated();
    try {
      const upData = await uploadAsset({ uri: filePath, name: fileName, type: 'image/png' }, (p) => setUploadProgress(tempId, p));
      uploadTasks.current.delete(fileName);
      socket.emit('message:send', {
        otherUserId,
        type: 'IMAGE',
        content: '🖌️ Drawing',
        mediaUrl: upData.url,
        thumbUrl: upData.url,
        clientId,
      }, (ack) => {
        if (ack && ack.ok) {
          applyAck(clientId, ack.message, clientId);
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
  }, [otherUserId, socket, currentUser.id, uploadAsset, setUploadProgress, applyAck]);

  const downloadAndOpen = useCallback(async (message) => {
    if (!message || !message.media_url) return;
    const mime = mimeFor(message);
    let name = sanitizeFileName(message.file_name) || sanitizeFileName(fileNameFromUrl(message.media_url)) || `tojey_file_${Date.now()}`;
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(name) && mime !== 'application/octet-stream') {
      name = `${name}.${extForMime(mime)}`;
    }
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

  // WhatsApp-style download: photos/videos go straight into the Gallery (DCIM/Tojey)
  // via a media scan so they appear in the Photos app; documents go to Download/.
  const saveToGallery = useCallback(async (message) => {
    if (!message || !message.media_url) return;
    const isMedia = message.type === 'IMAGE' || message.type === 'VIDEO';
    const mime = mimeFor(message);
    let name = sanitizeFileName(message.file_name) || sanitizeFileName(fileNameFromUrl(message.media_url)) || `tojey_media_${Date.now()}`;
    if (!/\.[a-zA-Z0-9]{2,5}$/.test(name) && mime !== 'application/octet-stream') {
      name = `${name}.${extForMime(mime)}`;
    }
    const { dirs } = RNFetchBlob.fs;
    const path = isMedia ? `${dirs.DCIMDir}/Tojey/${name}` : `${dirs.DownloadDir}/${name}`;
    try {
      await RNFetchBlob.config({ fileCache: false, path }).fetch('GET', absUrl(message.media_url));
      Promise.resolve(RNFetchBlob.fs.scanFile([path])).catch(() => {});
      Alert.alert('Saved', isMedia ? `Saved to Gallery (DCIM/Tojey/${name})` : `Downloaded to Download/${name}`);
    } catch (e) {
      console.error('saveToGallery failed:', e);
      alert('Could not save file: ' + (e.message || 'Unknown error'));
    }
  }, []);

const isOnline = presence?.isOnline ?? otherUserOnline;
  const lastSeen = presence?.lastSeen ?? otherUserLastSeen;
  const headerStatus = typing ? 'typing…' : (isOnline ? 'Online' : lastSeenText(lastSeen));
  const chatBg = theme.isDark ? '#16141C' : '#F2F0F9';
  const composerBg = hexToRgba(theme.composerBg, 0.94);
  // How much of the window the soft keyboard actually shrank the message area. When the
  // OEM honors adjustResize this equals the keyboard height (nothing extra is needed).
  // When it fails (ColorOS/OPPO) the message area keeps its full height and the keyboard
  // goes on top of it - the list then needs the hidden amount of extra bottom padding,
  // otherwise the newest message stays hidden behind the input bar after sending.
  const kbShrinkTaken = kbOpen ? Math.max(0, (msgAreaClosedH.current || msgAreaH || 0) - msgAreaH) : 0;
  const kbOverlap = kbOpen ? Math.max(0, kbHeight - kbShrinkTaken) : 0;
  // The list lives inside msgArea (flex: 1), and the reply/edit/record/attach/emoji
  // bars and the composer are SIBLINGS below it in the same flex column. Flex
  // already shrinks the list so it ends directly above whichever bars are showing,
  // in both keyboard states. So the list needs a small constant pad only, and
  // adding barsStack here double-counted those bars - which pushed the newest
  // message up by a full composer height and left a large empty gap above it.
  // Extra padding is still required in exactly one case: an OEM that ignores
  // adjustResize, so the keyboard draws over a window that never shrank.
  const bottomPad = kbOpen && kbOverlap > 10 ? 12 + kbOverlap : 12;
  bottomInsetRef.current = bottomPad;
  const jumpBottom = (barHeights.rec || 0) + (barHeights.attach || 0) + (barHeights.emoji || 0) + (barHeights.reply || 0) + (barHeights.edit || 0) + (composerH || 60) + 12;

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
        <TouchableOpacity
          onPress={() => headerCallPress(safeOtherUser)}
          style={styles.headerIconBtn}
          accessibilityLabel={callStatus !== 'none' ? 'Open video call' : 'Start video call'}
        >
          <Icon name="videocam-outline" size={22} color={callStatus !== 'none' ? '#E53935' : theme.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { if (reactionPop) { setNudgeMenuVisible(false); getNudgeVibrationEnabled().then(setNudgeMenuVisible); setSelMenu(true); } else { setHeaderMenu((v) => !v); } }}
          style={styles.headerIconBtn}
          accessibilityLabel={reactionPop ? 'Message options' : 'Chat options'}
        >
          <Icon name="ellipsis-vertical" size={22} color={theme.text} />
        </TouchableOpacity>
      </View>

      {selMenu && reactionPop && (
        <View style={styles.headerMenuOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => { setSelMenu(false); setReactionPop(null); }} accessibilityLabel="Close menu" />
          <View style={[styles.headerMenu, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); setReplyingTo(reactionPop.msg); setReactionPop(null); }} accessibilityLabel="Reply to message">
              <Icon name="return-down-back-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
              <Text style={{ color: theme.text, fontSize: fs(15) }}>Reply</Text>
            </TouchableOpacity>
            {nudgeMenuVisible && (
              <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); setReactionPop(null); sendNudge(); }} accessibilityLabel="Nudge">
                <Icon name="hand-left-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.text, fontSize: fs(15) }}>Nudge</Text>
              </TouchableOpacity>
            )}
            {!!reactionPop.msg && reactionPop.msg.sender_id === currentUser.id && reactionPop.msg.type === 'TEXT' && !reactionPop.msg.is_deleted_for_everyone && (
              <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); setReactionPop(null); doAction('edit', reactionPop.msg); }} accessibilityLabel="Edit message">
                <Icon name="create-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.text, fontSize: fs(15) }}>Edit</Text>
              </TouchableOpacity>
            )}
            {!!reactionPop.msg && !!reactionPop.msg.content && (
              <TouchableOpacity style={styles.headerMenuItem} onPress={() => { setSelMenu(false); setReactionPop(null); Clipboard.setString(reactionPop.msg.content); }} accessibilityLabel="Copy message">
                <Icon name="copy-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.text, fontSize: fs(15) }}>Copy</Text>
              </TouchableOpacity>
            )}
            {!!reactionPop.msg && !!reactionPop.msg.media_url && reactionPop.msg.type !== 'VOICE' && (
              <TouchableOpacity
                style={styles.headerMenuItem}
                onPress={() => {
                  const m = reactionPop.msg;
                  setSelMenu(false);
                  setReactionPop(null);
                  if (m.type === 'IMAGE' || m.type === 'VIDEO') saveToGallery(m);
                  else downloadAndOpen(m);
                }}
                accessibilityLabel="Save message"
              >
                <Icon name="download-outline" size={18} color={theme.primary} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.text, fontSize: fs(15) }}>
                  {reactionPop.msg.type === 'IMAGE' || reactionPop.msg.type === 'VIDEO' ? 'Save' : 'Download'}
                </Text>
              </TouchableOpacity>
            )}
            {!!reactionPop.msg && !reactionPop.msg.is_deleted_for_everyone && (
              <TouchableOpacity
                style={styles.headerMenuItem}
                onPress={() => { setSelMenu(false); setReactionPop(null); deleteMessage(reactionPop.msg, 'me'); }}
                accessibilityLabel="Delete for me"
              >
                <Icon name="trash-outline" size={18} color={theme.danger} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.danger, fontSize: fs(15) }}>Delete for me</Text>
              </TouchableOpacity>
            )}
            {!!reactionPop.msg && reactionPop.msg.sender_id === currentUser.id && !reactionPop.msg.is_deleted_for_everyone && (
              <TouchableOpacity
                style={styles.headerMenuItem}
                onPress={() => { setSelMenu(false); setReactionPop(null); deleteMessage(reactionPop.msg, 'everyone'); }}
                accessibilityLabel="Unsend for everyone"
              >
                <Icon name="arrow-undo-outline" size={18} color={theme.danger} style={{ marginRight: 12 }} />
                <Text style={{ color: theme.danger, fontSize: fs(15) }}>Unsend</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {headerMenu && (
        <View style={styles.headerMenuOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => setHeaderMenu(false)} accessibilityLabel="Close menu" />
          <View style={[styles.headerMenu, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <TouchableOpacity
              style={styles.headerMenuItem}
              onPress={() => {
                setHeaderMenu(false);
                Alert.alert('Clear chat', 'Delete all messages in this chat for BOTH of you? They will also be removed from the server.', [
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                      if (socket && otherUserId) socket.emit('conversation:clear', { otherUserId });
                      clearChatLocal();
                    },
                  },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
              accessibilityLabel="Clear chat"
            >
              <Icon name="trash-outline" size={18} color={theme.danger} style={{ marginRight: 12 }} />
              <Text style={{ color: theme.danger, fontSize: fs(15) }}>Clear chat</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Messages */}
      <View
        style={[styles.msgArea, { backgroundColor: chatBg }]}
        onLayout={(e) => {
          const h = Math.round(e.nativeEvent.layout.height);
          setMsgAreaH(h);
          if (!kbOpen) msgAreaClosedH.current = h;
        }}
      >
        {CHAT_BACKGROUND && (
          <Image
            source={{ uri: CHAT_BACKGROUND }}
            style={StyleSheet.absoluteFill}
            resizeMode="repeat"
            fadeDuration={0}
          />
        )}
        <MessageList
          messages={messages}
          ownId={currentUser.id}
          otherUserName={otherUserName}
          theme={theme}
          listRef={listRef}
          bottomPad={bottomPad}
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onContentSizeChange={handleContentSizeChange}
          onLayout={handleListLayout}
          onOpenMedia={openMedia}
          onLongPress={handleLongPress}
          onDoubleTap={toggleLike}
          onReply={setReplyingTo}
          onEditRow={doEditRow}
          onRetry={retrySendMedia}
          onCancelUpload={cancelUpload}
          onPlayVoice={toggleVoicePlayback}
          playingVoiceId={playingVoiceId}
          voiceProgress={voiceProgress}
          voiceDurationMs={voiceDurationMs}
          otherUserAvatar={otherUserAvatar}
          otherUserName={otherUserName}
          currentUserAvatar={currentUserAvatar}
          entryMap={listMeta.entryMap}
        />
      {!atBottomNear && pendingCount > 0 && (
        <TouchableOpacity
          onPress={jumpToLatest}
          style={[styles.jumpLatest, { bottom: jumpBottom, backgroundColor: theme.primary }]}
          accessibilityLabel="Jump to latest message"
        >
          <Icon name="arrow-down" size={fs(18)} color="#fff" />
          <View style={styles.jumpBadge}>
            <Text style={styles.jumpBadgeText}>{pendingCount > 99 ? '99+' : pendingCount}</Text>
          </View>
        </TouchableOpacity>
      )}
      {/* More emojis (reached via the + on the reaction bar). Reactions only. */}
      {reactionMenu && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={styles.menuBackdrop} onPress={() => setReactionMenu(null)} />
          <View style={[styles.menu, { backgroundColor: theme.card }]}>
            <Text style={[styles.menuTitle, { color: theme.textSecondary }]}>Reactions</Text>
            <View style={styles.reactionRow}>
              {sheetReactions.map((r) => (
                <TouchableOpacity key={r} onPress={() => reactTo(reactionMenu.id, r)} style={[styles.reactionBtn, { backgroundColor: theme.primaryLight }]}>
                  <ColorEmoji style={{ fontSize: fs(22) }}>{r}</ColorEmoji>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      )}

      {/* WhatsApp-style floating reaction bar (intelligently kept on-screen) */}
      {reactionPop && (
        <View style={styles.menuOverlay}>
          <TouchableOpacity style={[styles.menuBackdrop, { backgroundColor: 'transparent' }]} onPress={() => setReactionPop(null)} />
          <View
            style={[
              styles.reactionPop,
              { backgroundColor: theme.card, borderColor: theme.border, left: reactionPop.left, top: reactionPop.top },
            ]}
          >
            {reactionPopRow.map((e) => (
              <TouchableOpacity
                key={e}
                onPress={() => { reactTo(reactionPop.msg.id, e); setReactionPop(null); }}
                style={styles.reactionPopBtn}
                accessibilityLabel={`React ${e}`}
              >
                <ColorEmoji style={{ fontSize: fs(23) }}>{e}</ColorEmoji>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              onPress={() => { setReactionMenu(reactionPop.msg); setReactionPop(null); }}
              style={styles.reactionPopBtn}
              accessibilityLabel="Show all options"
            >
              <Icon name="add" size={20} color={theme.primary} />
            </TouchableOpacity>
            <View style={[styles.reactionPopCaret, { backgroundColor: theme.card, left: reactionPop.caretX }]} />
          </View>
        </View>
      )}

      {/* Replying bar */}
      {replyingTo && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('reply')}>
          <View style={[styles.replyLine, { backgroundColor: theme.primary }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.replyTitle, { color: theme.primary }]}>
              Replying to {replyingTo.sender_id === currentUser.id ? 'yourself' : otherUserName}
            </Text>
            <ColorEmoji numberOfLines={1} style={[styles.replyPreview, { color: theme.textSecondary }]}>
              {replyPreview(replyingTo)}
            </ColorEmoji>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)}>
            <Icon name="close" size={18} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Editing bar */}
      {editing && (
        <View style={[styles.replyBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('edit')}>
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

      {recording && (
        <View style={[styles.recBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('rec')}>
          <TouchableOpacity onPress={() => stopRecording(true)} style={styles.recCancel} accessibilityLabel="Delete recording">
            <Icon name="trash-outline" size={18} color={theme.danger} />
          </TouchableOpacity>
          <View style={[styles.recPill, { backgroundColor: theme.primaryLight }]}>
            <View style={[styles.recDot, { backgroundColor: recPaused ? theme.textSecondary : theme.danger }]} />
            <Text style={[styles.recTime, { color: theme.text }]} accessibilityLabel="Recording duration">
              {fmtDur(Math.floor(recordTime / 1000))}
            </Text>
            <View style={styles.recWaveWrap}>
              {recWaveform.map((level, i) => (
                <View
                  key={i}
                  style={[
                    styles.recWaveBar,
                    {
                      height: fs(4 + Math.max(0.08, level) * 20),
                      backgroundColor: recPaused ? theme.textSecondary : theme.primary,
                      opacity: recPaused ? 0.5 : 0.5 + level * 0.5,
                    },
                  ]}
                />
              ))}
            </View>
          </View>
          <TouchableOpacity
            onPress={toggleRecordPause}
            style={[styles.recPause, { backgroundColor: theme.inputBg }]}
            accessibilityLabel={recPaused ? 'Resume recording' : 'Pause recording'}
          >
            <Icon name={recPaused ? 'play' : 'pause'} size={17} color={theme.primary} />
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
      {showAttach && !recording  && (
        <View style={[styles.attachBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('attach')}>
          <AttachBtn label="Photo" icon="image-outline" color={theme.primary} onPress={() => pickMedia('photo')} theme={theme} />
          <AttachBtn label="Camera" icon="camera-outline" color={theme.primaryDeep} onPress={() => pickMedia('camera')} theme={theme} />
          <AttachBtn label="Files" icon="folder-open-outline" color={theme.primary} onPress={() => pickMedia('files')} theme={theme} />
        </View>
      )}

      {/* Emoji quick-pick strip (WhatsApp-style emoji button) */}
      {showEmoji && !recording  && (
        <View style={[styles.attachBar, { backgroundColor: theme.card, borderTopColor: theme.border }]} onLayout={setBarH('emoji')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {emojiQuick.map((e) => (
              <TouchableOpacity
                key={e}
                style={styles.emojiPickBtn}
                onPress={() => {
                  setText((prev) => prev + e);
                  inputRef.current?.focus();
                }}
                accessibilityLabel={`Emoji ${e}`}
              >
                <ColorEmoji style={{ fontSize: fs(26) }}>{e}</ColorEmoji>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Composer: [emoji] [input…………] [attachment] [mic/send] (camera lives in the attachment menu) */}
      {!recording  && (
        <View
          style={[styles.composer, { backgroundColor: composerBg, borderTopColor: theme.border }]}
          onLayout={(e) => setComposerH(Math.round(e.nativeEvent.layout.height))}
        >
          <View style={styles.composerRow}>
            <TouchableOpacity
              style={[styles.composerBtn, { backgroundColor: showEmoji ? theme.primary : theme.inputBg }]}
              onPress={() => { if (showAttach) setShowAttach(false); setShowEmoji(!showEmoji); inputRef.current?.focus(); }}
              accessibilityLabel="Add emoji"
            >
              <Icon name="happy-outline" size={22} color={showEmoji ? '#fff' : theme.primary} />
            </TouchableOpacity>
            <View style={[styles.inputWrap, { backgroundColor: theme.inputBg }]}>
              <TextInput
                ref={inputRef}
                value={text}
                onChangeText={onType}
                placeholder="Type a message"
                placeholderTextColor={theme.textSecondary}
                style={[styles.input, { color: theme.text }]}
                multiline
                blurOnSubmit={!enterSendRef.current}
                onKeyPress={(e) => {
                  if (!enterSendRef.current) return;
                  const key = e.nativeEvent.key;
                  if (key !== 'Enter') {
                    allowNewlineRef.current = false;
                    return;
                  }
                  if (e.nativeEvent.shiftKey) {
                    allowNewlineRef.current = true;
                    return;
                  }
                  e.preventDefault?.();
                  const content = text.trim();
                  if (!content) return;
                  const now = Date.now();
                  const last = lastEnterSentRef.current;
                  if (last && last.content === content && now - last.at < 1500) {
                    lastEnterSentRef.current = null;
                    return;
                  }
                  lastEnterSentRef.current = { content, at: now };
                  pressSend();
                }}
                onPressIn={reopenKeyboard}
                onFocus={ensureKeyboard}
              />
            </View>
            <TouchableOpacity
              style={[styles.composerBtn, { backgroundColor: showAttach ? theme.primary : theme.inputBg }]}
              onPress={() => { if (showEmoji) setShowEmoji(false); setShowAttach(!showAttach); }}
              accessibilityLabel="Add attachments"
            >
              <Icon name="attach-outline" size={20} color={showAttach ? '#fff' : theme.primary} />
            </TouchableOpacity>
            {text.trim() ? (
              <TouchableOpacity
                style={[styles.sendBtn, { backgroundColor: sendFlash ? '#0B0F14' : theme.primary }]}
                onPress={pressSend}
                activeOpacity={0.85}
                accessibilityLabel="Send message"
              >
                <Animated.View style={{ transform: [{ scale: sendScale }] }}>
                  <Icon name="send" size={18} color="#fff" />
                </Animated.View>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={[styles.micBtn, { backgroundColor: theme.primary }]} onPress={startRecording} accessibilityLabel="Record voice message">
                <Icon name="mic" size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

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
          onSendReplyMessage={sendReplyText}
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

      <Toast message={nudgeToast} bottom={(barHeights.rec || 0) + (barHeights.attach || 0) + (barHeights.emoji || 0) + (barHeights.reply || 0) + (barHeights.edit || 0) + (composerH || 60) + 6} />
    </View>
    </KeyboardAvoidingView>
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
  if (m.type === 'VOICE') return 'audio/mp4';
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
  return last ? last.split(/[?#]/)[0] : null;
}

function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return null;
  const base = name.split(/[?#]/)[0];
  return (base.replace(/[^\w.\- ]+/g, '_') || null).slice(0, 120);
}

function extForMime(mime) {
  if (!mime) return 'bin';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/zip') return 'zip';
  if (mime.startsWith('text/')) return 'txt';
  if (mime.includes('word') || mime.includes('msword')) return 'doc';
  if (mime.includes('excel') || mime.includes('sheet')) return 'xls';
  if (mime.includes('powerpoint')) return 'ppt';
  if (mime.startsWith('image/')) return 'img';
  return 'bin';
}

function formatBytes(b) {
  if (!b || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function dedupeReactions(reactions) {
  const map = new Map();
  (reactions || []).forEach((r) => {
    if (!r || !r.reaction) return;
    map.set(r.reaction, (map.get(r.reaction) || 0) + 1);
  });
  return Array.from(map.entries()).map(([emoji, count]) => ({ emoji, count }));
}

const VoiceMessageBubble = memo(function VoiceMessageBubble({
  message, isSent, theme, voicePlaying, voiceProgress, voiceDurationMs, onPlayVoice, onRetry,
  avatarUri, avatarName,
}) {
  const waveform = useMemo(() => parseWaveform(message.waveform), [message.waveform]);
  const totalMs = voicePlaying && voiceDurationMs > 0
    ? voiceDurationMs
    : parseDuration(message.duration) * 1000;
  const ratio = voicePlaying ? Math.min(1, Math.max(0, Number(voiceProgress) || 0)) : 0;
  const playedBars = Math.ceil(ratio * waveform.bars.length);
  const shownMs = voicePlaying && totalMs > 0 ? ratio * totalMs : totalMs;
  const label = String(avatarName || (isSent ? 'You' : '?')).trim().charAt(0).toUpperCase() || '?';
  const avatar = (
    <View style={[styles.voiceAvatar, { backgroundColor: isSent ? theme.primary : theme.primaryDeep }]}>
      {avatarUri ? (
        <Image source={{ uri: absUrl(avatarUri) }} style={styles.voiceAvatarImg} />
      ) : (
        <Text style={styles.voiceAvatarText}>{label}</Text>
      )}
    </View>
  );

  return (
    <TouchableOpacity
      onPress={() => {
        if (message._uploadError && onRetry) onRetry(message);
        else if (onPlayVoice) onPlayVoice(message);
      }}
      activeOpacity={0.7}
      style={styles.voiceBubble}
      accessibilityLabel={voicePlaying ? 'Pause voice message' : 'Play voice message'}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {!isSent && avatar}
        <View style={[styles.voicePlay, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primaryLight }]}>
          <Icon name={voicePlaying ? 'pause' : 'play'} size={18} color={isSent ? '#fff' : theme.primary} />
        </View>
        <View style={[styles.voiceWaveWrap, { marginLeft: isSent ? 0 : 8, marginRight: isSent ? 8 : 0 }]}>
          <View style={styles.voiceWaveRow}>
            {waveform.bars.map((level, i) => (
              <View
                key={i}
                style={[
                  styles.voiceBar,
                  {
                    height: fs(4 + level * 16),
                    backgroundColor: isSent ? '#fff' : theme.primary,
                    opacity: i < playedBars ? 1 : (isSent ? 0.45 : 0.35),
                  },
                ]}
              />
            ))}
          </View>
          <View style={[styles.voiceTrack, { backgroundColor: isSent ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.12)' }]}>
            <View style={{ width: `${Math.round(ratio * 100)}%`, height: 2, backgroundColor: isSent ? '#fff' : theme.primary }} />
          </View>
          <Text style={[styles.voiceTime, { color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary }]}>
            {totalMs > 0 ? `${fmtDur(shownMs / 1000)}${voicePlaying ? ` / ${fmtDur(totalMs / 1000)}` : ''}` : '--:--'}
          </Text>
        </View>
        {isSent && avatar}
      </View>
      {message._uploading && (
        <View style={styles.voiceUploadRow}>
          <ArcProgress size={28} thickness={3} progress={message._uploadProgress} color={isSent ? '#fff' : theme.primary} track={isSent ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.1)'} />
          <Text style={[styles.voiceUploadText, { color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary }]}>
            {Math.round((message._uploadProgress || 0) * 100)}%
          </Text>
        </View>
      )}
      {message._uploadError && (
        <Text style={[styles.voiceUploadText, { color: isSent ? 'rgba(255,255,255,0.85)' : theme.danger }]}>
          Upload failed · tap to retry
        </Text>
      )}
    </TouchableOpacity>
  );
});

function MessageRowFn({ message, isSent, grouped, theme, receivedBubble, flash, ownId, otherName, voiceAvatarUri, voiceAvatarName, replyRef, onLongPress, onOpenMedia, onRetry, onReply, onDoubleTap, onJumpToReply, suggestEdit, onEditRow, onCancelUpload, voicePlaying, voiceProgress, voiceDurationMs, onPlayVoice, animateEntry, rowKey }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const revealOpacity = useRef(new Animated.Value(0)).current;
  const translateRef = useRef(0);
  const swipeDirection = isSent ? -1 : 1; // sent bubbles swipe right→left, received left→right
  const replied = useRef(false);
  const entryViewRef = useRef(null);
  const entryAnimationRef = useRef(null);
  const entryOpacity = useRef(new Animated.Value(animateEntry ? 0 : 1)).current;
  const entryTranslate = useRef(new Animated.Value(animateEntry ? (isSent ? 10 : -10) : 0)).current;
  const entryScale = useRef(new Animated.Value(animateEntry ? 0.96 : 1)).current;

  useLayoutEffect(() => {
    let active = true;
    if (entryAnimationRef.current) entryAnimationRef.current.stop();
    if (!animateEntry) {
      entryOpacity.setValue(1);
      entryTranslate.setValue(0);
      entryScale.setValue(1);
      return () => { active = false; };
    }
    const settleVisible = () => {
      entryOpacity.setValue(1);
      entryTranslate.setValue(0);
      entryScale.setValue(1);
    };
    const run = (rowY) => {
      if (!active) return;
      if (Number.isFinite(rowY) && (rowY < -8 || rowY > APP_H + 80)) {
        settleVisible();
        return;
      }
      entryOpacity.setValue(0);
      entryTranslate.setValue(isSent ? 10 : -10);
      entryScale.setValue(0.96);
      const animation = Animated.parallel([
        Animated.timing(entryOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(entryTranslate, { toValue: 0, useNativeDriver: true, friction: 8, tension: 180 }),
        Animated.spring(entryScale, { toValue: 1, useNativeDriver: true, friction: 9, tension: 200 }),
      ]);
      entryAnimationRef.current = animation;
      animation.start();
    };
    if (entryViewRef.current && entryViewRef.current.measure) {
      entryViewRef.current.measure((_x, y) => run(y));
    } else {
      run(null);
    }
    return () => {
      active = false;
      if (entryAnimationRef.current) entryAnimationRef.current.stop();
    };
  }, [animateEntry, rowKey, isSent, entryOpacity, entryTranslate, entryScale]);

  const swipeAction = (m) => (suggestEdit && onEditRow ? onEditRow(m) : onReply(m));

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && Math.abs(g.dx) < 200,
    onPanResponderMove: (_, g) => {
      let v = swipeDirection === 1 ? Math.max(0, g.dx) : Math.min(0, g.dx);
      translateX.setValue(Math.max(-110, Math.min(110, v)));
      revealOpacity.setValue(1);
    },
    onPanResponderRelease: (_, g) => {
      const trigger = swipeDirection === 1 ? g.dx > 70 : g.dx < -70;
      if (trigger) {
        replied.current = true;
        Animated.spring(translateX, { toValue: swipeDirection * 110, useNativeDriver: true, bounciness: 0, speed: 30 }).start(() => {
          swipeAction(message);
          replied.current = false;
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          Animated.timing(revealOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
        });
      } else {
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 30 }).start();
        Animated.timing(revealOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start();
      }
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      Animated.timing(revealOpacity, { toValue: 0, duration: 120, useNativeDriver: true }).start();
    },
  })).current;

  const hasMedia = !!(message.media_url || message.thumb_url);
  const statusIcon = message._queued || message._uploading
    ? 'time-outline'
    : message.status === 'READ'
      ? 'checkmark-done' : message.status === 'DELIVERED'
        ? 'checkmark-done' : 'checkmark';
  const statusColor = message.status === 'READ' ? '#53C3FF' : (isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary);

  const singleEmoji = message.type === 'TEXT' && isSingleEmoji(message.content);
  const mediaBase = Math.min(APP_W * 0.62, 250);
  const mw = message.media_width;
  const mh = message.media_height;
  const mediaRatio = (mw && mh) ? Math.min(Math.max(mh / mw, 0.5), 2.2) : 0.81;
  const mediaW = mediaBase;
  const mediaH = mediaBase * mediaRatio;

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
    if (m.type === 'IMAGE' || m.type === 'VIDEO' || m.type === 'FILE' || m.type === 'DOCUMENT') {
      onOpenMedia(m);
    }
  };

  const replyRevealStyle = isSent ? styles.revealRight : styles.revealLeft;

  const refMsg = message.reply_to ? replyRef : null;
  const refName = refMsg
    ? (refMsg.sender_id === ownId ? 'You' : (refMsg.sender_name || refMsg.sender_username || otherName || 'Message'))
    : 'Message';

  if (message.type === 'CALL') {
    const missed = (message.content || '').includes('Missed');
    return (
      <View style={styles.callEventRow}>
        <View style={styles.callEventPill}>
          <Icon name="call" size={14} color={missed ? '#E53935' : theme.primary} style={{ transform: [{ rotate: missed ? '135deg' : '0deg' }] }} />
          <Text style={[styles.callEventText, { color: theme.textSecondary }]}>{message.content || 'Video call'}</Text>
        </View>
      </View>
    );
  }

  return (
    <Animated.View ref={entryViewRef} style={[styles.msgRow, { justifyContent: isSent ? 'flex-end' : 'flex-start', opacity: entryOpacity, transform: [{ translateX: entryTranslate }, { scale: entryScale }] }]}>
      <View style={{ maxWidth: '80%', position: 'relative' }}>
        {/* Swipe affordance revealed behind the bubble (reply, or edit for your own text) */}
        <Animated.View style={[styles.swipeReveal, replyRevealStyle, { backgroundColor: isSent ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)', opacity: revealOpacity }]}>
          <Icon name={suggestEdit ? 'create-outline' : 'arrow-back'} size={14} color="#fff" />
        </Animated.View>
        <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
            <TouchableOpacity
              style={[
                styles.bubble,
                isSent ? [styles.sentBubble, { backgroundColor: theme.sentBubble }] : [styles.recvBubble, { backgroundColor: receivedBubble, borderColor: 'rgba(255,255,255,0.07)' }],
                singleEmoji && styles.bubbleEmojiOnly,
                grouped && { borderBottomRightRadius: isSent ? 6 : 14, borderBottomLeftRadius: isSent ? 14 : 6 },
                flash && { backgroundColor: 'rgba(255,255,255,0.08)' },
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
                <View style={styles.mediaBubble}>
                  <Image
                    source={{ uri: absUrl(message.thumb_url || message.media_url) }}
                    style={[styles.mediaImage, { width: mediaW, height: mediaH, backgroundColor: isSent ? 'rgba(255,255,255,0.12)' : theme.primaryLight }]}
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
                      <Text style={{ color: '#fff', fontSize: fs(12), marginTop: 4, fontWeight: '600' }}>
                        Tap to retry
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : message.type === 'VOICE' ? (
                <VoiceMessageBubble
                  message={message}
                  isSent={isSent}
                  theme={theme}
                  voicePlaying={voicePlaying}
                  voiceProgress={voiceProgress}
                  voiceDurationMs={voiceDurationMs}
                  onPlayVoice={onPlayVoice}
                  onRetry={onRetry}
                  avatarUri={voiceAvatarUri}
                  avatarName={voiceAvatarName}
                />
              ) : message.type === 'FILE' || message.type === 'DOCUMENT' ? (
                <View style={[styles.docRow, { backgroundColor: isSent ? 'rgba(255,255,255,0.14)' : theme.primaryLight, borderRadius: 10, padding: 8, flexDirection: 'row', alignItems: 'center', minWidth: 200 }]}>
                  <View style={[styles.docIcon, { backgroundColor: isSent ? 'rgba(255,255,255,0.2)' : theme.primary }]}>
                    <Icon name="document" size={18} color="#fff" />
                  </View>
                  <View style={{ marginLeft: 10, flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: fs(13), fontWeight: '600', color: isSent ? '#fff' : theme.receivedText, maxWidth: 150 }}>
                      {(message.file_name || message.content || 'Document')}
                    </Text>
                    <Text style={{ fontSize: fs(10), color: isSent ? 'rgba(255,255,255,0.7)' : theme.textSecondary, marginTop: 2 }}>
                      {formatBytes(message.media_size || 0) || 'File'}
                    </Text>
                    {message._uploading ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                        <ArcProgress size={30} thickness={3} progress={message._uploadProgress} color={isSent ? '#fff' : theme.primary} track={isSent ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.1)'} />
                        <Text style={{ fontSize: fs(10), marginLeft: 6, color: isSent ? 'rgba(255,255,255,0.85)' : theme.textSecondary, fontWeight: '600' }}>
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
                      <Text style={{ fontSize: fs(10), color: isSent ? 'rgba(255,255,255,0.85)' : theme.danger, marginTop: 2 }}>
                        Upload failed · tap to retry
                      </Text>
                    )}
                  </View>
                </View>
              ) : (
                <View>
                  {singleEmoji ? (
                    <View style={styles.msgEmojiWrap}>
                      {message.reply_to && (
                        <TouchableOpacity
                          activeOpacity={0.65}
                          onPress={() => { if (onJumpToReply) onJumpToReply(message.reply_to); }}
                          style={[styles.replyRef, { backgroundColor: isSent ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)' }]}
                        >
                          <Text numberOfLines={1} style={{ fontWeight: '700', fontSize: fs(11), color: isSent ? '#fff' : '#9C86F5' }}>
                            {refName}
                          </Text>
                          <Text numberOfLines={2} style={{ fontSize: fs(11), color: isSent ? 'rgba(255,255,255,0.8)' : 'rgba(232,234,236,0.85)' }}>
                            {refMsg ? <ColorEmoji>{replyPreview(refMsg)}</ColorEmoji> : '…'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      <EmojiOnlyView size={fs(56)}>
                        {message.content}
                      </EmojiOnlyView>
                    </View>
                  ) : (
                    <View>
                      {message.reply_to && (
                        <TouchableOpacity
                          activeOpacity={0.65}
                          onPress={() => { if (onJumpToReply) onJumpToReply(message.reply_to); }}
                          style={[styles.replyRef, { backgroundColor: isSent ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)' }]}
                        >
                          <Text numberOfLines={1} style={{ fontWeight: '700', fontSize: fs(11), color: isSent ? '#fff' : '#9C86F5' }}>
                            {refName}
                          </Text>
                          <Text numberOfLines={2} style={{ fontSize: fs(11), color: isSent ? 'rgba(255,255,255,0.8)' : 'rgba(232,234,236,0.85)' }}>
                            {refMsg ? <ColorEmoji>{replyPreview(refMsg)}</ColorEmoji> : '…'}
                          </Text>
                        </TouchableOpacity>
                      )}
                      <ColorEmoji
                        style={[
                          styles.msgText,
                          { color: isSent ? '#fff' : theme.receivedText },
                        ]}
                      >
                        {message.content}
                      </ColorEmoji>
                    </View>
                  )}
                </View>
              )}

              {!message.is_deleted_for_everyone && (
                <View style={[
                  styles.msgMeta,
                  singleEmoji && { justifyContent: isSent ? 'flex-end' : 'flex-start' },
                  singleEmoji && styles.msgMetaPill,
                  singleEmoji && { alignSelf: isSent ? 'flex-end' : 'flex-start' },
                ]}>
                  {message.is_view_once && <Icon name="lock-closed" size={10} color={isSent ? '#fff' : theme.textSecondary} />}
                  {message.is_edited && <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.7)' }]}>edited</Text>}
                  <Text style={[styles.metaText, isSent && { color: 'rgba(255,255,255,0.75)' }, singleEmoji && !isSent && { color: 'rgba(255,255,255,0.85)' }]}>
                    {message.created_at ? timeOf(message.created_at) : ''}
                  </Text>
                  {isSent && <Icon name={statusIcon} size={message.status === 'READ' ? 15 : 13} color={statusColor} style={message.status === 'READ' ? styles.readTick : null} />}
                </View>
              )}
            </TouchableOpacity>
          </Animated.View>

        {message.reactions && message.reactions.length > 0 && (
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => onLongPress(message)}
            style={[
              styles.reactionBadge,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            {dedupeReactions(message.reactions).map(({ emoji, count }, i) => (
              <View key={i} style={styles.reactionBadgeItem}>
                <ColorEmoji style={{ fontSize: fs(12) }}>{emoji}</ColorEmoji>
                {count > 1 ? <Text style={[styles.reactionBadgeCount, { color: theme.textSecondary }]}>{count}</Text> : null}
              </View>
            ))}
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

const MessageRow = memo(MessageRowFn);

// Memoized message list: the reply lookup map, per-row renderer and the FlatList
// itself live here so an incoming message (or a keystroke / upload tick in the
// composer) only re-renders the rows whose data actually changed. Row callbacks stay
// referentially stable (read via refs) so memo(MessageRow) skips untouched bubbles.
function MessageListFn({
  messages, ownId, otherUserName, otherUserAvatar, currentUserAvatar, theme, listRef, bottomPad, onScroll, onScrollBeginDrag, onScrollEndDrag, onContentSizeChange, onLayout,
  onOpenMedia, onLongPress, onDoubleTap, onReply, onEditRow, onRetry, onCancelUpload, onPlayVoice,
  playingVoiceId, voiceProgress, voiceDurationMs, entryMap,
}) {
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const replyIndex = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const replyIndexRef = useRef(replyIndex);
  replyIndexRef.current = replyIndex;

  const normCache = useRef(new WeakMap());
  const getNorm = (item) => {
    if (item && typeof item === 'object') {
      const hit = normCache.current.get(item);
      if (hit) return hit;
      const n = normalizeMessage(item);
      normCache.current.set(item, n);
      return n;
    }
    return normalizeMessage(item);
  };

  const [highlightId, setHighlightId] = useState(null);
  const highlightTimer = useRef(null);

  // Tap on a reply preview → jump to the exact original message (non-animated),
  // temporarily highlight it, and never crash if it's deleted/not loaded.
  const jumpToMessage = useCallback((id) => {
    if (id == null) return;
    const idx = messagesRef.current.findIndex((m) => m.id === id);
    if (idx < 0) return;
    setHighlightId(id);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1800);
    try {
      listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.3, animated: false });
    } catch (e) {
      // On Android, scrollToIndex can throw before rows are measured; the
      // onScrollToIndexFailed fallback on the FlatList retries safely.
    }
  }, [listRef]);

  const onScrollToIndexFailed = useCallback(({ index }) => {
    if (!messagesRef.current.length) return;
    try {
      listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: false });
    } catch (e) {
      // Still not measured — estimate a non-animated offset; safe even if imprecise.
      listRef.current?.scrollToOffset({ offset: Math.max(0, index * 64 - 30), animated: false });
    }
  }, [listRef]);

  const renderMessage = useCallback(({ item, index }) => {
    const safe = getNorm(item);
    const isSent = safe.sender_id === ownId;
    const prev = index > 0 ? messagesRef.current[index - 1] : null;
    const grouped = !!prev && (prev.sender_id || 0) === safe.sender_id && !!prev.type && prev.type === safe.type;
    const replyRef = safe.reply_to ? (replyIndexRef.current.get(safe.reply_to) || null) : null;
    const entry = entryMap.get(String(safe.id)) || { key: String(safe.id), animate: false };
    return (
      <RowBoundary isSent={isSent} rowKey={entry.key}>
        <MessageRow
          message={safe}
          isSent={isSent}
          grouped={grouped}
          theme={theme}
          receivedBubble={INCOMING_MESSAGE_COLOR}
          flash={highlightId === safe.id}
          ownId={ownId}
          otherName={otherUserName}
          voiceAvatarUri={isSent ? currentUserAvatar : otherUserAvatar}
          voiceAvatarName={isSent ? 'You' : otherUserName}
          replyRef={replyRef}
          onLongPress={onLongPress}
          onOpenMedia={onOpenMedia}
          onRetry={onRetry}
          onReply={onReply}
          onDoubleTap={onDoubleTap}
          onJumpToReply={jumpToMessage}
          suggestEdit={isSent && safe.type === 'TEXT' && !!safe.content && !safe._pending}
          onEditRow={onEditRow}
          onCancelUpload={onCancelUpload}
          voicePlaying={playingVoiceId === safe.id}
          voiceProgress={playingVoiceId === safe.id ? voiceProgress : 0}
          voiceDurationMs={playingVoiceId === safe.id ? voiceDurationMs : 0}
          onPlayVoice={onPlayVoice}
          animateEntry={entry.animate}
          rowKey={entry.key}
        />
      </RowBoundary>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ownId, otherUserName, otherUserAvatar, currentUserAvatar, onLongPress, onOpenMedia, onDoubleTap, onReply, onEditRow, onRetry, onCancelUpload, onPlayVoice, jumpToMessage, highlightId, playingVoiceId, voiceProgress, voiceDurationMs, entryMap]);

  return (
    <FlatList
      ref={listRef}
      data={messages}
      keyExtractor={(item, idx) => (entryMap.get(String(item.id)) || {}).key || String(item.id || `tmp-${idx}`)}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollEndDrag={onScrollEndDrag}
      onScrollToIndexFailed={onScrollToIndexFailed}
      scrollEventThrottle={16}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
      initialNumToRender={15}
      maxToRenderPerBatch={12}
      updateCellsBatchingPeriod={25}
      windowSize={15}
      removeClippedSubviews={Platform.OS === 'android'}
      renderItem={renderMessage}
      contentContainerStyle={[styles.messageList, { paddingBottom: bottomPad }]}
      style={{ flex: 1, backgroundColor: 'transparent' }}
      onLayout={onLayout}
    />
  );
}

const MessageList = memo(MessageListFn);

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
  if (isNaN(d.getTime())) return '';
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Voice durations as m:ss (rolls over at 60s instead of showing "0:61").
function fmtDur(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// True when a TEXT message consists of emoji ONLY (one or more grapheme clusters)
// -> WhatsApp-style large "emoji-only" rendering, no bubble. ZWJ families, skin
// tones, flags and keycaps are kept intact as single clusters (never split by
// code point). Text+emoji or anything with letters/digits -> normal bubble.
// Hermes-safe: no \p{...} property escapes; reuses the ColorEmoji run parser.
function isSingleEmoji(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  let emojiClusters = 0;
  let textChars = 0;
  for (const r of emojiRuns(t)) {
    if (r.emoji) {
      emojiClusters += splitEmoji(r.text).length;
    } else {
      if (/[A-Za-z0-9]/.test(r.text)) return false;
      textChars += Array.from(r.text).length;
    }
  }
  return emojiClusters > 0 && textChars === 0;
}

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string') return hex;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Lighten a hex color toward white (used for the selection highlight tint).
function mixWhite(hex, amt) {
  if (!hex || typeof hex !== 'string') return hex;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16);
  const m = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${m((n >> 16) & 255)}, ${m((n >> 8) & 255)}, ${m(n & 255)})`;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: fs(12), paddingVertical: fs(9),
    borderBottomWidth: 1, zIndex: 30, elevation: 5,
  },
  backBtn: { marginRight: fs(6) },
  avatarSmall: { width: fs(40), height: fs(40), borderRadius: fs(20), alignItems: 'center', justifyContent: 'center', marginRight: fs(10), overflow: 'hidden' },
  avatarSmallText: { color: '#fff', fontSize: fs(16), fontWeight: '700' },
  avatarImg: { width: '100%', height: '100%' },
  headerName: { fontSize: fs(16), fontWeight: '700' },
  headerStatus: { fontSize: fs(12), marginLeft: 4 },
  messageList: { padding: fs(14) },
  msgArea: { flex: 1, overflow: 'hidden' },
  callStrip: {
    height: Math.min(Math.round(APP_H * 0.42), 320),
    zIndex: 40,
    elevation: 20,
    backgroundColor: '#101418',
  },
  callOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 45,
    elevation: 30,
    backgroundColor: '#101418',
  },
  msgRow: { flexDirection: 'row', marginVertical: 3 },
  callEventRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginVertical: 4, paddingHorizontal: 8 },
  callEventPill: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    backgroundColor: 'rgba(128,128,128,0.12)', paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 14, maxWidth: '88%',
  },
  callEventText: { fontSize: fs(12.5), fontWeight: '600', marginLeft: 6, textAlign: 'center' },
  bubble: { paddingHorizontal: fs(12), paddingVertical: fs(8), borderRadius: fs(14) },
  // Emoji-only bubbles are transparent + zero padding: the large emoji text carries
  // its own line box so nothing clips. Never recolor/tint/opacity the glyphs.
  bubbleEmojiOnly: { backgroundColor: 'transparent', borderWidth: 0, padding: 0 },
  sentBubble: { borderBottomRightRadius: 4 },
  recvBubble: { borderBottomLeftRadius: 4, borderWidth: 1 },
  msgText: { fontSize: fs(15), lineHeight: fs(21), includeFontPadding: true },
  msgEmojiWrap: { paddingTop: 2, paddingBottom: 4 },
  msgEmoji: { fontSize: fs(40), lineHeight: fs(50), includeFontPadding: true, paddingHorizontal: fs(10), paddingVertical: 4 },
  msgEmojiSingle: { fontSize: fs(40), lineHeight: fs(50), includeFontPadding: true, paddingHorizontal: 2, paddingTop: 2, paddingBottom: 4 },
  // Media thumbs/video keep overflow clipping (rounded corners + overlay fit);
  // this is the ONLY place clipping is allowed.
  mediaBubble: { overflow: 'hidden', borderRadius: 12 },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 3 },
  // Bold, always-legible blue read tick: bright cyan + a soft dark halo so it
  // stands out on every chat colour (incl. bright coral/orange/pink bubbles).
  readTick: { textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 1, textShadowOffset: { width: 0, height: 0 }, fontWeight: '700' },
  msgMetaPill: { backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: fs(10), paddingHorizontal: fs(7), paddingVertical: 2 },
  metaText: { fontSize: fs(10), color: '#9B96A8' },
  replyRef: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3, marginBottom: 4, marginLeft: -2, borderLeftWidth: 3, borderLeftColor: '#6C3CE9' },
  reactionBadge: { alignSelf: 'flex-end', marginTop: -8, borderRadius: fs(12), paddingHorizontal: fs(8), paddingVertical: 3, flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, zIndex: 5, elevation: 3, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
  reactionBadgeItem: { flexDirection: 'row', alignItems: 'center' },
  reactionBadgeCount: { fontSize: fs(10), marginLeft: 2 },
  headerIconBtn: { width: fs(40), height: fs(40), alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  headerMenuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 25, justifyContent: 'flex-start' },
  headerMenu: { alignSelf: 'flex-end', marginTop: fs(62), marginRight: 8, borderRadius: fs(14), minWidth: fs(200), paddingVertical: 6, borderWidth: StyleSheet.hairlineWidth, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 10 },
  headerMenuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: fs(16), paddingVertical: fs(12) },
  jumpLatest: { position: 'absolute', right: fs(14), width: fs(44), height: fs(44), borderRadius: fs(22), alignItems: 'center', justifyContent: 'center', zIndex: 18, elevation: 8, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
  jumpBadge: { position: 'absolute', top: -4, right: -4, minWidth: fs(20), height: fs(20), borderRadius: fs(10), backgroundColor: '#E53935', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: '#fff' },
  jumpBadgeText: { color: '#fff', fontSize: fs(10), fontWeight: '700' },
  composer: { borderTopWidth: 1, padding: fs(10), paddingBottom: Platform.OS === 'ios' ? fs(20) : fs(12) },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: fs(6) },
  composerBtn: { width: fs(40), height: fs(40), borderRadius: fs(20), alignItems: 'center', justifyContent: 'center' },
  emojiPickBtn: { width: fs(44), height: fs(44), borderRadius: fs(12), alignItems: 'center', justifyContent: 'center' },
  attachBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: fs(16), paddingVertical: fs(14), borderTopWidth: 1 },
  attachBtn: { alignItems: 'center', marginRight: fs(20) },
  attachIcon: { width: fs(52), height: fs(52), borderRadius: fs(16), alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: fs(12), marginTop: 6 },
  inputWrap: { flex: 1, borderRadius: fs(22), paddingHorizontal: fs(12), maxHeight: 100, justifyContent: 'center' },
  input: { fontSize: fs(14), paddingVertical: 8, maxHeight: 100 },
  sendBtn: { width: fs(42), height: fs(42), borderRadius: fs(21), alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#6C3CE9', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  micBtn: { width: fs(42), height: fs(42), borderRadius: fs(21), alignItems: 'center', justifyContent: 'center', elevation: 4, shadowColor: '#6C3CE9', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  micBtnRec: { width: fs(46), height: fs(46), borderRadius: fs(23), alignItems: 'center', justifyContent: 'center', elevation: 5, shadowColor: '#E53935', shadowOpacity: 0.35, shadowRadius: 7, shadowOffset: { width: 0, height: 3 } },
  recBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: fs(14), paddingVertical: fs(10), borderTopWidth: 1 },
  recCancel: { width: fs(38), height: fs(38), borderRadius: fs(19), backgroundColor: 'rgba(229,57,53,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  recSend: { width: fs(38), height: fs(38), borderRadius: fs(19), alignItems: 'center', justifyContent: 'center' },
  recPill: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: fs(12), paddingVertical: fs(8), marginHorizontal: 8 },
  recDot: { width: 8, height: 8, borderRadius: 4 },
  recTime: { fontSize: fs(13), fontWeight: '700', marginLeft: 6, fontVariant: ['tabular-nums'] },
  recWaveWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: fs(26), marginLeft: 8, gap: 2 },
  recWaveBar: { width: fs(2.5), borderRadius: fs(1.5) },
  recPause: { width: fs(34), height: fs(34), borderRadius: fs(17), alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  replyBar: { flexDirection: 'row', alignItems: 'center', padding: fs(10), borderTopWidth: 1 },
  replyLine: { width: 3, height: fs(32), borderRadius: 2, marginRight: fs(10) },
  replyTitle: { fontWeight: '700', fontSize: fs(12) },
  replyPreview: { fontSize: fs(12) },
  menuOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  menuBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  reactionPop: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: fs(28),
    paddingHorizontal: 7,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  reactionPopBtn: { width: fs(38), height: fs(42), alignItems: 'center', justifyContent: 'center', borderRadius: fs(21) },
  reactionPopCaret: {
    position: 'absolute',
    bottom: -6,
    width: 12,
    height: 12,
    transform: [{ rotate: '45deg' }],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menu: { position: 'absolute', bottom: 90, left: 24, right: 24, borderRadius: 18, padding: fs(14), shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 8 },
  menuTitle: { fontSize: fs(13), fontWeight: '700' },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10, marginVertical: fs(12) },
  reactionBtn: { borderRadius: fs(14), width: fs(48), height: fs(44), alignItems: 'center', justifyContent: 'center' },
  mediaImage: { width: Math.min(APP_W * 0.62, 250), height: Math.min(APP_W * 0.62, 250) * 0.81, borderRadius: 12, marginBottom: 4 },
  uploadOverlay: { alignItems: 'center', justifyContent: 'center', padding: 8, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.35)' },
  uploadCancel: { width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  
  videoPlayWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 6, alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: fs(48), height: fs(48), borderRadius: fs(24), alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  mediaError: { alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginBottom: 4 },
  voicePlay: { width: fs(34), height: fs(34), borderRadius: fs(17), alignItems: 'center', justifyContent: 'center' },
  voiceBubble: { width: fs(236), maxWidth: '100%', minHeight: fs(58), justifyContent: 'center' },
  voiceAvatar: { width: fs(26), height: fs(26), borderRadius: fs(13), alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginRight: 6 },
  voiceAvatarImg: { width: '100%', height: '100%' },
  voiceAvatarText: { color: '#fff', fontSize: fs(11), fontWeight: '700' },
  voiceWaveWrap: { flex: 1 },
  voiceWaveRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: fs(22), gap: 2 },
  voiceBar: { width: fs(2.5), borderRadius: fs(1.5) },
  voiceTrack: { height: 2, borderRadius: 1, overflow: 'hidden', marginTop: 4 },
  voiceTime: { fontSize: fs(10), marginTop: 3, fontVariant: ['tabular-nums'] },
  voiceUploadRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  voiceUploadText: { fontSize: fs(10), marginLeft: 6, fontWeight: '600' },
  docIcon: { width: fs(36), height: fs(36), borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  swipeReveal: { position: 'absolute', top: fs(6), width: fs(28), height: fs(28), borderRadius: fs(14), alignItems: 'center', justifyContent: 'center', zIndex: 0 },
  revealLeft: { left: 2 },
  revealRight: { right: 2 },
});