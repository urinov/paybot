import express from 'express';
import basicAuth from 'basic-auth';
import { pool, ensureSchema } from './db.js';

export const adminRouter = express.Router();

/* ---------- Diagnostics (authsiz) ---------- */
adminRouter.get('/_pingdb', async (_req, res) => {
  try {
    const r = await pool.query('SELECT now() AS now');
    res.send('DB OK: ' + r.rows[0].now);
  } catch (e) {
    console.error('PING DB ERROR:', e.stack);
    res.status(500).send('DB ERR: ' + (e.message || e.code));
  }
});

adminRouter.get('/_init', async (_req, res) => {
  try {
    await ensureSchema();
    await pool.query('SELECT COUNT(*) FROM subscribers');
    await pool.query('SELECT COUNT(*) FROM payments');
    res.send('Schema OK ✅ — tables ensured.');
  } catch (e) {
    console.error('INIT ERROR:', e.stack);
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

/* ---------- Helper ---------- */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error('ADMIN ROUTE ERROR:', e.stack);
    res.status(500).send('Admin error: ' + e.message);
  }
};

/* ---------- Routes ---------- */
adminRouter.get('/', safe(async (_req, res) => {
  try {
    const result = await pool.query('SELECT now() AS server_time'); // Sinov so‘rovi
    res.render('admin/dashboard', {
      serverTime: result.rows[0].server_time.toISOString()
    });
  } catch (e) {
    console.error('Dashboard error:', e.stack);
    res.status(500).send('Dashboard error: ' + e.message);
  }
}));

adminRouter.get('/subscribers', safe(async (req, res) => {
  const { paid, month, q, export: ex } = req.query;
  let sql = 'SELECT * FROM subscribers';
  const params = [];

  if (paid) {
    sql += ' WHERE paid_access = $1';
    params.push(paid === 'true');
  }
  if (month) {
    sql += (params.length ? ' AND' : ' WHERE') + ' to_char(registered_at, \'YYYY-MM\') = $' + (params.length + 1);
    params.push(month);
  }
  if (q) {
    sql += (params.length ? ' AND' : ' WHERE') + ' (username ILIKE $' + (params.length + 1) + ' OR full_name ILIKE $' + (params.length + 1) + ')';
    params.push(`%${q}%`);
  }
  sql += ' ORDER BY registered_at DESC LIMIT 2000';

  const { rows } = await pool.query(sql, params);

  if (ex === 'csv') {
    const cols = Object.keys(rows[0] || {});
    const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="subscribers.csv"');
    return res.send(csv);
  }

  res.render('admin/subscribers', { rows, paid, month, q });
}));

adminRouter.get('/payments', safe(async (req, res) => {
  const { month, export: ex } = req.query;
  let sql = 'SELECT * FROM payments';
  const params = [];

  if (month) {
    sql += ' WHERE to_char(paid_at, \'YYYY-MM\') = $1';
    params.push(month);
  }
  sql += ' ORDER BY paid_at DESC LIMIT 2000';

  const { rows } = await pool.query(sql, params);

  if (ex === 'csv') {
    const cols = Object.keys(rows[0] || {});
    const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    return res.send(csv);
  }

  res.render('admin/payments', { rows, month });
}));

adminRouter.get('/broadcast', (_req, res) =>
  res.render('admin/broadcast', { ok: null, fail: null, total: null })
);

adminRouter.post('/broadcast', express.urlencoded({ extended: true }), safe(async (req, res) => {
  const { segment, month, text } = req.body;
  if (!text?.trim()) return res.status(400).send('Matn bo‘sh');

  let sql = '', params = [];
  if (segment === 'buyers_all') {
    sql = 'SELECT chat_id FROM subscribers WHERE paid_access=TRUE';
  } else if (segment === 'buyers_month' && month) {
    sql = 'SELECT chat_id FROM subscribers WHERE paid_access=TRUE AND to_char(paid_at, \'YYYY-MM\')=$1';
    params = [month];
  } else if (segment === 'users_not_bought') {
    sql = 'SELECT chat_id FROM subscribers WHERE COALESCE(paid_access, FALSE)=FALSE';
  } else if (segment === 'interested_month' && month) {
    sql = 'SELECT chat_id FROM subscribers WHERE COALESCE(paid_access, FALSE)=FALSE AND to_char(registered_at, \'YYYY-MM\')=$1';
    params = [month];
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
    if (i % 30 === 29) await new Promise(r => setTimeout(r, 1000));
  }

  res.render('admin/broadcast', { ok, fail, total: rows.length });
}));
