import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { adminRouter } from './admin.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Views (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/admin', adminRouter);

app.get('/', (req, res) => {
  res.send('Server ishlayapti!');
});

app.use((req, res) => res.status(404).send('Not Found'));

app.use((err, req, res, _next) => {
  console.error('UNCAUGHT ERROR:', err.stack);
  res.status(500).send('Internal Server Error');
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log('Server listening on', port);
});
