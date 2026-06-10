const express = require('express');
const session = require('express-session');
const path = require('path');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const IS_PG = !!process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'nikesoccer2025';
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || 'director2026';
const BASE_URL = process.env.BASE_URL || 'https://camp-scheduler-tg11.onrender.com';

// Shift time labels
function shiftLabel(shift) {
  switch ((shift || '').toLowerCase()) {
    case 'am':   return 'AM (8am–12pm)';
    case 'pm':   return 'PM (12pm–4pm)';
    case 'full': return 'Full Day (8am–4pm)';
    default:     return shift || '';
  }
}

// Director role labels
function directorRoleLabel(role) {
  switch ((role || '').toLowerCase()) {
    case 'admin':  return 'Admin Director (7:45am–3:45pm)';
    case 'skills': return 'Skills Director (8am–4pm)';
    default:       return role || 'Director';
  }
}

// ── Email transport (Resend, with nodemailer fallback) ───────────
const GMAIL_USER = process.env.GMAIL_USER || 'rich.seattlesoccer@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Nike Soccer Camps <noreply@coachrichsoccer.com>';

// Prefer Resend; fall back to nodemailer if Resend not configured
let resendClient = null;
if (RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(RESEND_API_KEY);
    console.log('Resend email configured ✓');
  } catch (e) { console.warn('Resend load error:', e.message); }
}
const emailTransport = (!resendClient && GMAIL_APP_PASSWORD) ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
}) : null;

async function sendConfirmationEmail(staffName, staffEmail, camp, token, shift) {
  const link = `${BASE_URL}/staff-confirm?token=${token}`;
  const html = `
    <p>Hi ${staffName},</p>
    <p>Your schedule for <strong>${camp}</strong> has been set. Please click the button below to confirm you'll be there.</p>
    <p style="margin:24px 0">
      <a href="${link}" style="background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;font-size:1rem">View &amp; Confirm My Schedule</a>
    </p>
    <p style="color:#888;font-size:0.85rem">Or copy this link: ${link}</p>
    <p style="color:#555;font-size:0.9rem"><em>Note: This confirmation is for <strong>${camp}</strong> only. You may be assigned to additional camps — you'll receive a separate email for each one.</em></p>
    <p>Questions? Reply to this email or contact Rich directly.</p>
    <p>Thanks,<br>Rich Schreiner<br>Nike Soccer Camps</p>
  `;
  if (resendClient) {
    const { error } = await resendClient.emails.send({
      from: RESEND_FROM,
      to: staffEmail,
      subject: `Please confirm your schedule — ${camp}`,
      html
    });
    if (error) throw new Error(`Resend error: ${error.message}`);
    return true;
  } else if (emailTransport) {
    await emailTransport.sendMail({
      from: `"Nike Soccer Camps" <${GMAIL_USER}>`,
      to: staffEmail,
      subject: `Please confirm your schedule — ${camp}`,
      html
    });
    return true;
  } else {
    console.warn('No email transport configured — skipping email');
    return false;
  }
}

// ── Twilio SMS transport ──────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('Twilio SMS configured ✓');
  } catch (e) {
    console.warn('Twilio load error:', e.message);
  }
}

async function sendConfirmationSMS(staffPhone, camp, token) {
  if (!twilioClient || !staffPhone) return false;
  const link = `${BASE_URL}/staff-confirm?token=${token}`;
  // Normalize to E.164
  const digits = staffPhone.replace(/\D/g, '');
  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  await twilioClient.messages.create({
    body: `Nike Soccer Camps: You're confirmed for ${camp}. View & confirm your schedule: ${link}`,
    from: TWILIO_FROM_NUMBER,
    to: e164
  });
  return true;
}

