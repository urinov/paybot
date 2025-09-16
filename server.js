// server.js — barchasini bog'laydi va prefikslarni to'g'ri o'rnatadi
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { bus } from './events.js';


import paymeRouter from './payme.js';
import clickRouter from './click.js';
import { bot } from './telegram.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events: /admin/api/events
app.get('/admin/api/events', basicAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('\n');

  const onPaid = (payload) => {
    res.write(`event: paid\ndata:${JSON.stringify(payload)}\n\n`);
  };
  bus.on('paid', onPaid);

  req.on('close', () => bus.off('paid', onPaid));
});

// Health
app.get('/health', (_, res) => res.send('ok'));
app.get('/',       (_, res) => res.send('OK'));

// --- ADMIN AUTH (Basic) ---
function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).send('Auth required');
}
function basicAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const [scheme, cred] = hdr.split(' ');
  if (scheme !== 'Basic' || !cred) return unauthorized(res);
  const [user, pass] = Buffer.from(cred, 'base64').toString().split(':');
  if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) return next();
  return unauthorized(res);
}

// Static dashboard files (quyida yaratamiz)
app.use('/admin', basicAuth, express.static('public/admin'));


// Telegram webhook endpoint
app.post('/telegram/webhook', (req, res) => {
  bot.handleUpdate(req.body)
    .then(() => res.sendStatus(200))
    .catch((e) => { console.error('bot.handleUpdate error', e); res.sendStatus(500); });
});

/** MUHIM: Prefikslar.
 *  paymeRouter ichidagi '/api/...' va '/' endi '/payme/...' ostida ishlaydi
 *  clickRouter ichidagi '/api/...' va '/callback' endi '/click/...' ostida ishlaydi
 */
app.use('/payme', paymeRouter);
app.use('/click', clickRouter);

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log('Server listening on', port);
  if (process.env.BASE_URL) {
    try {
      await bot.telegram.setWebhook(`${process.env.BASE_URL}/telegram/webhook`);
      console.log('Webhook set ->', `${process.env.BASE_URL}/telegram/webhook`);
    } catch (e) { console.error('setWebhook error', e); }
  }
});
