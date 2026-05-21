const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const IS_PG = !!process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nikesoccer2025';

// ── Database setup ────────────────────────────────────────
let db, query;

if (IS_PG) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  query = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
  db = { init: async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        preferred_role TEXT,
        shirt_size TEXT,
        shorts_size TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER NOT NULL REFERENCES staff(id),
        camp TEXT NOT NULL,
        day TEXT NOT NULL,
        shift TEXT NOT NULL,
        status TEXT DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS staff_ratings (
        staff_id INTEGER PRIMARY KEY REFERENCES staff(id),
        rating INTEGER DEFAULT 3,
        notes TEXT
      );
    `);
  }};
} else {
  const Database = require('better-sqlite3');
  const sqlite = new Database('scheduler.db');

  // Migrations
  const reqCols = sqlite.prepare("PRAGMA table_info(requests)").all().map(c => c.name);
  if (reqCols.length > 0 && !reqCols.includes('day')) sqlite.exec('DROP TABLE IF EXISTS requests');
  const staffCols = sqlite.prepare("PRAGMA table_info(staff)").all().map(c => c.name);
  if (staffCols.length > 0 && !staffCols.includes('shirt_size')) {
    sqlite.exec('ALTER TABLE staff ADD COLUMN shirt_size TEXT');
    sqlite.exec('ALTER TABLE staff ADD COLUMN shorts_size TEXT');
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
      preferred_role TEXT, shirt_size TEXT, shorts_size TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL, camp TEXT NOT NULL, day TEXT NOT NULL,
      shift TEXT NOT NULL, status TEXT DEFAULT 'pending',
      FOREIGN KEY (staff_id) REFERENCES staff(id)
    );
    CREATE TABLE IF NOT EXISTS staff_ratings (
      staff_id INTEGER PRIMARY KEY, rating INTEGER DEFAULT 3, notes TEXT,
      FOREIGN KEY (staff_id) REFERENCES staff(id)
    );
  `);

  // Wrap sqlite in async-compatible interface
  query = (sql, params = []) => {
    // Convert $1,$2 placeholders to ? for SQLite
    let i = 0;
    const converted = sql.replace(/\$\d+/g, () => '?');
    const trimmed = converted.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      return Promise.resolve(sqlite.prepare(converted).all(...params));
    }
    if (trimmed.startsWith('INSERT') && converted.toLowerCase().includes('returning')) {
      const withoutReturning = converted.replace(/returning\s+\*/i, '');
      const info = sqlite.prepare(withoutReturning).run(...params);
      const table = converted.match(/insert into (\w+)/i)?.[1];
      if (table) {
        const row = sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
        return Promise.resolve([row]);
      }
      return Promise.resolve([{ id: info.lastInsertRowid }]);
    }
    const info = sqlite.prepare(converted).run(...params);
    return Promise.resolve([]);
  };
  db = { init: async () => {} };
}

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'camp-scheduler-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Staff Submission ──────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const { name, email, phone, preferred_role, shirt_size, shorts_size, shifts } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const existing = await query('SELECT id FROM staff WHERE LOWER(email) = LOWER($1)', [email]);
    let staffId;
    if (existing.length > 0) {
      staffId = existing[0].id;
      await query('DELETE FROM requests WHERE staff_id = $1', [staffId]);
      await query(
        'UPDATE staff SET name=$1, phone=$2, preferred_role=$3, shirt_size=$4, shorts_size=$5, submitted_at=' + (IS_PG ? 'NOW()' : 'CURRENT_TIMESTAMP') + ' WHERE id=$6',
        [name, phone, preferred_role, shirt_size, shorts_size, staffId]
      );
    } else {
      const rows = await query(
        'INSERT INTO staff (name, email, phone, preferred_role, shirt_size, shorts_size) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [name, email, phone, preferred_role, shirt_size, shorts_size]
      );
      staffId = rows[0].id;
    }

    if (shifts && shifts.length > 0) {
      for (const s of shifts) {
        await query('INSERT INTO requests (staff_id, camp, day, shift) VALUES ($1,$2,$3,$4)', [staffId, s.camp, s.day, s.shift]);
      }
    }

    res.json({ ok: true, message: existing.length > 0 ? 'Availability updated!' : 'Submitted successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Staff Lookup ──────────────────────────────────────────
app.get('/api/staff/lookup', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const rows = await query('SELECT * FROM staff WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const staff = rows[0];
    const requests = await query('SELECT camp, day, shift FROM requests WHERE staff_id = $1', [staff.id]);
    res.json({ staff, requests });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin Auth ────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) { req.session.admin = true; res.json({ ok: true }); }
  else res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
function requireAdmin(req, res, next) { req.session.admin ? next() : res.status(401).json({ error: 'Unauthorized' }); }

// ── Admin Data ────────────────────────────────────────────
app.get('/api/admin/submissions', requireAdmin, async (req, res) => {
  try {
    const staffList = await query('SELECT * FROM staff ORDER BY submitted_at DESC');
    const result = await Promise.all(staffList.map(async s => {
      const requests = await query('SELECT * FROM requests WHERE staff_id = $1 ORDER BY camp, day', [s.id]);
      const ratingRows = await query('SELECT * FROM staff_ratings WHERE staff_id = $1', [s.id]);
      const rating = ratingRows[0] || { rating: 3, notes: '' };
      const weeks = new Set(requests.map(r => r.camp));
      const fullDays = requests.filter(r => r.shift === 'full').length;
      const halfDays = requests.filter(r => r.shift !== 'full').length;
      const priorityScore = (fullDays * 2) + (halfDays) + (weeks.size * 3) + ((rating.rating || 3) * 2);
      return { ...s, requests, rating, priorityScore, weekCount: weeks.size };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/camps', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT r.camp, r.day, r.shift, r.status, r.id as req_id,
             s.name, s.email, s.phone, s.preferred_role, s.id as staff_id,
             COALESCE(sr.rating, 3) as rating
      FROM requests r
      JOIN staff s ON r.staff_id = s.id
      LEFT JOIN staff_ratings sr ON s.id = sr.staff_id
      ORDER BY r.camp, s.name, r.day
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/status', requireAdmin, async (req, res) => {
  try {
    const { staff_id, camp, status } = req.body;
    await query('UPDATE requests SET status = $1 WHERE staff_id = $2 AND camp = $3', [status, staff_id, camp]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/rating', requireAdmin, async (req, res) => {
  try {
    const { staff_id, rating, notes } = req.body;
    if (IS_PG) {
      await query(`INSERT INTO staff_ratings (staff_id, rating, notes) VALUES ($1,$2,$3)
        ON CONFLICT (staff_id) DO UPDATE SET rating=EXCLUDED.rating, notes=EXCLUDED.notes`,
        [staff_id, rating, notes]);
    } else {
      await query(`INSERT INTO staff_ratings (staff_id, rating, notes) VALUES ($1,$2,$3)
        ON CONFLICT(staff_id) DO UPDATE SET rating=$2, notes=$3`,
        [staff_id, rating, notes]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3579;
db.init().then(() => {
  app.listen(PORT, () => console.log(`Camp Scheduler running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
