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
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 5e6, // 5MB - rasm yuklash uchun
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: '5mb' }));

// ─── Foydalanuvchi nomlari va ranglari ───────────────────────────────────────
const USER_NAMES = ['Alex','Sam','Jordan','Taylor','Morgan','Casey','Riley','Avery','Quinn','Blake','Drew','Sage'];
const USER_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#e91e63','#00bcd4'];

// RAM da online foydalanuvchilarni saqlash
const onlineUsers = new Map(); // socketId -> { userId, roomId, name, color, cursor }

function getRandomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// Health check (UptimeRobot uchun)
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Xona yaratish
app.post('/api/rooms', async (req, res) => {
  try {
    const { name, password } = req.body;
    const roomId = generateRoomId();
    let passwordHash = null;

    if (password && password.trim()) {
      passwordHash = await bcrypt.hash(password.trim(), 10);
    }

    await pool.query(
      'INSERT INTO rooms (id, name, password_hash) VALUES ($1, $2, $3)',
      [roomId, name || `Xona ${roomId}`, passwordHash]
    );

    res.json({ roomId, hasPassword: !!passwordHash });
  } catch (err) {
    console.error('Create room error:', err);
    res.status(500).json({ error: 'Xona yaratib bo\'lmadi' });
  }
});

// Xonaga kirish tekshiruvi
app.post('/api/rooms/:roomId/join', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { password } = req.body;

    const result = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Xona topilmadi' });
    }

    const room = result.rows[0];

    if (room.password_hash) {
      if (!password) {
        return res.status(401).json({ error: 'Parol kerak', needsPassword: true });
      }
      const match = await bcrypt.compare(password, room.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Parol noto\'g\'ri' });
      }
    }

    res.json({
      roomId: room.id,
      name: room.name,
      hasPassword: !!room.password_hash,
    });
  } catch (err) {
    console.error('Join room error:', err);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// Xona ma'lumotlari (chizmalar + notlar)
app.get('/api/rooms/:roomId/data', async (req, res) => {
  try {
    const { roomId } = req.params;

    const [strokesResult, notesResult] = await Promise.all([
      pool.query('SELECT * FROM strokes WHERE room_id = $1 ORDER BY created_at ASC', [roomId]),
      pool.query('SELECT * FROM sticky_notes WHERE room_id = $1 ORDER BY created_at ASC', [roomId]),
    ]);

    // last_active yangilash
    await pool.query('UPDATE rooms SET last_active = NOW() WHERE id = $1', [roomId]);

    res.json({
      strokes: strokesResult.rows,
      notes: notesResult.rows,
    });
  } catch (err) {
    console.error('Get data error:', err);
    res.status(500).json({ error: 'Ma\'lumotlarni yuklashda xato' });
  }
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // ── Xonaga qo'shilish ──────────────────────────────────────────────────────
  socket.on('join-room', async ({ roomId, userId }) => {
    try {
      const roomResult = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
      if (roomResult.rows.length === 0) {
        socket.emit('error', { message: 'Xona topilmadi' });
        return;
      }

      socket.join(roomId);

      const user = {
        socketId: socket.id,
        userId: userId || uuidv4(),
        roomId,
        name: getRandomItem(USER_NAMES),
        color: getRandomItem(USER_COLORS),
        cursor: { x: 0, y: 0 },
      };

      onlineUsers.set(socket.id, user);

      // Xonadagi boshqa foydalanuvchilarga xabar
      socket.to(roomId).emit('user-joined', {
        userId: user.userId,
        name: user.name,
        color: user.color,
      });

      // Xonadagi barcha foydalanuvchilar ro'yxati
      const roomUsers = [];
      for (const [, u] of onlineUsers) {
        if (u.roomId === roomId && u.socketId !== socket.id) {
          roomUsers.push({ userId: u.userId, name: u.name, color: u.color });
        }
      }

      socket.emit('joined', {
        user: { userId: user.userId, name: user.name, color: user.color },
        onlineUsers: roomUsers,
      });

    } catch (err) {
      console.error('Join room socket error:', err);
      socket.emit('error', { message: 'Xonaga kira olmadingiz' });
    }
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
      // DB ga saqlash
      const { tool, points, shapeData, color, width, opacity, fillColor, fontSize, textContent, strokeId } = data;

      await pool.query(
        `INSERT INTO strokes
          (id, room_id, user_id, user_name, user_color, tool, points, shape_data,
           color, width, opacity, fill_color, font_size, text_content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          strokeId || uuidv4(),
          user.roomId,
          user.userId,
          user.name,
          user.color,
          tool,
          JSON.stringify(points || []),
          JSON.stringify(shapeData || null),
          color || '#000000',
          width || 3,
          opacity || 1,
          fillColor || null,
          fontSize || null,
          textContent || null,
        ]
      );

      socket.to(user.roomId).emit('stroke-end', { ...data, userId: user.userId });

      // last_active yangilash
      pool.query('UPDATE rooms SET last_active = NOW() WHERE id = $1', [user.roomId]);
    } catch (err) {
      console.error('Stroke save error:', err);
    }
  });

  // ── Rasm yuklash ───────────────────────────────────────────────────────────
  socket.on('image-add', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    try {
      const strokeId = uuidv4();
      await pool.query(
        `INSERT INTO strokes
          (id, room_id, user_id, user_name, user_color, tool, shape_data, image_data)
         VALUES ($1,$2,$3,$4,$5,'image',$6,$7)`,
        [
          strokeId,
          user.roomId,
          user.userId,
          user.name,
          user.color,
          JSON.stringify({ x: data.x, y: data.y, width: data.width, height: data.height }),
          data.imageData,
        ]
      );

      const broadcastData = { ...data, strokeId, userId: user.userId };
      socket.to(user.roomId).emit('image-add', broadcastData);
      socket.emit('image-saved', { strokeId });
    } catch (err) {
      console.error('Image save error:', err);
    }
  });

  // ── Sticky Notes ───────────────────────────────────────────────────────────
  socket.on('note-add', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    try {
      const noteId = uuidv4();
      await pool.query(
        `INSERT INTO sticky_notes (id, room_id, user_id, x, y, width, height, content, bg_color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [noteId, user.roomId, user.userId, data.x, data.y, data.width || 200, data.height || 150, data.content || '', data.bgColor || '#fef08a']
      );

      const noteData = { ...data, noteId, userId: user.userId };
      socket.to(user.roomId).emit('note-add', noteData);
      socket.emit('note-saved', { noteId });
    } catch (err) {
      console.error('Note add error:', err);
    }
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
    } catch (err) {
      console.error('Note update error:', err);
    }
  });

  socket.on('note-delete', async (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    try {
      await pool.query('DELETE FROM sticky_notes WHERE id=$1 AND room_id=$2', [data.noteId, user.roomId]);
      socket.to(user.roomId).emit('note-delete', { noteId: data.noteId });
    } catch (err) {
      console.error('Note delete error:', err);
    }
  });

  // ── Undo ───────────────────────────────────────────────────────────────────
  socket.on('undo', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    try {
      // Foydalanuvchining oxirgi chizmasini o'chirish
      const result = await pool.query(
        `DELETE FROM strokes WHERE id = (
           SELECT id FROM strokes
           WHERE room_id=$1 AND user_id=$2
           ORDER BY created_at DESC LIMIT 1
         ) RETURNING id`,
        [user.roomId, user.userId]
      );

      if (result.rows.length > 0) {
        io.to(user.roomId).emit('stroke-removed', { strokeId: result.rows[0].id });
      }
    } catch (err) {
      console.error('Undo error:', err);
    }
  });

  // ── Hammasini tozalash (faqat xona yaratuvchi uchun) ───────────────────────
  socket.on('clear-board', async () => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;

    try {
      await pool.query('DELETE FROM strokes WHERE room_id=$1', [user.roomId]);
      await pool.query('DELETE FROM sticky_notes WHERE room_id=$1', [user.roomId]);
      io.to(user.roomId).emit('board-cleared');
    } catch (err) {
      console.error('Clear board error:', err);
    }
  });

  // ── Cursor harakat ─────────────────────────────────────────────────────────
  socket.on('cursor-move', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    user.cursor = { x: data.x, y: data.y };
    socket.to(user.roomId).emit('cursor-move', {
      userId: user.userId,
      name: user.name,
      color: user.color,
      x: data.x,
      y: data.y,
    });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      socket.to(user.roomId).emit('user-left', { userId: user.userId, name: user.name });
      onlineUsers.delete(socket.id);
    }
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

// ─── Server ishga tushirish ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // Har 6 soatda eski xonalarni tozalash
    setInterval(cleanupOldRooms, 6 * 60 * 60 * 1000);
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
