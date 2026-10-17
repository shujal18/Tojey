'use strict';

// Watch Together - server-authoritative shared rooms between the app's two
// existing users (Tom and Jerry). Everything lives in memory: single-instance
// (same constraint as the rest of the socket layer - see render.yaml), and no
// video bytes ever touch the database - members only exchange room state, so
// each device keeps playing through its own provider (native/DASH/embed).
//
// Event contract (client -> server, all acked with { ok, error? }):
//   wt:invite              { videoId, title }
//   wt:invite:respond      { inviteId, accept }
//   wt:join                { roomId }                      (reconnect path)
//   wt:play / wt:pause / wt:seek  { roomId, position }
//   wt:leave               { roomId }
// Event contract (server -> client):
//   wt:invite:new          { inviteId, videoId, title, from }
//   wt:invite:declined     { inviteId, by }
//   wt:invite:cancelled    { inviteId, reason }
//   wt:room:state          { ...room, partner, you }        (authoritative, per socket)
//   wt:state               { roomId, playing, position, seq, serverNow, by }
//   wt:partner:status      { roomId, partner, online }
//   wt:room:partner-left   { roomId, by, reason, videoId, title }

const { USERS } = require('./auth');

const INVITE_TTL_MS = 60 * 1000;
const DISCONNECT_GRACE_MS = 20 * 1000;
const MAX_POSITION_S = 24 * 60 * 60;

let io = null;

const connected = new Map(); // username -> Set(socketId)
const invites = new Map(); // inviteId -> { id, from, to, videoId, title, createdAt }
const rooms = new Map(); // roomId -> room
const roomOfUser = new Map(); // username -> roomId
const inviteOfUser = new Map(); // username -> inviteId (pending, either direction)
const timers = new Map(); // key -> timeout
let idSeq = 1;

function peerOf(username) {
  const names = Object.keys(USERS);
  return names.find((u) => u !== username) || null;
}

function socketsOf(username) {
  return connected.get(username) || new Set();
}

function nameOf(username) {
  const u = USERS[username];
  return (u && u.displayName) || username;
}

function person(username) {
  return username ? { username, displayName: nameOf(username) } : null;
}

function setTimer(key, fn, ms) {
  clearTimer(key);
  timers.set(key, setTimeout(() => { timers.delete(key); fn(); }, ms));
}

function clearTimer(key) {
  const t = timers.get(key);
  if (t) { clearTimeout(t); timers.delete(key); }
}

function emitToUser(username, event, payload) {
  for (const id of socketsOf(username)) io.to(id).emit(event, payload);
}

function joinUserToRoom(username, roomId) {
  for (const id of socketsOf(username)) {
    const s = io.sockets.sockets.get(id);
    if (s) s.join(roomSock(roomId));
  }
}

function roomSock(roomId) {
  return `wt:${roomId}`;
}

function roomMembers(room) {
  return [...room.members.keys()].map((u) => ({
    username: u,
    displayName: nameOf(u),
    online: room.members.get(u).online,
  }));
}

function stateFor(room) {
  return {
    roomId: room.id,
    videoId: room.videoId,
    title: room.title,
    playing: room.playing,
    position: room.position,
    seq: room.seq,
    serverNow: Date.now(),
    members: roomMembers(room),
  };
}

function broadcastState(room) {
  io.to(roomSock(room.id)).emit('wt:state', stateFor(room));
}

function sendRoomState(room, username) {
  emitToUser(username, 'wt:room:state', stateFor(room));
}

function destroyRoom(room) {
  for (const u of room.members.keys()) {
    roomOfUser.delete(u);
    clearTimer(`disc:${u}`);
  }
  rooms.delete(room.id);
}

function deleteInvite(inviteId) {
  const invite = invites.get(inviteId);
  if (!invite) return null;
  invites.delete(inviteId);
  if (inviteOfUser.get(invite.from) === inviteId) inviteOfUser.delete(invite.from);
  if (inviteOfUser.get(invite.to) === inviteId) inviteOfUser.delete(invite.to);
  clearTimer(`inv:${inviteId}`);
  return invite;
}

