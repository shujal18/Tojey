import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from './ChatContext';

const WatchTogetherContext = createContext();

// Shared "Watch Together" room between the app's two users (Tom & Jerry). The
// server is authoritative: every playback change is validated there and echoed
// back as a stamped room state, so both devices converge without relaying any
// video bytes. This provider owns the socket wiring and the player controller
// hand-off; the UI (menus, banner, in-player controls) lives in the screens.

export function WatchTogetherProvider({ socket, currentUser, children }) {
  const { users, presence, showToast } = useChat();
  const [invite, setInvite] = useState(null); // incoming
  const [outgoing, setOutgoing] = useState(null); // invite we sent
  const [room, setRoom] = useState(null); // authoritative room state
  const [partnerLeft, setPartnerLeft] = useState(null); // {by, reason}
  const [notice, setNotice] = useState('');
  const [messages, setMessages] = useState([]); // in-room chat history
  const [bubble, setBubble] = useState(null); // latest reaction/message toast
  const bubbleTimerRef = useRef(null);
  useEffect(() => () => { if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current); }, []);

  const socketRef = useRef(socket);
  socketRef.current = socket;
  const roomRef = useRef(null);
  roomRef.current = room;
  const controllerRef = useRef(null);
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  const partner = (() => {
    if (!currentUser || !Array.isArray(users)) return null;
    const other = users.find((u) => String(u.id) !== String(currentUser.id));
    if (!other) return null;
    const live = presence[other.id];
    return {
      id: other.id,
      username: other.username,
      displayName: other.display_name || other.displayName || other.username,
      isOnline: live ? !!live.isOnline : !!other.is_online,
    };
  })();
  const partnerRef = useRef(partner);
  partnerRef.current = partner;

  // Server state -> local player. Elapsed time is measured from when THIS client
  // received the state (not the server's clock), so device clock skew can never
  // turn into constant seeking. Small drift is corrected by nudging the playback
  // rate; only large drift triggers a real seek.
  const applyState = useCallback((raw) => {
    const c = controllerRef.current;
    if (!c || !c.isReady || !c.isReady()) return;
    const st = raw || {};
    const recvAt = Number.isFinite(st._recvAt) ? st._recvAt : Date.now();
    const expected = (Number(st.position) || 0) + (st.playing ? Math.max(0, (Date.now() - recvAt) / 1000) : 0);
    const drift = (c.getTime() || 0) - expected;
    if (Math.abs(drift) > 2.0) {
      c.seek(expected);
      if (c.setRate) c.setRate(1);
    } else if (st.playing && Math.abs(drift) > 0.5 && c.setRate) {
      c.setRate(drift > 0 ? 0.95 : 1.05);
    } else if (c.setRate) {
      c.setRate(1);
    }
    if (st.playing && c.isPaused()) c.play();
    else if (!st.playing && !c.isPaused()) c.pause();
  }, []);

  const showBubble = useCallback((b) => {
    if (!b) return;
    setBubble(b);
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setBubble(null), b.kind === 'reaction' ? 2800 : 4800);
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const sk = socket;

    const onInviteNew = (payload) => {
      if (!payload || !payload.inviteId) return;
      setInvite(payload);
    };
    const onInviteDeclined = ({ by }) => {
      setOutgoing(null);
      showToast(`${(by && by.displayName) || 'They'} declined the invitation.`);
    };
    const onInviteCancelled = ({ reason }) => {
      setInvite(null);
      setOutgoing(null);
      if (reason === 'expired') showToast('Watch invitation expired.');
      else if (reason === 'offline') showToast('The other person went offline.');
    };
    const onRoomState = (st) => {
      if (!st || !st.roomId) return;
      const stamped = { ...st, _recvAt: Date.now() };
      setRoom(stamped);
      setMessages(Array.isArray(st.messages) ? st.messages : []);
      setPartnerLeft(null);
      setInvite(null);
      setOutgoing((prev) => (prev ? null : prev));
      applyState(stamped);
    };
    const onState = (st) => {
      if (!st || !st.roomId) return;
      const stamped = { ...st, _recvAt: Date.now() };
      setRoom((prev) => (prev && prev.roomId === stamped.roomId ? { ...prev, ...stamped } : prev));
      applyState(stamped);
    };
    const onPartnerStatus = ({ online }) => {
      setRoom((prev) => (prev ? { ...prev, partnerOnline: online } : prev));
    };
    const onReaction = (payload) => {
      if (!payload || !payload.emoji) return;
      showBubble({
        id: `${payload.at || Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: 'reaction',
        emoji: payload.emoji,
        by: payload.by || null,
      });
    };
    const onMessage = (payload) => {
      if (!payload || !payload.text) return;
      const msg = { id: payload.id || `${payload.at}-${Math.random()}`, text: payload.text, by: payload.by || null, at: payload.at || Date.now() };
      setMessages((prev) => [...prev, msg].slice(-40));
      showBubble({ ...msg, kind: 'message' });
    };
    const onPartnerLeft = (payload) => {
      const c = controllerRef.current;
      if (c && c.isReady && c.isReady() && !c.isEmbed && !c.isPaused()) c.pause();
      setRoom(null);
      controllerRef.current = null;
      setPartnerLeft(payload || {});
      setNotice('');
      setMessages([]);
      setBubble(null);
    };

    sk.on('wt:invite:new', onInviteNew);
    sk.on('wt:invite:declined', onInviteDeclined);
    sk.on('wt:invite:cancelled', onInviteCancelled);
    sk.on('wt:room:state', onRoomState);
    sk.on('wt:state', onState);
    sk.on('wt:partner:status', onPartnerStatus);
    sk.on('wt:room:partner-left', onPartnerLeft);
    sk.on('wt:reaction', onReaction);
    sk.on('wt:message', onMessage);

    return () => {
      sk.off('wt:invite:new', onInviteNew);
      sk.off('wt:invite:declined', onInviteDeclined);
      sk.off('wt:invite:cancelled', onInviteCancelled);
      sk.off('wt:room:state', onRoomState);
      sk.off('wt:state', onState);
      sk.off('wt:partner:status', onPartnerStatus);
      sk.off('wt:room:partner-left', onPartnerLeft);
      sk.off('wt:reaction', onReaction);
      sk.off('wt:message', onMessage);
    };
  }, [socket, applyState, showToast, showBubble]);

  // Reconnect: rejoin the room we were in so playback (and pauses elsewhere)
  // survive a network blip or a backgrounded tab.
  useEffect(() => {
    if (!socket) return undefined;
    const onConnect = () => {
      const r = roomRef.current;
      if (!r || !r.roomId) return;
      socket.emit('wt:join', { roomId: r.roomId }, (res) => {
        if (res && res.ok && res.state) {
          const stamped = { ...res.state, _recvAt: Date.now() };
          setRoom(stamped);
          applyState(stamped);
        } else {
          setRoom(null);
          controllerRef.current = null;
        }
      });
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [socket, applyState]);

  // Periodic drift correction while a room is open.
  useEffect(() => {
    if (!room || !room.roomId) return undefined;
    const iv = setInterval(() => {
      const r = roomRef.current;
      if (r) applyState(r);
    }, 3000);
    return () => clearInterval(iv);
  }, [room && room.roomId, applyState]);

  const isHost = !!(room && currentUser && room.host && String(room.host) === String(currentUser.username));

  // When playback runs through the YouTube embed the host's play/pause/seek
  // happen inside a cross-origin iframe that cannot emit DOM events. Poll the
  // embed controller and mirror real changes to the authoritative room state so
  // the guest follows. Only the host polls; guests never write playback state.
  const lastHostSyncRef = useRef({ playing: false, time: 0, at: 0, suppressUntil: 0 });
  useEffect(() => {
    if (!room || !room.roomId || !isHost) return undefined;
    lastHostSyncRef.current = { playing: false, time: 0, at: 0, suppressUntil: 0 };
    const tick = () => {
      const c = controllerRef.current;
      if (!c || !c.isEmbed || !c.isReady || !c.isReady()) return;
      if (Date.now() < lastHostSyncRef.current.suppressUntil) return;
      const sk = socketRef.current;
      const r = roomRef.current;
      if (!sk || !r) return;
      const now = Date.now();
      const time = Number(c.getTime()) || 0;
      const paused = c.isPaused();
      const last = lastHostSyncRef.current;
      if (!last.at) {
        last.playing = !paused;
        last.time = time;
        last.at = now;
        return;
      }
      const expected = last.playing ? last.time + (now - last.at) / 1000 : last.time;
      let action = null;
      if (paused !== !last.playing) {
        action = paused ? 'pause' : 'play';
      } else if (!paused && Math.abs(time - expected) > 1.5) {
        action = 'seek';
      }
      if (!action) return;
      last.playing = !paused;
      last.time = time;
      last.at = now;
      last.suppressUntil = now + 700;
      sk.emit(action === 'seek' ? 'wt:seek' : action === 'pause' ? 'wt:pause' : 'wt:play', { roomId: r.roomId, position: time });
    };
    const iv = setInterval(tick, 600);
    return () => clearInterval(iv);
  }, [room && room.roomId, isHost]);

  const sendReaction = useCallback((emoji) => {
    const sk = socketRef.current;
    const r = roomRef.current;
    if (!sk || !r || !emoji) return;
    sk.emit('wt:reaction', { roomId: r.roomId, emoji });
  }, []);

  const sendMessage = useCallback((text) => {
    const sk = socketRef.current;
    const r = roomRef.current;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!sk || !r || !clean) return;
    sk.emit('wt:message', { roomId: r.roomId, text: clean });
  }, []);

  const sendInvite = useCallback(({ videoId, title }) => {
    const sk = socketRef.current;
    const p = partnerRef.current;
    if (!sk) return Promise.resolve({ ok: false, error: 'Not connected.' });
    if (!p || !p.isOnline) {
      showToast(`${p ? p.displayName : 'The other person'} is offline.`);
      return Promise.resolve({ ok: false, error: 'offline' });
    }
    return new Promise((resolve) => {
      sk.emit('wt:invite', { videoId, title }, (res) => {
        if (res && res.ok) {
          setOutgoing({ inviteId: res.inviteId, toName: p.displayName, videoId, title });
        } else if (res && res.error) {
          showToast(res.error);
        }
        resolve(res || { ok: false });
      });
    });
  }, [showToast]);

  const respondInvite = useCallback((accept) => {
    const sk = socketRef.current;
    const inv = invite;
    if (!sk || !inv) return;
    setInvite(null);
    sk.emit('wt:invite:respond', { inviteId: inv.inviteId, accept }, (res) => {
      if (res && !res.ok && res.error) showToast(res.error);
    });
  }, [invite, showToast]);

  const leaveRoom = useCallback(() => {
    const sk = socketRef.current;
    const r = roomRef.current;
    if (sk && r) sk.emit('wt:leave', { roomId: r.roomId });
    setRoom(null);
    controllerRef.current = null;
    setPartnerLeft(null);
    setMessages([]);
    setBubble(null);
  }, []);

  const registerController = useCallback((controller) => {
    controllerRef.current = controller;
  }, []);

  // Local (user gesture) playback changes -> authoritative server.
  const reportLocal = useCallback((action, position) => {
    const sk = socketRef.current;
    const r = roomRef.current;
    if (!sk || !r) return;
    const me = currentUserRef.current;
    if (!me || String(r.host) !== String(me.username)) return;
    const pos = Number.isFinite(position) ? position : 0;
    if (action === 'play') sk.emit('wt:play', { roomId: r.roomId, position: pos });
    else if (action === 'pause') sk.emit('wt:pause', { roomId: r.roomId, position: pos });
    else if (action === 'seek') sk.emit('wt:seek', { roomId: r.roomId, position: pos });
  }, []);

  const resetPartnerLeft = useCallback(() => setPartnerLeft(null), []);

  const value = {
    invite,
    outgoing,
    room,
    partner,
    partnerLeft,
    notice,
    setNotice,
    isHost,
    messages,
    bubble,
    sendReaction,
    sendMessage,
    sendInvite,
    respondInvite,
    leaveRoom,
    registerController,
    reportLocal,
    resetPartnerLeft,
  };

  return <WatchTogetherContext.Provider value={value}>{children}</WatchTogetherContext.Provider>;
}

export function useWatchTogether() {
  return useContext(WatchTogetherContext);
}
