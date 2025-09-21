// server.js — admin, DB, webhooklar, payment prefikslar
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

// Render/NGINX ortidan kelayotgan IP'lar uchun kerak
app.set('trust proxy', 1);

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
app.post('/telegram/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error('bot.handleUpdate error', e);
    res.sendStatus(500);
  }
});

/** MUHIM: Prefikslar.
 *  paymeRouter ichidagi '/api/...' va '/' endi '/payme/...' ostida ishlaydi
 *  clickRouter ichidagi '/api/...' va '/callback' endi '/click/...' ostida ishlaydi
 */
app.use('/payme', paymeRouter);
app.use('/click', clickRouter);

// Admin panel (Basic Auth bilan himoyalangan)
app.use('/admin', adminRouter);

// 404 (boshqa routelar topilmasa)
app.use((req, res) => res.status(404).send('Not Found'));

// 500 — yakuniy error handler (sahifaga text qaytaradi, logga to‘liq xato)
app.use((err, req, res, _next) => {
  console.error('UNCAUGHT ERROR:', err);
  res.status(500).send('Internal Server Error');
});

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log('Server listening on', port);

  // DB sxemasini tayyorlash (mavjud oqimni buzmaydi)
  try {
    await ensureSchema();
    console.log('DB schema ensured');
  } catch (e) {
    console.error('ensureSchema error', e);
  }

  // Telegram webhook set
  if (process.env.BASE_URL) {
    const url = `${process.env.BASE_URL}/telegram/webhook`;
    try {
      await bot.telegram.setWebhook(url);
      console.log('Webhook set ->', url);
    } catch (e) {
      console.error('setWebhook error', e);
    }
  }
});
