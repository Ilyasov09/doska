require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, initDB, cleanupOldRooms } = require('./db');

const app = express();
const server = http.createServer(app);
const CLIENT_URL = process.env.CLIENT_URL || '*';

const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10e6,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: '10mb' }));

// ─── Foydalanuvchi ma'lumotlari ───────────────────────────────────────────────
const USER_NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Avery','Quinn','Blake'];
const USER_COLORS = ['#6c63ff','#ff6584','#43e97b','#f9c74f','#48cae4','#ff9f1c','#ef233c','#a8dadc','#e9c46a','#f4a261'];
const onlineUsers = new Map(); // socketId -> user

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getRoomUsers(roomId) {
  const users = [];
  for (const [, u] of onlineUsers) {
    if (u.roomId === roomId) users.push({ userId: u.userId, name: u.name, color: u.color });
  }
  return users;
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.post('/api/rooms', async (req, res) => {
  try {
    const { name, password } = req.body;
    const roomId = generateRoomId();
    const passwordHash = password?.trim() ? await bcrypt.hash(password.trim(), 10) : null;
    await pool.query('INSERT INTO rooms (id, name, password_hash) VALUES ($1, $2, $3)', [roomId, name || `Xona ${roomId}`, passwordHash]);
    res.json({ roomId, hasPassword: !!passwordHash });
  } catch (err) {
    console.error('Create room error:', err);
    res.status(500).json({ error: 'Xona yaratib bo\'lmadi' });
  }
});

app.post('/api/rooms/:roomId/join', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { password } = req.body;
    const result = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Xona topilmadi' });
    const room = result.rows[0];
    if (room.password_hash) {
      if (!password) return res.status(401).json({ error: 'Parol kerak', needsPassword: true });
      const match = await bcrypt.compare(password, room.password_hash);
      if (!match) return res.status(401).json({ error: 'Parol noto\'g\'ri' });
    }
    res.json({ roomId: room.id, name: room.name, hasPassword: !!room.password_hash });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
});

