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
    if (!c || !c.isReady || !c.isReady() || c.isEmbed) return;
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
    const onPartnerLeft = (payload) => {
      const c = controllerRef.current;
      if (c && c.isReady && c.isReady() && !c.isEmbed && !c.isPaused()) c.pause();
      setRoom(null);
      controllerRef.current = null;
      setPartnerLeft(payload || {});
      setNotice('');
    };

    sk.on('wt:invite:new', onInviteNew);
    sk.on('wt:invite:declined', onInviteDeclined);
    sk.on('wt:invite:cancelled', onInviteCancelled);
    sk.on('wt:room:state', onRoomState);
    sk.on('wt:state', onState);
    sk.on('wt:partner:status', onPartnerStatus);
    sk.on('wt:room:partner-left', onPartnerLeft);

    return () => {
      sk.off('wt:invite:new', onInviteNew);
      sk.off('wt:invite:declined', onInviteDeclined);
      sk.off('wt:invite:cancelled', onInviteCancelled);
      sk.off('wt:room:state', onRoomState);
      sk.off('wt:state', onState);
      sk.off('wt:partner:status', onPartnerStatus);
      sk.off('wt:room:partner-left', onPartnerLeft);
    };
  }, [socket, applyState, showToast]);

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
  }, []);

  const registerController = useCallback((controller) => {
    controllerRef.current = controller;
  }, []);

  // Local (user gesture) playback changes -> authoritative server.
  const reportLocal = useCallback((action, position) => {
    const sk = socketRef.current;
    const r = roomRef.current;
    if (!sk || !r) return;
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