// A member vanished (explicit leave, tab close, or grace timer expiring): tell
// whoever is still in the room so their player can stop and pause, then drop the
// room when it is empty. Rooms are always exactly two people.
function removeMember(room, username, reason) {
  if (!room.members.has(username)) return;
  room.members.delete(username);
  roomOfUser.delete(username);
  clearTimer(`disc:${username}`);
  const by = person(username);
  for (const [other, meta] of room.members) {
    emitToUser(other, 'wt:room:partner-left', {
      roomId: room.id,
      by,
      reason,
      videoId: room.videoId,
      title: room.title,
    });
    void meta;
  }
  if (room.members.size < 2) destroyRoom(room);
}

// One party went quiet (socket closed). Keep their seat for a grace window so a
// refresh/network blip rejoins the same room instead of restarting playback; if
// nobody comes back, the room ends for good.
function markOffline(room, username) {
  const meta = room.members.get(username);
  if (!meta) return;
  meta.online = false;
  const other = [...room.members.keys()].find((u) => u !== username);
  if (other) emitToUser(other, 'wt:partner:status', { roomId: room.id, partner: person(username), online: false });
  setTimer(`disc:${username}`, () => {
    const r = rooms.get(room.id);
    if (r && r.members.has(username) && !r.members.get(username).online) {
      removeMember(r, username, 'disconnected');
    }
  }, DISCONNECT_GRACE_MS);
}

function reattach(room, username, socket) {
  const meta = room.members.get(username);
  if (!meta) return false;
  clearTimer(`disc:${username}`);
  meta.online = true;
  socket.join(roomSock(room.id));
  const other = [...room.members.keys()].find((u) => u !== username);
  if (other) emitToUser(other, 'wt:partner:status', { roomId: room.id, partner: person(username), online: true });
  sendRoomState(room, username);
  return true;
}

function clampPosition(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_POSITION_S);
}

function updatePlayback(room, username, patch) {
  const position = clampPosition(patch.position);
  if (position === null) return false;
  room.position = position;
  if (typeof patch.playing === 'boolean') room.playing = patch.playing;
  room.seq += 1;
  broadcastState(room);
  return true;
}