// SMS-first: try SMS, always send email as backup
async function sendConfirmationNotification(staffName, staffEmail, staffPhone, camp, token, shift) {
  const result = { smsSent: false, emailSent: false };
  // 1. SMS (primary)
  if (staffPhone && twilioClient) {
    try {
      result.smsSent = await sendConfirmationSMS(staffPhone, camp, token);
    } catch (e) {
      console.error('SMS error:', e.message);
    }
  }
  // 2. Email (always send as backup / for record-keeping)
  if (staffEmail) {
    try {
      result.emailSent = await sendConfirmationEmail(staffName, staffEmail, camp, token, shift);
    } catch (e) {
      console.error('Email error:', e.message);
    }
  }
  if (!result.smsSent && !result.emailSent) {
    console.warn(`No notification sent for ${staffName} / ${camp} — no SMS config and no email transport`);
  }
  return result;
}

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
    await pool.query(`ALTER TABLE director_assignments ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'skills'`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_confirmations (
        id SERIAL PRIMARY KEY,
        staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        camp TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        confirmed_at TIMESTAMP,
        email_sent_at TIMESTAMP,
        sms_sent_at TIMESTAMP,
        UNIQUE(staff_id, camp)
      )
    `);
    await pool.query(`ALTER TABLE staff_confirmations ADD COLUMN IF NOT EXISTS sms_sent_at TIMESTAMP`);
    // Allow multiple directors per camp per role — drop camp+role unique, enforce director+camp unique
    await pool.query(`ALTER TABLE director_assignments DROP CONSTRAINT IF EXISTS director_assignments_camp_role_key`);
    await pool.query(`
      DO $$ BEGIN
        ALTER TABLE director_assignments ADD CONSTRAINT director_assignments_director_id_camp_key UNIQUE (director_id, camp);
      EXCEPTION WHEN duplicate_table THEN NULL;
      END $$;
    `);
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
        SELECT r.camp, r.day, r.shift, r.confirmed_shift,
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
      SELECT r.camp, r.day, r.shift, r.confirmed_shift,
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

      // When confirming: generate/send confirmation (SMS-first, email backup)
      if (status === 'confirmed') {
        const staffRows = await query(
          'SELECT s.name, s.email, s.phone, r.confirmed_shift, r.shift FROM staff s JOIN requests r ON r.staff_id = s.id WHERE s.id = $1 AND r.camp = $2 LIMIT 1',
          [staff_id, camp]
        );
        if (staffRows.length) {
          const { name, email, phone } = staffRows[0];
          const shift = staffRows[0].confirmed_shift || staffRows[0].shift;
          const token = uuidv4();
          if (IS_PG) {
            await query(`
              INSERT INTO staff_confirmations (staff_id, camp, token, email_sent_at, sms_sent_at)
              VALUES ($1, $2, $3, NULL, NULL)
              ON CONFLICT (staff_id, camp) DO UPDATE SET token = EXCLUDED.token, confirmed = FALSE, confirmed_at = NULL, email_sent_at = NULL, sms_sent_at = NULL
            `, [staff_id, camp, token]);
          }
          sendConfirmationNotification(name, email, phone, camp, token, shift).then(async ({ smsSent, emailSent }) => {
            if (IS_PG) {
              await query(
                'UPDATE staff_confirmations SET email_sent_at = CASE WHEN $1 THEN NOW() ELSE email_sent_at END, sms_sent_at = CASE WHEN $2 THEN NOW() ELSE sms_sent_at END WHERE staff_id = $3 AND camp = $4',
                [emailSent, smsSent, staff_id, camp]
              );
            }
          }).catch(e => console.error('Notification error:', e));
        }
      }

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

app.patch('/api/admin/directors/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    await query(`UPDATE directors SET
      name  = COALESCE($1, name),
      email = COALESCE($2, email),
      phone = COALESCE($3, phone)
      WHERE id = $4`, [name||null, email||null, phone||null, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, shirt_size, shorts_size, address } = req.body;
    await query(`UPDATE staff SET
      name        = COALESCE($1, name),
      email       = COALESCE($2, email),
      phone       = COALESCE($3, phone),
      shirt_size  = COALESCE($4, shirt_size),
      shorts_size = COALESCE($5, shorts_size),
      address     = COALESCE($6, address)
      WHERE id = $7`, [name||null, email||null, phone||null, shirt_size||null, shorts_size||null, address||null, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/staff/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await query('DELETE FROM staff_confirmations WHERE staff_id = $1', [id]);
    await query('DELETE FROM hours_worked WHERE staff_id = $1', [id]);
    await query('DELETE FROM requests WHERE staff_id = $1', [id]);
    await query('DELETE FROM staff WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/director-assignments', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT da.id, da.camp, da.director_id, da.role, d.name as director_name
      FROM director_assignments da
      JOIN directors d ON da.director_id = d.id
      ORDER BY da.camp, da.role
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/director-assignments', requireAdmin, async (req, res) => {
  try {
    const { director_id, camp, role } = req.body;
    const safeRole = (role === 'admin' || role === 'skills') ? role : 'skills';
    if (IS_PG) {
      await query(`
        INSERT INTO director_assignments (director_id, camp, role) VALUES ($1,$2,$3)
        ON CONFLICT (director_id, camp) DO UPDATE SET role = EXCLUDED.role
      `, [director_id, camp, safeRole]);
    } else {
      await query(`
        INSERT OR REPLACE INTO director_assignments (director_id, camp, role) VALUES ($1,$2,$3)
      `, [director_id, camp, safeRole]);
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

// Serve staff-confirm page
app.get('/staff-confirm', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff-confirm.html'));
});

// ── Staff Confirmation (public, token-based) ────────────────────────
// GET /api/staff-confirm?token=xxx — returns staff name, camp, and schedule
app.get('/api/staff-confirm', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const rows = await query(`
      SELECT sc.confirmed, sc.confirmed_at, sc.camp, sc.staff_id,
             s.name, s.email,
             r.day, r.shift, r.confirmed_shift
      FROM staff_confirmations sc
      JOIN staff s ON sc.staff_id = s.id
      JOIN requests r ON r.staff_id = sc.staff_id AND r.camp = sc.camp AND r.status = 'confirmed'
      WHERE sc.token = $1
      ORDER BY r.day
    `, [token]);
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    const { confirmed, confirmed_at, camp, name, email } = rows[0];
    const schedule = rows.map(r => ({ day: r.day, shift: r.confirmed_shift || r.shift }));
    res.json({ name, email, camp, confirmed, confirmed_at, schedule });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/staff-confirm — staff confirms their schedule
app.post('/api/staff-confirm', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const rows = await query('SELECT id FROM staff_confirmations WHERE token = $1', [token]);
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    await query(
      'UPDATE staff_confirmations SET confirmed = TRUE, confirmed_at = NOW() WHERE token = $1',
      [token]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/confirmations — all staff confirmation statuses
app.get('/api/admin/confirmations', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT sc.staff_id, sc.camp, sc.confirmed, sc.confirmed_at, sc.email_sent_at, sc.sms_sent_at, sc.token, s.name, s.email, s.phone
      FROM staff_confirmations sc
      JOIN staff s ON sc.staff_id = s.id
      ORDER BY sc.camp, s.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/send-all-confirmations — bulk send confirmation emails to all confirmed staff
app.post('/api/admin/send-all-confirmations', requireAdmin, async (req, res) => {
  try {
    const { camp: campFilter } = req.body || {};
    // Get confirmed staff+camp combos, optionally filtered by camp
    const rows = campFilter
      ? await query(`
          SELECT DISTINCT ON (r.staff_id, r.camp) r.staff_id, r.camp, s.name, s.email, s.phone, r.confirmed_shift, r.shift
          FROM requests r
          JOIN staff s ON r.staff_id = s.id
          WHERE r.status = 'confirmed' AND r.camp = $1
          ORDER BY r.staff_id, r.camp, s.name
        `, [campFilter])
      : await query(`
          SELECT DISTINCT ON (r.staff_id, r.camp) r.staff_id, r.camp, s.name, s.email, s.phone, r.confirmed_shift, r.shift
          FROM requests r
          JOIN staff s ON r.staff_id = s.id
          WHERE r.status = 'confirmed'
          ORDER BY r.staff_id, r.camp, r.camp, s.name
        `);
    if (!rows.length) return res.json({ ok: true, sent: 0, message: 'No confirmed staff found' });
    let sent = 0, smsSent = 0, emailSent = 0;
    let errors = [];
    for (const row of rows) {
      try {
        const token = uuidv4();
        if (IS_PG) {
          await query(`
            INSERT INTO staff_confirmations (staff_id, camp, token, email_sent_at, sms_sent_at)
            VALUES ($1, $2, $3, NULL, NULL)
            ON CONFLICT (staff_id, camp) DO UPDATE SET token = EXCLUDED.token, confirmed = FALSE, confirmed_at = NULL, email_sent_at = NULL, sms_sent_at = NULL
          `, [row.staff_id, row.camp, token]);
        }
        const shift = row.confirmed_shift || row.shift;
        const result = await sendConfirmationNotification(row.name, row.email, row.phone, row.camp, token, shift);
        if (IS_PG) {
          await query(
            'UPDATE staff_confirmations SET email_sent_at = CASE WHEN $1 THEN NOW() ELSE email_sent_at END, sms_sent_at = CASE WHEN $2 THEN NOW() ELSE sms_sent_at END WHERE staff_id = $3 AND camp = $4',
            [result.emailSent, result.smsSent, row.staff_id, row.camp]
          );
        }
        if (result.smsSent) smsSent++;
        if (result.emailSent) emailSent++;
        sent++;
      } catch (e) {
        errors.push(`${row.name} / ${row.camp}: ${e.message}`);
      }
    }
    res.json({ ok: true, sent, smsSent, emailSent, total: rows.length, errors });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/resend-confirmation — resend confirmation email for a staff+camp
app.post('/api/admin/resend-confirmation', requireAdmin, async (req, res) => {
  try {
    const { staff_id, camp } = req.body;
    const staffRows = await query(
      'SELECT s.name, s.email, s.phone, r.confirmed_shift, r.shift FROM staff s JOIN requests r ON r.staff_id = s.id WHERE s.id = $1 AND r.camp = $2 LIMIT 1',
      [staff_id, camp]
    );
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const { name, email, phone } = staffRows[0];
    const shift = staffRows[0].confirmed_shift || staffRows[0].shift;
    const token = uuidv4();
    if (IS_PG) {
      await query(`
        INSERT INTO staff_confirmations (staff_id, camp, token, email_sent_at, sms_sent_at)
        VALUES ($1, $2, $3, NULL, NULL)
        ON CONFLICT (staff_id, camp) DO UPDATE SET token = EXCLUDED.token, confirmed = FALSE, confirmed_at = NULL, email_sent_at = NULL, sms_sent_at = NULL
      `, [staff_id, camp, token]);
    }
    sendConfirmationNotification(name, email, phone, camp, token, shift).then(async ({ smsSent, emailSent }) => {
      if (IS_PG) {
        await query(
          'UPDATE staff_confirmations SET email_sent_at = CASE WHEN $1 THEN NOW() ELSE email_sent_at END, sms_sent_at = CASE WHEN $2 THEN NOW() ELSE sms_sent_at END WHERE staff_id = $3 AND camp = $4',
          [emailSent, smsSent, staff_id, camp]
        );
      }
    }).catch(e => console.error('Notification error:', e));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/pending-sms — confirmed staff with no SMS sent yet (phone required)
app.get('/api/admin/pending-sms', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT sc.staff_id, sc.camp, sc.token, s.name, s.phone
      FROM staff_confirmations sc
      JOIN staff s ON sc.staff_id = s.id
      WHERE sc.email_sent_at IS NOT NULL
        AND sc.sms_sent_at IS NULL
        AND s.phone IS NOT NULL
        AND s.phone != ''
      ORDER BY sc.camp, s.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /api/admin/mark-sms-sent — mark SMS as sent for a staff+camp
app.post('/api/admin/mark-sms-sent', requireAdmin, async (req, res) => {
  try {
    const { staff_id, camp } = req.body;
    await query(
      'UPDATE staff_confirmations SET sms_sent_at = NOW() WHERE staff_id = $1 AND camp = $2',
      [staff_id, camp]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3579;
db.init().then(() => {
  app.listen(PORT, () => console.log(`Camp Scheduler running on port ${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
