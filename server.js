/**
 * SyncBoard - server.js
 * ---------------------------------------------------------------
 * Responsibilities:
 *   1. Serve the static frontend (public/ folder) using Express.
 *   2. Manage "rooms" using Socket.io so each study group is isolated.
 *   3. Relay drawing / code / clear events between users of the same room.
 *   4. Keep a small in-memory copy of each room so LATE JOINERS see
 *      the existing drawing and code immediately.
 *
 * The server is intentionally a thin relay: it never draws anything,
 * it just validates, stores and re-broadcasts messages.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// Safety limits so one room cannot exhaust server memory.
const MAX_SEGMENTS_PER_ROOM = 50000;
const MAX_CODE_LENGTH = 200000; // characters
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000; // delete empty rooms after 5 min

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6, // reject any single message bigger than ~1 MB
});

// Serve index.html, style.css, app.js from /public
app.use(express.static(path.join(__dirname, 'public')));

/**
 * In-memory room store.
 *   roomId -> { segments: [...], code: "...", cleanupTimer }
 * (Swap this Map for Redis/MongoDB if you need persistence.)
 */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { segments: [], code: '', cleanupTimer: null });
  }
  const room = rooms.get(roomId);
  // Someone is here again, cancel any pending deletion.
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  return room;
}

// Room IDs: letters, digits, "_" and "-", max 40 chars (prevents junk input).
const isValidRoomId = (id) => typeof id === 'string' && /^[\w-]{1,40}$/.test(id);

// Number of sockets currently inside a room.
const countUsers = (roomId) => io.sockets.adapter.rooms.get(roomId)?.size || 0;

// Validate one drawing segment coming from a client (never trust the network).
function isValidSegment(s) {
  return (
    s &&
    [s.x0, s.y0, s.x1, s.y1, s.size].every((n) => Number.isFinite(n)) &&
    typeof s.color === 'string' &&
    s.color.length <= 20 &&
    typeof s.eraser === 'boolean'
  );
}

io.on('connection', (socket) => {
  /**
   * EVENT: join-room
   * Client says which room it wants. We put the socket in that
   * Socket.io room, send it the current board state, and tell
   * everybody the new user count.
   */
  socket.on('join-room', (roomId) => {
    if (!isValidRoomId(roomId)) return;

    // If the socket was in another room (e.g. reconnect), leave it first.
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      const oldRoom = socket.data.roomId;
      socket.leave(oldRoom);
      io.to(oldRoom).emit('presence-update', countUsers(oldRoom));
    }

    socket.join(roomId);
    socket.data.roomId = roomId;

    const room = getRoom(roomId);

    // Send ONLY to the newcomer: everything drawn/typed so far.
    socket.emit('room-state', { segments: room.segments, code: room.code });

    // Send to EVERYONE in the room: new participant count.
    io.to(roomId).emit('presence-update', countUsers(roomId));
  });

  /**
   * EVENT: draw-line
   * Payload: array of segments { x0, y0, x1, y1, color, size, eraser }.
   * The client batches several segments per message (throttling),
   * we store them and relay to everyone EXCEPT the sender
   * (the sender already drew them locally).
   */
  socket.on('draw-line', (segments) => {
    const roomId = socket.data.roomId;
    if (!roomId || !Array.isArray(segments) || segments.length > 500) return;

    const clean = segments.filter(isValidSegment);
    if (clean.length === 0) return;

    const room = getRoom(roomId);
    room.segments.push(...clean);
    if (room.segments.length > MAX_SEGMENTS_PER_ROOM) {
      room.segments.splice(0, room.segments.length - MAX_SEGMENTS_PER_ROOM);
    }

    socket.to(roomId).emit('draw-line', clean);
  });

  /**
   * EVENT: code-update
   * Payload: the full text of the scratchpad. Simple "last writer wins"
   * strategy (good enough for a scratchpad; real editors use OT/CRDT).
   */
  socket.on('code-update', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof text !== 'string' || text.length > MAX_CODE_LENGTH) return;

    getRoom(roomId).code = text;
    socket.to(roomId).emit('code-update', text);
  });

  /**
   * EVENT: clear-canvas
   * Wipes the stored strokes and tells the other peers to wipe theirs.
   */
  socket.on('clear-canvas', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    getRoom(roomId).segments = [];
    socket.to(roomId).emit('clear-canvas');
  });

  /**
   * EVENT: disconnect (built-in)
   * Update the presence counter; schedule cleanup if the room is empty.
   */
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const users = countUsers(roomId);
    io.to(roomId).emit('presence-update', users);

    if (users === 0 && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.cleanupTimer = setTimeout(() => {
        if (countUsers(roomId) === 0) rooms.delete(roomId);
      }, EMPTY_ROOM_TTL_MS);
    }
  });
});

server.listen(PORT, () => {
  console.log(`SyncBoard running at http://localhost:${PORT}/?room=study-group`);
});

module.exports = { app, server, io }; // exported for testing