function attach(socket) {
  const user = socket.user;
  if (!user || !USERS[user.username]) return;
  const username = user.username;

  if (!connected.has(username)) connected.set(username, new Set());
  connected.get(username).add(socket.id);

  // Rejoin an existing room (refresh / reconnect) and re-deliver a pending
  // invitation the client may have missed while it was offline.
  const roomId = roomOfUser.get(username);
  if (roomId && rooms.has(roomId)) reattach(rooms.get(roomId), username, socket);
  const pendingId = inviteOfUser.get(username);
  if (pendingId && invites.has(pendingId)) {
    const inv = invites.get(pendingId);
    if (inv.to === username) {
      socket.emit('wt:invite:new', {
        inviteId: inv.id,
        videoId: inv.videoId,
        title: inv.title,
        from: person(inv.from),
      });
    }
  }

  const ack = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('wt:invite', (payload, cb) => {
    const done = ack(cb);
    const to = peerOf(username);
    if (!to) return done({ ok: false, error: 'No one to invite.' });
    if (!socketsOf(to).size) return done({ ok: false, error: `${nameOf(to)} is offline.` });
    if (roomOfUser.has(username) || roomOfUser.has(to)) {
      return done({ ok: false, error: 'A watch session is already active.' });
    }
    if (inviteOfUser.has(username) || inviteOfUser.has(to)) {
      return done({ ok: false, error: 'An invitation is already pending.' });
    }
    const videoId = String((payload && payload.videoId) || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return done({ ok: false, error: 'Invalid video.' });

    const invite = {
      id: `inv${idSeq++}`,
      from: username,
      to,
      videoId,
      title: String((payload && payload.title) || '').slice(0, 300),
      createdAt: Date.now(),
    };
    invites.set(invite.id, invite);
    inviteOfUser.set(username, invite.id);
    inviteOfUser.set(to, invite.id);
    setTimer(`inv:${invite.id}`, () => {
      if (deleteInvite(invite.id)) {
        emitToUser(invite.from, 'wt:invite:cancelled', { inviteId: invite.id, reason: 'expired' });
        emitToUser(invite.to, 'wt:invite:cancelled', { inviteId: invite.id, reason: 'expired' });
      }
    }, INVITE_TTL_MS);

    emitToUser(to, 'wt:invite:new', {
      inviteId: invite.id,
      videoId: invite.videoId,
      title: invite.title,
      from: person(invite.from),
    });
    return done({ ok: true, inviteId: invite.id });
  });

  socket.on('wt:invite:respond', (payload, cb) => {
    const done = ack(cb);
    const inviteId = String((payload && payload.inviteId) || '');
    const invite = invites.get(inviteId);
    if (!invite || invite.to !== username) {
      return done({ ok: false, error: 'That invitation is no longer available.' });
    }
    const accept = !!(payload && payload.accept);

    if (!accept) {
      deleteInvite(inviteId);
      emitToUser(invite.from, 'wt:invite:declined', { inviteId, by: person(username) });
      return done({ ok: true });
    }

    if (!socketsOf(invite.from).size) {
      deleteInvite(inviteId);
      emitToUser(invite.to, 'wt:invite:cancelled', { inviteId, reason: 'offline' });
      return done({ ok: false, error: `${nameOf(invite.from)} went offline.` });
    }
    if (roomOfUser.has(invite.from) || roomOfUser.has(username)) {
      deleteInvite(inviteId);
      return done({ ok: false, error: 'A watch session is already active.' });
    }

    deleteInvite(inviteId);
    const room = {
      id: `room${idSeq++}`,
      videoId: invite.videoId,
      title: invite.title,
      members: new Map([
        [invite.from, { online: true }],
        [username, { online: true }],
      ]),
      playing: false,
      position: 0,
      seq: 1,
    };
    rooms.set(room.id, room);
    roomOfUser.set(invite.from, room.id);
    roomOfUser.set(username, room.id);
    for (const u of room.members.keys()) {
      joinUserToRoom(u, room.id);
      emitToUser(u, 'wt:room:state', stateFor(room));
    }
    return done({ ok: true, roomId: room.id });
  });

  socket.on('wt:join', (payload, cb) => {
    const done = ack(cb);
    const roomId = String((payload && payload.roomId) || '');
    const room = rooms.get(roomId);
    if (!room || !room.members.has(username)) return done({ ok: false, error: 'That session has ended.' });
    reattach(room, username, socket);
    return done({ ok: true, state: stateFor(room) });
  });

  const playbackEvent = (playing) => (payload, cb) => {
    const done = ack(cb);
    const roomId = String((payload && payload.roomId) || '');
    const room = rooms.get(roomId);
    if (!room || !room.members.has(username)) return done({ ok: false, error: 'Not a member of that session.' });
    const patch = { position: payload && payload.position };
    if (playing !== undefined) patch.playing = playing;
    return done(updatePlayback(room, username, patch) ? { ok: true } : { ok: false, error: 'Bad position.' });
  };

  socket.on('wt:play', playbackEvent(true));
  socket.on('wt:pause', playbackEvent(false));
  socket.on('wt:seek', playbackEvent(undefined));

  socket.on('wt:leave', (payload, cb) => {
    const done = ack(cb);
    const roomId = String((payload && payload.roomId) || '');
    const room = rooms.get(roomId);
    if (!room || !room.members.has(username)) return done({ ok: false });
    removeMember(room, username, 'left');
    return done({ ok: true });
  });

  socket.on('disconnect', () => {
    const set = connected.get(username);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) connected.delete(username);
    }

    // A pending invitation cannot outlive the person who sent or received it.
    const pendingId = inviteOfUser.get(username);
    if (pendingId && invites.has(pendingId)) {
      const inv = deleteInvite(pendingId);
      if (inv) {
        emitToUser(inv.from, 'wt:invite:cancelled', { inviteId: inv.id, reason: 'offline' });
        emitToUser(inv.to, 'wt:invite:cancelled', { inviteId: inv.id, reason: 'offline' });
      }
    }

    if (connected.has(username)) return; // still has other tabs/devices
    const roomId = roomOfUser.get(username);
    if (roomId && rooms.has(roomId)) markOffline(rooms.get(roomId), username);
  });
}

function attachWatchTogether(socketIo) {
  io = socketIo;
  io.on('connection', (socket) => {
    try {
      attach(socket);
    } catch (e) {
      console.error('watchtogether connection error', e && e.message);
    }
  });
}

module.exports = { attachWatchTogether };
