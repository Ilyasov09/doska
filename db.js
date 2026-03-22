const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Xonalar jadvali
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(12) PRIMARY KEY,
        name VARCHAR(100),
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        last_active TIMESTAMP DEFAULT NOW()
      )
    `);

    // Chizmalar jadvali
    await client.query(`
      CREATE TABLE IF NOT EXISTS strokes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id VARCHAR(12) REFERENCES rooms(id) ON DELETE CASCADE,
        user_id VARCHAR(36) NOT NULL,
        user_name VARCHAR(50),
        user_color VARCHAR(7),
        tool VARCHAR(20) NOT NULL,
        points JSONB,
        shape_data JSONB,
        color VARCHAR(7) DEFAULT '#000000',
        width FLOAT DEFAULT 3,
        opacity FLOAT DEFAULT 1,
        fill_color VARCHAR(7),
        font_size INTEGER,
        text_content TEXT,
        image_data TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Sticky notes jadvali
    await client.query(`
      CREATE TABLE IF NOT EXISTS sticky_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id VARCHAR(12) REFERENCES rooms(id) ON DELETE CASCADE,
        user_id VARCHAR(36) NOT NULL,
        x FLOAT NOT NULL,
        y FLOAT NOT NULL,
        width FLOAT DEFAULT 200,
        height FLOAT DEFAULT 150,
        content TEXT DEFAULT '',
        bg_color VARCHAR(7) DEFAULT '#fef08a',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Index lar
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_strokes_room ON strokes(room_id);
      CREATE INDEX IF NOT EXISTS idx_notes_room ON sticky_notes(room_id);
      CREATE INDEX IF NOT EXISTS idx_rooms_last_active ON rooms(last_active);
    `);

    await client.query('COMMIT');
    console.log('✅ Database initialized');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ DB init error:', err);
    throw err;
  } finally {
    client.release();
  }
};

// Eski xonalarni tozalash (30 kundan eski)
const cleanupOldRooms = async () => {
  try {
    const result = await pool.query(
      `DELETE FROM rooms WHERE last_active < NOW() - INTERVAL '30 days' RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned ${result.rowCount} old rooms`);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
};

module.exports = { pool, initDB, cleanupOldRooms };
