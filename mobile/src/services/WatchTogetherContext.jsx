import React, {
  createContext, useContext, useState, useEffect, useRef, useCallback,
} from 'react';
import { fetchUsers } from './auth';

// Mobile port of the web Watch Together room. The server is authoritative: it
// validates every playback change and echoes a stamped room state, so both
// devices converge without exchanging any video bytes. This provider owns the
// socket wiring and the player-controller hand-off; the UI lives in the player
// modal and the global invite banner.
const WatchTogetherContext = createContext(null);

const EMPTY = {
  invite: null,
  outgoing: null,
  room: null,
  partner: null,
  partnerLeft: null,
  notice: '',
  isHost: false,
  messages: [],
  bubble: null,
  sendReaction: () => {},
  sendMessage: () => {},
  sendInvite: () => Promise.resolve({ ok: false }),
  respondInvite: () => {},
  leaveRoom: () => {},
  registerController: () => {},
  reportLocal: () => {},
  resetPartnerLeft: () => {},
};

export function WatchTogetherProvider({ socket, currentUser, children }) {
  const [invite, setInvite] = useState(null);
  const [outgoing, setOutgoing] = useState(null);
  const [room, setRoom] = useState(null);
  const [partner, setPartner] = useState(null);
  const [partnerLeft, setPartnerLeft] = useState(null);
  const [notice, setNotice] = useState('');
  const [messages, setMessages] = useState([]);
  const [bubble, setBubble] = useState(null);

  const bubbleTimerRef = useRef(null);
  const partnerLeftTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const socketRef = useRef(socket);
  socketRef.current = socket;
  const roomRef = useRef(null);
  roomRef.current = room;
  const controllerRef = useRef(null);
  const currentUserRef = useRef(currentUser);
  currentUserRef.current = currentUser;

  const currentUserId = currentUser && currentUser.id;
  const currentUsername = currentUser && currentUser.username;

  // The app has the same two accounts as the web app, so the partner is simply
  // the other row returned by /api/users. Presence on the invite itself is
  // enforced by the server; this is only used for names / status text.
  useEffect(() => {
    let alive = true;
    if (!currentUserId) return undefined;
    fetchUsers()
      .then((rows) => {
        if (!alive || !Array.isArray(rows)) return;
        const other = rows.find((u) => String(u.id) !== String(currentUserId));
        if (other) {
          setPartner({
            id: other.id,
            username: other.username,
            displayName: other.display_name || other.displayName || other.username,
            isOnline: !!(other.is_online ?? other.online),
          });
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [currentUserId]);

  const clearPartnerLeft = useCallback(() => {
    if (partnerLeftTimerRef.current) {
      clearTimeout(partnerLeftTimerRef.current);
      partnerLeftTimerRef.current = null;
    }
    setPartnerLeft(null);
  }, []);

  const showToast = useCallback((msg) => {
    if (!msg) return;
    setNotice(String(msg));
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(''), 2800);
  }, []);

  const showBubble = useCallback((b) => {
    if (!b) return;
    setBubble(b);
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setBubble(null), b.kind === 'reaction' ? 2800 : 4800);
  }, []);

  useEffect(() => () => {
    if (bubbleTimerRef.current) clearTimeout(bubbleTimerRef.current);
    if (partnerLeftTimerRef.current) clearTimeout(partnerLeftTimerRef.current);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  // Server state -> local player. Elapsed time is measured from when THIS client
  // received the state, so device clock skew cannot turn into constant seeking.
  // Small drift is corrected by nudging the playback rate; large drift seeks.
  const applyState = useCallback((raw) => {
    const c = controllerRef.current;
    if (!c || !c.isReady || !c.isReady()) return;
    const st = raw || {};
    const recvAt = Number.isFinite(st._recvAt) ? st._recvAt : Date.now();
    const expected = (Number(st.position) || 0)
      + (st.playing ? Math.max(0, (Date.now() - recvAt) / 1000) : 0);
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

  useEffect(() => {
    if (!socket) return undefined;
    const sk = socket;

    const stampRoom = (st) => {
      const members = Array.isArray(st.members) ? st.members : [];
      const other = members.find((m) => String(m.username) !== String(currentUsername));
      return {
        ...st,
        partnerOnline: other ? other.online !== false : st.partnerOnline,
        _recvAt: Date.now(),
      };
    };

    const onInviteNew = (payload) => {
      if (!payload || !payload.inviteId) return;
      setInvite(payload);
    };
    const onInviteDeclined = ({ by } = {}) => {
      setOutgoing(null);
      showToast(`${(by && by.displayName) || 'They'} declined the invitation.`);
    };
    const onInviteCancelled = ({ reason } = {}) => {
      setInvite(null);
      setOutgoing(null);
      if (reason === 'expired') showToast('Watch invitation expired.');
      else if (reason === 'offline') showToast('The other person went offline.');
    };
    const onRoomState = (st) => {
      if (!st || !st.roomId) return;
      clearPartnerLeft();
      const stamped = stampRoom(st);
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
    const onPartnerStatus = ({ online } = {}) => {
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
      const msg = {
        id: payload.id || `${payload.at}-${Math.random()}`,
        text: payload.text,
        by: payload.by || null,
        at: payload.at || Date.now(),
      };
      setMessages((prev) => [...prev, msg].slice(-40));
      showBubble({ ...msg, kind: 'message' });
    };
    const onPartnerLeft = (payload) => {
      const c = controllerRef.current;
      if (c && c.isReady && c.isReady() && !c.isPaused()) c.pause();
      setRoom(null);
      if (partnerLeftTimerRef.current) {
        clearTimeout(partnerLeftTimerRef.current);
        partnerLeftTimerRef.current = null;
      }
      setPartnerLeft(payload || {});
      setMessages([]);
      setBubble(null);
      partnerLeftTimerRef.current = setTimeout(() => {
        partnerLeftTimerRef.current = null;
        setPartnerLeft(null);
      }, 6000);
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
  }, [socket, currentUsername, applyState, showToast, showBubble, clearPartnerLeft]);

  // Reconnect: rejoin the room we were in so playback survives a network blip
  // or the app being backgrounded.
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
        }
      });
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [socket, applyState]);

  // Periodic drift correction while a room is open.
  const roomId = room && room.roomId;
  useEffect(() => {
    if (!roomId) return undefined;
    const iv = setInterval(() => {
      const r = roomRef.current;
      if (r) applyState(r);
    }, 3000);
    return () => clearInterval(iv);
  }, [roomId, applyState]);

  const isHost = !!(
    room && currentUser && room.host
    && String(room.host) === String(currentUser.username)
  );

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

  const sendInvite = useCallback(({ videoId, title } = {}) => {
    const sk = socketRef.current;
    if (!sk) return Promise.resolve({ ok: false, error: 'Not connected.' });
    return new Promise((resolve) => {
      sk.emit('wt:invite', { videoId, title }, (res) => {
        if (res && res.ok) {
          setOutgoing({
            inviteId: res.inviteId,
            toName: (partner && partner.displayName) || 'Friend',
            videoId,
            title,
          });
        } else if (res && res.error) {
          showToast(res.error);
        }
        resolve(res || { ok: false });
      });
    });
  }, [partner, showToast]);

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
    clearPartnerLeft();
    if (sk && r) sk.emit('wt:leave', { roomId: r.roomId });
    setRoom(null);
    setPartnerLeft(null);
    setMessages([]);
    setBubble(null);
  }, [clearPartnerLeft]);

  const registerController = useCallback((controller) => {
    controllerRef.current = controller;
    // A room may already be active when the player finishes loading; apply the
    // authoritative state immediately instead of waiting for the drift tick.
    if (controller && roomRef.current) applyState(roomRef.current);
  }, [applyState]);

  // Local (user gesture) playback changes -> authoritative server. Guests are
  // rejected server-side; the early return avoids pointless emits.
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

  const resetPartnerLeft = useCallback(() => clearPartnerLeft(), [clearPartnerLeft]);

  const value = {
    invite,
    outgoing,
    room,
    partner,
    partnerLeft,
    notice,
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

  return (
    <WatchTogetherContext.Provider value={value}>
      {children}
    </WatchTogetherContext.Provider>
  );
}

export function useWatchTogether() {
  return useContext(WatchTogetherContext) || EMPTY;
}
