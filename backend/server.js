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

// ─── Helpers ─────────────────────────────────────────────────────────────────
const USER_NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Avery','Quinn','Blake'];
const USER_COLORS = ['#6c63ff','#ff6584','#43e97b','#f9c74f','#48cae4','#ff9f1c','#ef233c','#a8dadc','#e9c46a','#f4a261'];
const onlineUsers = new Map();

function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function genRoomId() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({length:8}, () => c[Math.floor(Math.random()*c.length)]).join('');
}

async function logActivity(roomId, user, action, detail='') {
  try {
    await pool.query(
      `INSERT INTO activity_log (room_id, user_id, user_name, user_color, action, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [roomId, user.userId, user.name, user.color, action, detail]
    );
  } catch(e) { /* log xatosi asosiy jarayonni to'xtatmasin */ }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.post('/api/rooms', async (req, res) => {
  try {
    const { name, password } = req.body;
    const roomId = genRoomId();
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
    const [strokesRes, notesRes, chatRes, activityRes] = await Promise.all([
      pool.query('SELECT * FROM strokes WHERE room_id = $1 ORDER BY created_at ASC', [roomId]),
      pool.query('SELECT * FROM sticky_notes WHERE room_id = $1 ORDER BY created_at ASC', [roomId]),
      pool.query('SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 200', [roomId]),
      pool.query('SELECT * FROM activity_log WHERE room_id = $1 ORDER BY created_at DESC LIMIT 100', [roomId]),
    ]);
    await pool.query('UPDATE rooms SET last_active = NOW() WHERE id = $1', [roomId]);
    res.json({
      strokes: strokesRes.rows,
      notes: notesRes.rows,
      chat: chatRes.rows,
      activity: activityRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Ma\'lumotlarni yuklashda xato' });
  }
});

// Xona tarixi
app.get('/api/rooms/:roomId/activity', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const result = await pool.query(
      'SELECT * FROM activity_log WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [roomId, limit, offset]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Tarixni yuklashda xato' });
  }
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('join-room', async ({ roomId, userId, preferredName }) => {
    try {
      const roomResult = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
      if (roomResult.rows.length === 0) { socket.emit('error', { message: 'Xona topilmadi' }); return; }
      socket.join(roomId);
      const user = {
        socketId: socket.id, userId: userId || uuidv4(), roomId,
        name: preferredName || getRandom(USER_NAMES),
        color: getRandom(USER_COLORS),
      };
      onlineUsers.set(socket.id, user);
      socket.to(roomId).emit('user-joined', { userId: user.userId, name: user.name, color: user.color });
      const roomUsers = [];
      for (const [, u] of onlineUsers) {
        if (u.roomId === roomId && u.socketId !== socket.id)
          roomUsers.push({ userId: u.userId, name: u.name, color: u.color });
      }
      socket.emit('joined', { user: { userId: user.userId, name: user.name, color: user.color }, onlineUsers: roomUsers });
      // Tarixga yozish
      logActivity(roomId, user, 'join', `${user.name} xonaga kirdi`);
      io.to(roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'join', detail: `${user.name} xonaga kirdi`, createdAt: new Date().toISOString() });
    } catch (err) {
      console.error('Join error:', err);
      socket.emit('error', { message: 'Xonaga kira olmadingiz' });
    }
  });

  socket.on('rename', ({ name }) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !name?.trim()) return;
    const oldName = user.name;
    user.name = name.trim().slice(0, 30);
    io.to(user.roomId).emit('user-renamed', { userId: user.userId, name: user.name });
    logActivity(user.roomId, user, 'rename', `${oldName} → ${user.name}`);
    io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'rename', detail: `Ism o'zgardi: ${oldName} → ${user.name}`, createdAt: new Date().toISOString() });
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

  // Batch points (performance uchun)
  socket.on('stroke-batch', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(user.roomId).emit('stroke-batch', { ...data, userId: user.userId });
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

      // Tool ga qarab tarix
      const toolNames = { pen: 'Chizdi', eraser: 'O\'chirdi', line: 'Chiziq', rect: 'To\'rtburchak', circle: 'Doira', triangle: 'Uchburchak', arrow: 'O\'q', text: 'Matn yozdi', image: 'Rasm qo\'shdi' };
      const detail = toolNames[tool] || tool;
      logActivity(user.roomId, user, 'draw', detail);
      io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'draw', detail, createdAt: new Date().toISOString() });
    } catch (err) { console.error('Stroke save error:', err); }
  });

  socket.on('stroke-move', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query(
        `UPDATE strokes SET points=$1, shape_data=$2 WHERE id=$3 AND room_id=$4`,
        [JSON.stringify(data.newPoints || []), JSON.stringify(data.newShapeData || null), data.strokeId, user.roomId]
      );
      socket.to(user.roomId).emit('stroke-move', { ...data, userId: user.userId });
    } catch (err) { console.error('Stroke move error:', err); }
  });

  socket.on('stroke-zindex', async ({ strokeId, zIndex }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query('UPDATE strokes SET z_index=$1 WHERE id=$2 AND room_id=$3', [zIndex, strokeId, user.roomId]);
      socket.to(user.roomId).emit('stroke-zindex', { strokeId, zIndex });
    } catch (err) { console.error('Z-index error:', err); }
  });

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
      logActivity(user.roomId, user, 'draw', 'Rasm qo\'shdi');
      io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'image', detail: 'Rasm qo\'shdi', createdAt: new Date().toISOString() });
    } catch (err) { console.error('Image save error:', err); }
  });

  socket.on('image-resize', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query(
        `UPDATE strokes SET shape_data=$1 WHERE id=$2 AND room_id=$3`,
        [JSON.stringify({ x: data.x, y: data.y, width: data.width, height: data.height }), data.strokeId, user.roomId]
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
      logActivity(user.roomId, user, 'note', 'Sticky note qo\'shdi');
      io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'note', detail: 'Sticky note qo\'shdi', createdAt: new Date().toISOString() });
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
      const msg = { id: msgId, userId: user.userId, name: user.name, color: user.color, text: text.trim().slice(0, 500), createdAt: new Date().toISOString() };
      await pool.query(
        `INSERT INTO chat_messages (id, room_id, user_id, user_name, user_color, text) VALUES ($1,$2,$3,$4,$5,$6)`,
        [msgId, user.roomId, user.userId, user.name, user.color, msg.text]
      );
      io.to(user.roomId).emit('chat-message', msg);
      logActivity(user.roomId, user, 'chat', `"${msg.text.slice(0, 40)}${msg.text.length > 40 ? '...' : ''}"`);
      io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'chat', detail: `Chat: "${msg.text.slice(0, 30)}${msg.text.length > 30 ? '...' : ''}"`, createdAt: new Date().toISOString() });
    } catch (err) { console.error('Chat error:', err); }
  });

  // ── Reactions ──────────────────────────────────────────────────────────────
  socket.on('reaction', ({ emoji, x, y }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    // Barcha foydalanuvchilarga yuborish (o'ziga ham)
    io.to(user.roomId).emit('reaction', { emoji, x, y, userId: user.userId, name: user.name, color: user.color });
  });

  // ── Varoq nom ──────────────────────────────────────────────────────────────
  socket.on('page-rename', ({ pageIdx, name }) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    socket.to(user.roomId).emit('page-rename', { pageIdx, name });
    logActivity(user.roomId, user, 'page', `Varoq nomlandi: "${name}"`);
    io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'page', detail: `Varoq nomlandi: "${name}"`, createdAt: new Date().toISOString() });
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
      if (result.rows.length > 0) {
        io.to(user.roomId).emit('stroke-removed', { strokeId: result.rows[0].id });
        logActivity(user.roomId, user, 'undo', 'Bekor qildi');
        io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'undo', detail: 'Bekor qildi', createdAt: new Date().toISOString() });
      }
    } catch (err) { console.error('Undo error:', err); }
  });

  // ── Clear ──────────────────────────────────────────────────────────────────
  socket.on('clear-board', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    try {
      await pool.query('DELETE FROM strokes WHERE room_id=$1', [user.roomId]);
      await pool.query('DELETE FROM sticky_notes WHERE room_id=$1', [user.roomId]);
      io.to(user.roomId).emit('board-cleared');
      logActivity(user.roomId, user, 'clear', 'Hammani tozaladi');
      io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'clear', detail: 'Hammani tozaladi', createdAt: new Date().toISOString() });
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
      logActivity(user.roomId, user, 'leave', `${user.name} xonani tark etdi`);
      io.to(user.roomId).emit('activity', { userId: user.userId, name: user.name, color: user.color, action: 'leave', detail: `${user.name} xonani tark etdi`, createdAt: new Date().toISOString() });
      onlineUsers.delete(socket.id);
    }
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() => {
  server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  setInterval(cleanupOldRooms, 6 * 60 * 60 * 1000);
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
