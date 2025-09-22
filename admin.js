import express from 'express';
import basicAuth from 'basic-auth';

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
adminRouter.get('/', safe(async (_req, res) => {
  try {
    res.render('admin/dashboard', { message: 'Dashboard ishlaydi!' });
  } catch (e) {
    console.error('Dashboard error:', e.stack);
    res.status(500).send('Dashboard error: ' + e.message);
  }
}));
