// server.js — app init + routerlarni ulash
import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { paymeRouter } from './payme.js';
import { clickRouter } from './click.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parsers
app.use(bodyParser.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Routers
app.use('/payme', paymeRouter);
app.use('/click', clickRouter);

// Static (API'lardan keyin)
app.use(express.static(path.join(__dirname, 'public')));

// 404 JSON (POST)
app.post('*', (req, res) => {
  res.status(404).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: { uz: 'Noto‘g‘ri endpoint' } },
    id: req.body?.id ?? null
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server running on port ' + port));
