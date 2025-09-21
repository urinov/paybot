// db.js
import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL ? { rejectUnauthorized: false } : false,
});

export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id         BIGINT PRIMARY KEY,
      username        TEXT,
      full_name       TEXT,
      registered_at   TIMESTAMPTZ DEFAULT now(),
      paid_access     BOOLEAN DEFAULT FALSE,
      paid_via        TEXT,
      paid_at         TIMESTAMPTZ,
      last_order_id   TEXT,
      last_amount     BIGINT,
      access_sent_at  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS payments (
      id        BIGSERIAL PRIMARY KEY,
      order_id  TEXT,
      chat_id   BIGINT,
      provider  TEXT,
      amount    BIGINT,
      paid_at   TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS joins (
      id         BIGSERIAL PRIMARY KEY,
      chat_id    BIGINT,
      channel_id BIGINT,
      joined_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id        BIGSERIAL PRIMARY KEY,
      provider  TEXT,
      level     TEXT,
      payload   JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}
