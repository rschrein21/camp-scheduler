const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const IS_PG = !!process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nikesoccer2025';
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || 'director2026';

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
        birthdate TEXT,
        address TEXT,
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
      CREATE TABLE IF NOT EXISTS directors (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        email TEXT,
        phone TEXT
      );
      CREATE TABLE IF NOT EXISTS director_assignments (
        id SERIAL PRIMARY KEY,
        director_id INTEGER NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
        camp TEXT NOT NULL,
        UNIQUE(director_id, camp)
      );
      CREATE TABLE IF NOT EXISTS hours_worked (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER NOT NULL REFERENCES staff(id),
        camp TEXT NOT NULL,
        hours NUMERIC(5,2) NOT NULL DEFAULT 0,
        notes TEXT,
        director_id INTEGER REFERENCES directors(id),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(staff_id, camp)
      );
      CREATE TABLE IF NOT EXISTS weekly_ratings (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER NOT NULL REFERENCES staff(id),
        camp TEXT NOT NULL,
        director_id INTEGER REFERENCES directors(id),
        rating INTEGER NOT NULL DEFAULT 3,
        notes TEXT,
        rated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(staff_id, camp, director_id)
      );
      CREATE TABLE IF NOT EXISTS director_availability (
        id SERIAL PRIMARY KEY,
        director_id INTEGER NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
        camp TEXT NOT NULL,
        UNIQUE(director_id, camp)
      );
      CREATE TABLE IF NOT EXISTS staff_notifications (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER NOT NULL REFERENCES staff(id),
        staff_name TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'updated',
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        sent INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Migrations: add columns that may be missing from tables created before schema updates
    await pool.query(`ALTER TABLE directors ADD COLUMN IF NOT EXISTS phone TEXT`);
    await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS confirmed_shift TEXT`);
  }};
} else {
  const Database = require('better-sqlite3');
  const sqlite = new Database('scheduler.db');

  // Migrations
  const reqCols = sqlite.prepare("PRAGMA table_info(requests)").all().map(c => c.name);
  if (reqCols.length > 0 && !reqCols.includes('day')) sqlite.exec('DROP TABLE IF EXISTS requests');
  if (reqCols.length > 0 && !reqCols.includes('confirmed_shift')) sqlite.exec('ALTER TABLE requests ADD COLUMN confirmed_shift TEXT');
  const staffCols = sqlite.prepare("PRAGMA table_info(staff)").all().map(c => c.name);
  if (staffCols.length > 0 && !staffCols.includes('shirt_size')) {
    sqlite.exec('ALTER TABLE staff ADD COLUMN shirt_size TEXT');
    sqlite.exec('ALTER TABLE staff ADD COLUMN shorts_size TEXT');
  }
  if (staffCols.length > 0 && !staffCols.includes('birthdate')) {
    sqlite.exec('ALTER TABLE staff ADD COLUMN birthdate TEXT');
    sqlite.exec('ALTER TABLE staff ADD COLUMN address TEXT');
  }
  const dirCols = sqlite.prepare("PRAGMA table_info(directors)").all().map(c => c.name);
  if (dirCols.length > 0 && !dirCols.includes('phone')) {
    sqlite.exec('ALTER TABLE directors ADD COLUMN phone TEXT');
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT,
      preferred_role TEXT, shirt_size TEXT, shorts_size TEXT,
      birthdate TEXT, address TEXT,
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
    CREATE TABLE IF NOT EXISTS directors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      email TEXT,
      phone TEXT
    );
    CREATE TABLE IF NOT EXISTS director_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      director_id INTEGER NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
      camp TEXT NOT NULL,
      UNIQUE(director_id, camp)
    );
    CREATE TABLE IF NOT EXISTS hours_worked (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id),
      camp TEXT NOT NULL,
      hours REAL NOT NULL DEFAULT 0,
      notes TEXT,
      director_id INTEGER REFERENCES directors(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(staff_id, camp)
    );
    CREATE TABLE IF NOT EXISTS weekly_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL REFERENCES staff(id),
      camp TEXT NOT NULL,
      director_id INTEGER REFERENCES directors(id),
      rating INTEGER NOT NULL DEFAULT 3,
      notes TEXT,
      rated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(staff_id, camp, director_id)
    );
    CREATE TABLE IF NOT EXISTS director_availability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      director_id INTEGER NOT NULL REFERENCES directors(id) ON DELETE CASCADE,
      camp TEXT NOT NULL,
      UNIQUE(director_id, camp)
    );
    CREATE TABLE IF NOT EXISTS staff_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      staff_name TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'updated',
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Wrap sqlite in async-compatible interface
  query = (sql, params = []) => {
    // Convert $1,$2 placeholders to ? for SQLite
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
    sqlite.prepare(converted).run(...params);
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

// Clean URL routes
app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/director', (req, res) => res.sendFile(path.join(__dirname, 'public', 'director.html')));
app.get('/schedule', (req, res) => res.sendFile(path.join(__dirname, 'public', 'schedule.html')));
app.get('/director-signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'director-signup.html')));

// ── Staff Submission ──────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const { name, email, phone, preferred_role, shirt_size, shorts_size, birthdate, address, shifts } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const existing = await query('SELECT id FROM staff WHERE LOWER(email) = LOWER($1)', [email]);
    let staffId;
    if (existing.length > 0) {
      staffId = existing[0].id;
      await query('DELETE FROM requests WHERE staff_id = $1', [staffId]);
      await query(
        'UPDATE staff SET name=$1, phone=$2, preferred_role=$3, shirt_size=$4, shorts_size=$5, birthdate=$6, address=$7, submitted_at=' + (IS_PG ? 'NOW()' : 'CURRENT_TIMESTAMP') + ' WHERE id=$8',
        [name, phone, preferred_role, shirt_size, shorts_size, birthdate, address, staffId]
      );
    } else {
      const rows = await query(
        'INSERT INTO staff (name, email, phone, preferred_role, shirt_size, shorts_size, birthdate, address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [name, email, phone, preferred_role, shirt_size, shorts_size, birthdate, address]
      );
      staffId = rows[0].id;
    }

    if (shifts && shifts.length > 0) {
      for (const s of shifts) {
        await query('INSERT INTO requests (staff_id, camp, day, shift) VALUES ($1,$2,$3,$4)', [staffId, s.camp, s.day, s.shift]);
      }
    }

    const action = existing.length > 0 ? 'updated' : 'new';
    await query(
      'INSERT INTO staff_notifications (staff_id, staff_name, action) VALUES ($1,$2,$3)',
      [staffId, name, action]
    );

    res.json({ ok: true, message: existing.length > 0 ? 'Availability updated!' : 'Submitted successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Internal Notification Endpoints ──────────────────────
app.get('/api/internal/pending-updates', async (req, res) => {
  try {
    const rows = await query(
      'SELECT * FROM staff_notifications WHERE sent = 0 ORDER BY submitted_at ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/internal/mark-sent', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: true, updated: 0 });
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    await query(`UPDATE staff_notifications SET sent = 1 WHERE id IN (${placeholders})`, ids);
    res.json({ ok: true, updated: ids.length });
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

// ── Director Auth ─────────────────────────────────────────
app.post('/api/director/login', async (req, res) => {
  try {
    const { name, password } = req.body;
    if (password !== DIRECTOR_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
    const rows = await query('SELECT * FROM directors WHERE LOWER(name) = LOWER($1)', [name || '']);
    if (!rows.length) return res.status(404).json({ error: 'Director not found. Ask admin to add you.' });
    const dir = rows[0];
    req.session.director = true;
    req.session.directorId = dir.id;
    req.session.directorName = dir.name;
    res.json({ ok: true, director: { id: dir.id, name: dir.name, email: dir.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});
app.post('/api/director/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
function requireDirector(req, res, next) { (req.session.admin || req.session.director) ? next() : res.status(401).json({ error: 'Unauthorized' }); }

// GET /api/director/me
app.get('/api/director/me', requireDirector, async (req, res) => {
  try {
    if (req.session.directorId) {
      const rows = await query('SELECT * FROM directors WHERE id = $1', [req.session.directorId]);
      return res.json(rows[0] || { id: req.session.directorId, name: req.session.directorName, email: '' });
    }
    if (req.session.admin) {
      return res.json({ id: 0, name: 'Admin', email: '' });
    }
    res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Director: confirmed schedule by camp (filtered by assignments for non-admin)
app.get('/api/director/schedule', requireDirector, async (req, res) => {
  try {
    if (req.session.admin) {
      const rows = await query(`
        SELECT r.camp, r.day, r.shift,
               s.name, s.email, s.phone, s.preferred_role, s.shirt_size, s.shorts_size, s.id as staff_id
        FROM requests r
        JOIN staff s ON r.staff_id = s.id
        WHERE r.status = 'confirmed'
        ORDER BY r.camp, s.name, r.day
      `);
      return res.json(rows);
    }
    // Director: get assigned camps first
    const assignments = await query('SELECT camp FROM director_assignments WHERE director_id = $1', [req.session.directorId]);
    if (!assignments.length) return res.json([]);
    const camps = assignments.map(a => a.camp);
    const placeholders = camps.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query(`
      SELECT r.camp, r.day, r.shift,
             s.name, s.email, s.phone, s.preferred_role, s.shirt_size, s.shorts_size, s.id as staff_id
      FROM requests r
      JOIN staff s ON r.staff_id = s.id
      WHERE r.status = 'confirmed' AND r.camp IN (${placeholders})
      ORDER BY r.camp, s.name, r.day
    `, camps);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/director/hours — upsert hours worked
app.post('/api/director/hours', requireDirector, async (req, res) => {
  try {
    const { staff_id, camp, hours, notes } = req.body;
    const directorId = req.session.directorId || null;
    if (IS_PG) {
      await query(`
        INSERT INTO hours_worked (staff_id, camp, hours, notes, director_id, updated_at)
        VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (staff_id, camp) DO UPDATE SET hours=EXCLUDED.hours, notes=EXCLUDED.notes, director_id=EXCLUDED.director_id, updated_at=NOW()
      `, [staff_id, camp, hours, notes || null, directorId]);
    } else {
      await query(`
        INSERT INTO hours_worked (staff_id, camp, hours, notes, director_id)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT(staff_id, camp) DO UPDATE SET hours=excluded.hours, notes=excluded.notes, director_id=excluded.director_id
      `, [staff_id, camp, hours, notes || null, directorId]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/director/hours
app.get('/api/director/hours', requireDirector, async (req, res) => {
  try {
    if (req.session.admin) {
      const rows = await query(`
        SELECT h.staff_id, s.name, h.camp, h.hours, h.notes
        FROM hours_worked h
        JOIN staff s ON h.staff_id = s.id
        ORDER BY h.camp, s.name
      `);
      return res.json(rows);
    }
    const assignments = await query('SELECT camp FROM director_assignments WHERE director_id = $1', [req.session.directorId]);
    if (!assignments.length) return res.json([]);
    const camps = assignments.map(a => a.camp);
    const placeholders = camps.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query(`
      SELECT h.staff_id, s.name, h.camp, h.hours, h.notes
      FROM hours_worked h
      JOIN staff s ON h.staff_id = s.id
      WHERE h.camp IN (${placeholders})
      ORDER BY h.camp, s.name
    `, camps);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/director/rate — upsert weekly rating
app.post('/api/director/rate', requireDirector, async (req, res) => {
  try {
    const { staff_id, camp, rating, notes } = req.body;
    const directorId = req.session.directorId || null;
    if (IS_PG) {
      await query(`
        INSERT INTO weekly_ratings (staff_id, camp, director_id, rating, notes)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (staff_id, camp, director_id) DO UPDATE SET rating=EXCLUDED.rating, notes=EXCLUDED.notes
      `, [staff_id, camp, directorId, rating, notes || null]);
    } else {
      await query(`
        INSERT INTO weekly_ratings (staff_id, camp, director_id, rating, notes)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT(staff_id, camp, director_id) DO UPDATE SET rating=excluded.rating, notes=excluded.notes
      `, [staff_id, camp, directorId, rating, notes || null]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/director/ratings
app.get('/api/director/ratings', requireDirector, async (req, res) => {
  try {
    if (req.session.admin) {
      const rows = await query(`
        SELECT wr.staff_id, s.name, wr.camp, wr.director_id, wr.rating, wr.notes
        FROM weekly_ratings wr
        JOIN staff s ON wr.staff_id = s.id
        ORDER BY wr.camp, s.name
      `);
      return res.json(rows);
    }
    const rows = await query(`
      SELECT wr.staff_id, s.name, wr.camp, wr.director_id, wr.rating, wr.notes
      FROM weekly_ratings wr
      JOIN staff s ON wr.staff_id = s.id
      WHERE wr.director_id = $1
      ORDER BY wr.camp, s.name
    `, [req.session.directorId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

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
      SELECT r.camp, r.day, r.shift, r.confirmed_shift, r.status, r.id as req_id,
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
    const { staff_id, camp, status, confirmed_shift, req_id } = req.body;

    if (req_id) {
      // Per-day update: update a single request row by id
      await query(
        'UPDATE requests SET status = $1, confirmed_shift = $2 WHERE id = $3',
        [status, confirmed_shift || null, req_id]
      );
    } else {
      // Bulk camp update: update all rows for this staff+camp
      // confirmed_shift: 'am'|'pm'|'full' overrides submitted shift; null = use submitted
      await query(
        'UPDATE requests SET status = $1, confirmed_shift = $2 WHERE staff_id = $3 AND camp = $4',
        [status, confirmed_shift || null, staff_id, camp]
      );

      // Auto-decline conflicting camps when confirming:
      if (status === 'confirmed') {
        const datePart = camp.split(' \u00b7 ')[0];
        if (datePart) {
          const rows = await query(
            "SELECT DISTINCT camp FROM requests WHERE staff_id = $1 AND camp != $2 AND status != 'declined'",
            [staff_id, camp]
          );
          const conflicts = rows.filter(r => r.camp.startsWith(datePart + ' \u00b7'));
          for (const conflict of conflicts) {
            await query(
              "UPDATE requests SET status = 'declined' WHERE staff_id = $1 AND camp = $2",
              [staff_id, conflict.camp]
            );
          }
        }
      }
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// One-time backfill: auto-decline conflicts for all already-confirmed staff
app.post('/api/admin/backfill-conflicts', requireAdmin, async (req, res) => {
  try {
    const confirmed = await query("SELECT DISTINCT staff_id, camp FROM requests WHERE status = 'confirmed'");
    let declined = 0;
    for (const { staff_id, camp } of confirmed) {
      const datePart = camp.split(' \u00b7 ')[0];
      if (!datePart) continue;
      const others = await query(
        "SELECT DISTINCT camp FROM requests WHERE staff_id = $1 AND camp != $2 AND status != 'declined'",
        [staff_id, camp]
      );
      const conflicts = others.filter(r => r.camp.startsWith(datePart + ' \u00b7'));
      for (const conflict of conflicts) {
        await query("UPDATE requests SET status = 'declined' WHERE staff_id = $1 AND camp = $2", [staff_id, conflict.camp]);
        declined++;
      }
    }
    res.json({ ok: true, declined });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
        ON CONFLICT(staff_id) DO UPDATE SET rating=excluded.rating, notes=excluded.notes`,
        [staff_id, rating, notes]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Director Availability Signup (public) ────────────────────────────────────
// GET /api/director-signup?email=... → lookup director + their availability
app.get('/api/director-signup', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const rows = await query('SELECT * FROM directors WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const director = rows[0];
    const avail = await query('SELECT camp FROM director_availability WHERE director_id = $1', [director.id]);
    res.json({ director, camps: avail.map(a => a.camp) });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/director-signup → create/update director + availability
app.post('/api/director-signup', async (req, res) => {
  try {
    const { name, email, phone, camps } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    // Upsert director: check by email first, then by name (admin may have added without email)
    let directorId;
    let byEmail = await query('SELECT * FROM directors WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    let byName  = await query('SELECT * FROM directors WHERE LOWER(name)  = LOWER($1)', [name.trim()]);
    const existing = byEmail.length > 0 ? byEmail : byName;
    if (existing.length > 0) {
      directorId = existing[0].id;
      await query('UPDATE directors SET name=$1, email=$2, phone=$3 WHERE id=$4', [name, email.trim(), phone || null, directorId]);
    } else {
      const rows = await query(
        'INSERT INTO directors (name, email, phone) VALUES ($1,$2,$3) RETURNING *',
        [name, email.trim(), phone || null]
      );
      directorId = rows[0].id;
    }
    // Replace availability
    await query('DELETE FROM director_availability WHERE director_id = $1', [directorId]);
    if (camps && camps.length > 0) {
      for (const camp of camps) {
        if (IS_PG) {
          await query('INSERT INTO director_availability (director_id, camp) VALUES ($1,$2) ON CONFLICT DO NOTHING', [directorId, camp]);
        } else {
          await query('INSERT OR IGNORE INTO director_availability (director_id, camp) VALUES ($1,$2)', [directorId, camp]);
        }
      }
    }
    res.json({ ok: true, message: existing.length > 0 ? 'Availability updated!' : 'Submitted successfully!' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Admin: view all director availability
app.get('/api/admin/director-availability', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT da.camp, d.id as director_id, d.name, d.email, d.phone
      FROM director_availability da
      JOIN directors d ON da.director_id = d.id
      ORDER BY da.camp, d.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Admin: Director Management ────────────────────────────
app.get('/api/admin/directors', requireAdmin, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM directors ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/directors', requireAdmin, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const rows = await query(
      'INSERT INTO directors (name, email) VALUES ($1,$2) RETURNING *',
      [name, email || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/directors/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM directors WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/director-assignments', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT da.id, da.camp, da.director_id, d.name as director_name
      FROM director_assignments da
      JOIN directors d ON da.director_id = d.id
      ORDER BY da.camp, d.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/director-assignments', requireAdmin, async (req, res) => {
  try {
    const { director_id, camp } = req.body;
    if (IS_PG) {
      await query(`
        INSERT INTO director_assignments (director_id, camp) VALUES ($1,$2)
        ON CONFLICT (director_id, camp) DO NOTHING
      `, [director_id, camp]);
    } else {
      await query(`
        INSERT OR IGNORE INTO director_assignments (director_id, camp) VALUES ($1,$2)
      `, [director_id, camp]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/director-assignments/:id', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM director_assignments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Staff Schedule (confirmed shifts only) ──────────────────
app.get('/api/staff/schedule', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const rows = await query('SELECT * FROM staff WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const staff = rows[0];
    const confirmed = await query(
      "SELECT camp, day, shift FROM requests WHERE staff_id = $1 AND status = 'confirmed' ORDER BY camp, day",
      [staff.id]
    );
    const pending = await query(
      "SELECT camp, day, shift FROM requests WHERE staff_id = $1 AND status = 'pending' ORDER BY camp, day",
      [staff.id]
    );
    res.json({ name: staff.name, email: staff.email, confirmed, pending });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3579;
db.init().then(() => {
  app.listen(PORT, () => console.log(`Camp Scheduler running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
