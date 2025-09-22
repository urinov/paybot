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
const __dirname = path.dirname(__filename);

const app = express();

// Render/NGINX ortidan kelayotgan IP'lar uchun
app.set('trust proxy', 1);

// Parsers + static
app.use(bodyParser.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/static', express.static(path.join(__dirname, 'public')));

// Views (EJS)
app.set('view engine', 'ejs'); // EJS engine ni aniq belgilash
app.set('views', path.join(__dirname, 'views')); // Views papkasi manzili
app.use(ejsLayouts); // Layoutlarni ishlatish

// Health
app.get('/health', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.send('OK'));

// Telegram webhook endpoint
app.post('/telegram/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error('bot.handleUpdate error', e.stack);
    res.sendStatus(500);
  }
});

app.use('/payme', paymeRouter);
app.use('/click', clickRouter);
app.use('/admin', adminRouter);

app.use((req, res) => res.status(404).send('Not Found'));

app.use((err, req, res, _next) => {
  console.error('UNCAUGHT ERROR:', err.stack);
  res.status(500).send('Internal Server Error');
});

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log('Server listening on', port);
  try {
    await ensureSchema();
    console.log('DB schema ensured');
  } catch (e) {
    console.error('ensureSchema error', e.stack);
  }
  if (process.env.BASE_URL) {
    const url = `${process.env.BASE_URL}/telegram/webhook`;
    try {
      await bot.telegram.setWebhook(url);
      console.log('Webhook set ->', url);
    } catch (e) {
      console.error('setWebhook error', e.stack);
    }
  }
});
