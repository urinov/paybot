import express from 'express';
import basicAuth from 'basic-auth';
import { pool } from './db.js';

export const adminRouter = express.Router();

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

// Dashboard
adminRouter.get('/', safe(async (_req, res) => {
  try {
    const [users, buyers, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS c FROM subscribers'),
      pool.query('SELECT COUNT(*)::int AS buyers FROM subscribers WHERE paid_access=TRUE'),
      pool.query('SELECT COALESCE(SUM(amount), 0)::bigint AS sum FROM payments'),
    ]);
    res.render('admin/dashboard', {
      users: users.rows[0]?.c || 0,
      buyers: buyers.rows[0]?.buyers || 0,
      revenue: Number(revenue.rows[0]?.sum || 0) / 100
    });
  } catch (e) {
    console.error('Dashboard error:', e.stack);
    res.status(500).send('Dashboard error: ' + e.message);
  }
}));

// Subscribers
adminRouter.get('/subscribers', safe(async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT chat_id, username, full_name, registered_at, paid_access, paid_via, paid_at, last_order_id, last_amount, access_sent_at
      FROM subscribers
      ORDER BY registered_at DESC LIMIT 2000
    `);
    res.render('admin/subscribers', { subscribers: rows });
  } catch (e) {
    console.error('Subscribers error:', e.stack);
    res.status(500).send('Subscribers error: ' + e.message);
  }
}));

// Broadcast
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

  try {
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
  } catch (e) {
    console.error('Broadcast error:', e.stack);
    res.status(500).send('Broadcast error: ' + e.message);
  }
}));