app.get('/api/rooms/:roomId/data', async (req, res) => {
  try {
    const { roomId } = req.params;
    const [strokesRes, notesRes, chatRes] = await Promise.all([
      pool.query('SELECT * FROM strokes WHERE room_id = $1 ORDER BY created_at ASC', [roomId]),
      pool.query('SELECT * FROM sticky_notes WHERE room_id = $1 ORDER BY created_at ASC', [roomId]),
      pool.query('SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200', [roomId]),
    ]);
    await pool.query('UPDATE rooms SET last_active = NOW() WHERE id = $1', [roomId]);
    res.json({ strokes: strokesRes.rows, notes: notesRes.rows, chat: chatRes.rows });
  } catch (err) {
    res.status(500).json({ error: 'Ma\'lumotlarni yuklashda xato' });
  }
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── Xonaga qo'shilish ──────────────────────────────────────────────────────
  socket.on('join-room', async ({ roomId, userId, preferredName }) => {
    try {
      const roomResult = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
      if (roomResult.rows.length === 0) { socket.emit('error', { message: 'Xona topilmadi' }); return; }

      socket.join(roomId);

      const user = {
        socketId: socket.id,
        userId: userId || uuidv4(),
        roomId,
        name: preferredName || getRandomItem(USER_NAMES),
        color: getRandomItem(USER_COLORS),
        cursor: { x: 0, y: 0 },
      };
      onlineUsers.set(socket.id, user);

      socket.to(roomId).emit('user-joined', { userId: user.userId, name: user.name, color: user.color });

      const roomUsers = getRoomUsers(roomId).filter(u => u.userId !== user.userId);
      socket.emit('joined', {
        user: { userId: user.userId, name: user.name, color: user.color },
        onlineUsers: roomUsers,
      });
    } catch (err) {
      console.error('Join error:', err);
      socket.emit('error', { message: 'Xonaga kira olmadingiz' });
    }
  });

  // ── Ism o'zgartirish ───────────────────────────────────────────────────────
  socket.on('rename', ({ name }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !name?.trim()) return;
    user.name = name.trim().slice(0, 30);
    io.to(user.roomId).emit('user-renamed', { userId: user.userId, name: user.name });
  });

  // ── Stroke events ──────────────────────────────────────────────────────────
  socket.on('stroke-start', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(user.roomId).emit('stroke-start', { ...data, userId: user.userId });
  });

  socket.on('stroke-point', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(user.roomId).emit('stroke-point', { ...data, userId: user.userId });
  });

  socket.on('stroke-end', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      const { tool, points, shapeData, color, width, opacity, fillColor, fontSize, textContent, strokeId, zIndex } = data;
      await pool.query(
        `INSERT INTO strokes (id, room_id, user_id, user_name, user_color, tool, points, shape_data, color, width, opacity, fill_color, font_size, text_content, z_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [strokeId || uuidv4(), user.roomId, user.userId, user.name, user.color, tool,
         JSON.stringify(points || []), JSON.stringify(shapeData || null),
         color || '#000', width || 3, opacity || 1, fillColor || null, fontSize || null, textContent || null, zIndex || 0]
      );
      socket.to(user.roomId).emit('stroke-end', { ...data, userId: user.userId });
      pool.query('UPDATE rooms SET last_active = NOW() WHERE id = $1', [user.roomId]);
    } catch (err) { console.error('Stroke save error:', err); }
  });

  // ── Shakl ko'chirish ───────────────────────────────────────────────────────
  socket.on('stroke-move', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      const { strokeId, dx, dy, newPoints, newShapeData } = data;
      await pool.query(
        `UPDATE strokes SET points=$1, shape_data=$2 WHERE id=$3 AND room_id=$4`,
        [JSON.stringify(newPoints || []), JSON.stringify(newShapeData || null), strokeId, user.roomId]
      );
      socket.to(user.roomId).emit('stroke-move', { ...data, userId: user.userId });
    } catch (err) { console.error('Stroke move error:', err); }
  });

  // ── Z-index (qatlam tartibi) ───────────────────────────────────────────────
  socket.on('stroke-zindex', async ({ strokeId, zIndex }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query('UPDATE strokes SET z_index=$1 WHERE id=$2 AND room_id=$3', [zIndex, strokeId, user.roomId]);
      socket.to(user.roomId).emit('stroke-zindex', { strokeId, zIndex });
    } catch (err) { console.error('Z-index error:', err); }
  });

  // ── Rasm yuklash ───────────────────────────────────────────────────────────
  socket.on('image-add', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      const strokeId = uuidv4();
      await pool.query(
        `INSERT INTO strokes (id, room_id, user_id, user_name, user_color, tool, shape_data, image_data, z_index)
         VALUES ($1,$2,$3,$4,$5,'image',$6,$7,$8)`,
        [strokeId, user.roomId, user.userId, user.name, user.color,
         JSON.stringify({ x: data.x, y: data.y, width: data.width, height: data.height }), data.imageData, data.zIndex || 0]
      );
      socket.to(user.roomId).emit('image-add', { ...data, strokeId, userId: user.userId });
      socket.emit('image-saved', { strokeId });
    } catch (err) { console.error('Image save error:', err); }
  });

  // ── Rasm o'lchamini o'zgartirish ───────────────────────────────────────────
  socket.on('image-resize', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      const { strokeId, x, y, width, height } = data;
      await pool.query(
        `UPDATE strokes SET shape_data=$1 WHERE id=$2 AND room_id=$3`,
        [JSON.stringify({ x, y, width, height }), strokeId, user.roomId]
      );
      socket.to(user.roomId).emit('image-resize', { ...data, userId: user.userId });
    } catch (err) { console.error('Image resize error:', err); }
  });

  // ── Sticky Notes ───────────────────────────────────────────────────────────
  socket.on('note-add', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      const noteId = uuidv4();
      await pool.query(
        `INSERT INTO sticky_notes (id, room_id, user_id, x, y, width, height, content, bg_color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [noteId, user.roomId, user.userId, data.x, data.y, data.width || 200, data.height || 150, data.content || '', data.bgColor || '#fef08a']
      );
      socket.to(user.roomId).emit('note-add', { ...data, noteId, userId: user.userId });
      socket.emit('note-saved', { noteId });
    } catch (err) { console.error('Note add error:', err); }
  });

  socket.on('note-update', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query(
        `UPDATE sticky_notes SET content=$1, x=$2, y=$3, updated_at=NOW() WHERE id=$4 AND room_id=$5`,
        [data.content, data.x, data.y, data.noteId, user.roomId]
      );
      socket.to(user.roomId).emit('note-update', { ...data, userId: user.userId });
    } catch (err) { console.error('Note update error:', err); }
  });

  socket.on('note-delete', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query('DELETE FROM sticky_notes WHERE id=$1 AND room_id=$2', [data.noteId, user.roomId]);
      socket.to(user.roomId).emit('note-delete', { noteId: data.noteId });
    } catch (err) { console.error('Note delete error:', err); }
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('chat-message', async ({ text }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !text?.trim()) return;
    try {
      const msgId = uuidv4();
      const msg = {
        id: msgId, userId: user.userId, name: user.name,
        color: user.color, text: text.trim().slice(0, 500),
        createdAt: new Date().toISOString(),
      };
      await pool.query(
        `INSERT INTO chat_messages (id, room_id, user_id, user_name, user_color, text) VALUES ($1,$2,$3,$4,$5,$6)`,
        [msgId, user.roomId, user.userId, user.name, user.color, msg.text]
      );
      io.to(user.roomId).emit('chat-message', msg);
    } catch (err) { console.error('Chat error:', err); }
  });

  // ── Reaktsiyalar ───────────────────────────────────────────────────────────
  socket.on('reaction', ({ emoji, x, y }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    io.to(user.roomId).emit('reaction', { emoji, x, y, userId: user.userId, name: user.name });
  });

  // ── Undo ───────────────────────────────────────────────────────────────────
  socket.on('undo', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      const result = await pool.query(
        `DELETE FROM strokes WHERE id = (SELECT id FROM strokes WHERE room_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1) RETURNING id`,
        [user.roomId, user.userId]
      );
      if (result.rows.length > 0) io.to(user.roomId).emit('stroke-removed', { strokeId: result.rows[0].id });
    } catch (err) { console.error('Undo error:', err); }
  });

  // ── Redo ───────────────────────────────────────────────────────────────────
  // Redo uchun client side history ishlatiladi

  // ── Hammasini tozalash ─────────────────────────────────────────────────────
  socket.on('clear-board', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query('DELETE FROM strokes WHERE room_id=$1', [user.roomId]);
      await pool.query('DELETE FROM sticky_notes WHERE room_id=$1', [user.roomId]);
      io.to(user.roomId).emit('board-cleared');
    } catch (err) { console.error('Clear error:', err); }
  });

  // ── Cursor ─────────────────────────────────────────────────────────────────
  socket.on('cursor-move', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(user.roomId).emit('cursor-move', { userId: user.userId, name: user.name, color: user.color, x: data.x, y: data.y });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('user-left', { userId: user.userId, name: user.name });
      onlineUsers.delete(socket.id);
    }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  setInterval(cleanupOldRooms, 6 * 60 * 60 * 1000);
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
