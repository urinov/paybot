// admin.js — Admin panel router (EJS views bilan, toza va barqaror)
import express from 'express';
import basicAuth from 'basic-auth';
import { pool, ensureSchema } from './db.js';

export const adminRouter = express.Router();

/* ---------- Diagnostics (authsiz) ---------- */

// DB ping (ulanishni tekshirish)
adminRouter.get('/_pingdb', async (_req, res) => {
  try {
    const r = await pool.query('SELECT now() AS now');
    res.send('DB OK: ' + r.rows[0].now);
  } catch (e) {
    console.error('PING DB ERROR:', e);
    res.status(500).send('DB ERR: ' + (e.message || e.code));
  }
});

// Jadval/migratsiya init (bir martalik fast-fix uchun)
adminRouter.get('/_init', async (_req, res) => {
  try {
    await ensureSchema();
    await pool.query('SELECT COUNT(*) FROM subscribers');
    await pool.query('SELECT COUNT(*) FROM payments');
    res.send('Schema OK ✅ — tables ensured.');
  } catch (e) {
    console.error('INIT ERROR:', e);
    res.status(500).send('INIT ERROR: ' + (e.message || e.code));
  }
});

/* ---------- Auth (Basic) ---------- */

function requireAdmin(req, res, next) {
  const c = basicAuth(req);
  if (!c || c.name !== process.env.ADMIN_USER || c.pass !== process.env.ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth required');
  }
  next();
}
adminRouter.use(requireAdmin);

/* ---------- Helper: xatolarni tozalab ko‘rsatish ---------- */
const safe = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('ADMIN ROUTE ERROR:', e);
    res.status(500).send('Admin error: ' + (e.message || 'unknown'));
  }
};

/* ---------- Routes ---------- */

// Dashboard
adminRouter.get('/', safe(async (_req, res) => {
  const [u, b, r] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM subscribers'),
    pool.query('SELECT COUNT(*)::int AS buyers FROM subscribers WHERE paid_access=TRUE'),
    pool.query('SELECT COALESCE(SUM(amount),0)::bigint AS sum FROM payments'),
  ]);
  res.render('admin/dashboard', {
    users: u.rows[0]?.c || 0,
    buyers: b.rows[0]?.buyers || 0,
    revenue: Number(r.rows[0]?.sum || 0) / 100
  });
}));

// Subscribers (filter + CSV eksport)
adminRouter.get('/subscribers', safe(async (req, res) => {
  const { paid, month, q, export: ex } = req.query;
  const where = [], params = [];

  if (paid === 'paid') where.push('paid_access=TRUE');
  if (paid === 'free') where.push('COALESCE(paid_access,FALSE)=FALSE');
  if (month) { params.push(month); where.push(`to_char(registered_at,'YYYY-MM')=$${params.length}`); }
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    where.push(`(LOWER(username) LIKE $${params.length} OR LOWER(full_name) LIKE $${params.length} OR CAST(chat_id AS TEXT) LIKE $${params.length})`);
  }

  let sql = `
    SELECT chat_id, username, full_name, registered_at,
           paid_access, paid_via, paid_at, last_order_id, last_amount, access_sent_at
    FROM subscribers
  `;
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY registered_at DESC LIMIT 1000';

  const { rows } = await pool.query(sql, params);

  if (ex === 'csv') {
    const cols = Object.keys(rows[0] || {});
    const csv = [cols.join(',')]
      .concat(rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(',')))
      .join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="subscribers.csv"');
    return res.send(csv);
  }

  res.render('admin/subscribers', { rows, paid, month, q });
}));

// Payments (filter + CSV)
adminRouter.get('/payments', safe(async (req, res) => {
  const { month, export: ex } = req.query;
  let sql = `SELECT order_id, chat_id, provider, amount, paid_at FROM payments`;
  const params = [];
  if (month) { sql += ` WHERE to_char(paid_at,'YYYY-MM')=$1`; params.push(month); }
  sql += ` ORDER BY paid_at DESC LIMIT 2000`;

  const { rows } = await pool.query(sql, params);

  if (ex === 'csv') {
    const cols = Object.keys(rows[0] || {});
    const csv = [cols.join(',')]
      .concat(rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(',')))
      .join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="payments.csv"');
    return res.send(csv);
  }

  res.render('admin/payments', { rows, month });
}));

// Broadcast (segmentli rassilka)
adminRouter.get('/broadcast', (_req, res) =>
  res.render('admin/broadcast', { ok:null, fail:null, total:null })
);

adminRouter.post('/broadcast', express.urlencoded({ extended: true }), safe(async (req, res) => {
  const { segment, month, text } = req.body;
  if (!text?.trim()) return res.status(400).send('Matn bo‘sh');

  let sql = '', params = [];
  if (segment === 'buyers_all') {
    sql = `SELECT chat_id FROM subscribers WHERE paid_access=TRUE`;
  } else if (segment === 'buyers_month' && month) {
    sql = `SELECT chat_id FROM subscribers WHERE paid_access=TRUE AND to_char(paid_at,'YYYY-MM')=$1`; params=[month];
  } else if (segment === 'users_not_bought') {
    sql = `SELECT chat_id FROM subscribers WHERE COALESCE(paid_access,FALSE)=FALSE`;
  } else if (segment === 'interested_month' && month) {
    sql = `SELECT chat_id FROM subscribers
           WHERE COALESCE(paid_access,FALSE)=FALSE AND to_char(registered_at,'YYYY-MM')=$1`; params=[month];
  } else {
    return res.status(400).send('Noto‘g‘ri segment');
  }

  const { rows } = await pool.query(sql, params);
  const API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`;

  let ok = 0, fail = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: rows[i].chat_id, text })
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.description || 'tg err');
      ok++;
    } catch {
      fail++;
    }
    if (i % 30 === 29) await new Promise(r => setTimeout(r, 1000)); // 30/s throttling
  }

  res.render('admin/broadcast', { ok, fail, total: rows.length });
}));
