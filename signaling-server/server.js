const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5 * 1024 * 1024  // 5 MB — allows large NES state snapshots without crashing
});

const PORT = process.env.PORT || 9000;

// rooms: { [code]: { hostId, guestId|null } }
const rooms = {};

io.on('connection', socket => {
  console.log('[+] connected:', socket.id);

  // HOST creates a room
  socket.on('host', code => {
    rooms[code] = { hostId: socket.id, guestId: null };
    socket.join(code);
    socket.emit('host_ok', code);
    console.log(`[room] created: ${code} by ${socket.id}`);
  });

  // GUEST joins a room
  socket.on('join', code => {
    const room = rooms[code];
    if (!room) { socket.emit('join_err', 'Room not found. Check the code.'); return; }
    if (room.guestId) { socket.emit('join_err', 'Room is full.'); return; }
    room.guestId = socket.id;
    socket.join(code);
    socket.emit('join_ok', code);
    io.to(room.hostId).emit('peer_joined');
    console.log(`[room] ${socket.id} joined ${code}`);
  });

  // Relay — forward any message to the other peer
  socket.on('relay', ({ code, msg }) => {
    const room = rooms[code];
    if (!room) return;
    const targetId = socket.id === room.hostId ? room.guestId : room.hostId;
    if (targetId) io.to(targetId).emit('relay', msg);
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.hostId === socket.id) {
        io.to(code).emit('peer_left', { role: 'host' });
        delete rooms[code];
        console.log(`[room] ${code} closed (host left)`);
        break;
      } else if (room.guestId === socket.id) {
        io.to(room.hostId).emit('peer_left', { role: 'p2' });
        room.guestId = null;
        console.log(`[room] ${code} guest left, room stays open`);
        break;
      }
    }
    console.log('[-] disconnected:', socket.id);
  });
});

app.get('/health', (_, res) => res.send('OK'));

server.listen(PORT, () =>
  console.log(`[NESROOM] Socket.IO server on port ${PORT}`)
);
