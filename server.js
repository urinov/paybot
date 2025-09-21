// server.js — barchasini bog'laydi (admin, DB, webhooklar, payment prefikslar)
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import ejsLayouts from 'express-ejs-layouts';

import paymeRouter from './payme.js';
import clickRouter from './click.js';
import { bot } from './telegram.js';

import { ensureSchema } from './db.js';
import { adminRouter } from './admin.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// Parsers + static
app.use(bodyParser.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// Views (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(ejsLayouts);

// Health
app.get('/health', (_, res) => res.send('ok'));
app.get('/',       (_, res) => res.send('OK'));

// Telegram webhook endpoint (idempotent)
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

// Admin panel (Basic Auth bilan himoyalangan)
app.use('/admin', adminRouter);

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log('Server listening on', port);

  // DB sxemasini tayyorlash (mavjud oqimni buzmaydi)
  try { await ensureSchema(); } catch (e) { console.error('ensureSchema error', e); }

  // Telegram webhook set
  if (process.env.BASE_URL) {
    try {
      await bot.telegram.setWebhook(`${process.env.BASE_URL}/telegram/webhook`);
      console.log('Webhook set ->', `${process.env.BASE_URL}/telegram/webhook`);
    } catch (e) { console.error('setWebhook error', e); }
  }
});
