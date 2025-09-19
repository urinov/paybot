// store.js — Postgres persistent storage (drop-in replacement)
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[store] DATABASE_URL yo‘q. Postgres ulanmaydi.');
}
export const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // Render SSL
    })
  : null;

// ------- Backward-compat shims -------
/** Eski kod uchun: in-memory Orders Map o‘rniga stub.
 *  Hech kim foydalanmaydi, lekin import bo‘lgani uchun xato bermasin. */
export const Orders = null;

/** Eski kodga mos: sync order_id generator (text).
 *  Kolliziyani minimallashtirish uchun vaqt + 3 xonali random. */
export function nextOrderId() {
  const ms = Date.now();
  const rnd = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${ms}${rnd}`; // masalan: "1726735600123005"
}

// ------- Helpers -------
function toDateOrNull(ms) {
  return ms ? new Date(Number(ms)) : null;
}
function toMsOrNull(dt) {
  return dt ? new Date(dt).getTime() : null;
}

// ------- Schema -------
export async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id BIGINT PRIMARY KEY,
      username TEXT,
      full_name TEXT,
      status TEXT DEFAULT 'lead',           -- 'lead'|'paid'
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ,
      channel_id BIGINT,
      channel_joined_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      tg_id BIGINT NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,              -- 'payme'|'click'
      amount INTEGER NOT NULL,             -- tiyinda
      state SMALLINT NOT NULL DEFAULT 1,   -- 1=pending,2=performed
      transaction_id TEXT,
      create_time TIMESTAMPTZ NOT NULL DEFAULT now(),
      perform_time TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_orders_tg_id ON orders(tg_id);
    CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
    CREATE INDEX IF NOT EXISTS idx_orders_ptime ON orders(perform_time);
  `);
  console.log('[store] Schema ensured');
}

// ------- Users -------
export async function upsertUser({ tg_id, username = null, full_name = null }) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO users (tg_id, username, full_name)
    VALUES ($1,$2,$3)
    ON CONFLICT (tg_id) DO UPDATE
      SET username = COALESCE(EXCLUDED.username, users.username),
          full_name = COALESCE(EXCLUDED.full_name, users.full_name),
          updated_at = now()
  `,
    [tg_id, username, full_name]
  );
}

export async function markChannelJoined({ tg_id, channel_id, joined_at }) {
  if (!pool) return;
  await pool.query(
    `
    UPDATE users
       SET channel_id = $2,
           channel_joined_at = $3,
           updated_at = now()
     WHERE tg_id = $1
  `,
    [tg_id, channel_id, toDateOrNull(joined_at)]
  );
}

// ------- Orders -------
export async function logOrderCreated({
  order_id,
  tg_id,
  provider,
  amount,
  create_time,
}) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO users (tg_id) VALUES ($1)
    ON CONFLICT (tg_id) DO NOTHING
  `,
    [tg_id]
  );

  await pool.query(
    `
    INSERT INTO orders (order_id, tg_id, provider, amount, state, create_time)
    VALUES ($1, $2, $3, $4, 1, COALESCE($5, now()))
    ON CONFLICT (order_id) DO NOTHING
  `,
    [order_id, tg_id, provider, amount, toDateOrNull(create_time)]
  );
}

export async function markOrderPerformed({
  order_id,
  perform_time,
  transaction_id,
}) {
  if (!pool) return;
  const { rows } = await pool.query(
    `
    UPDATE orders
       SET state = 2,
           perform_time = COALESCE($2, now()),
           transaction_id = COALESCE($3, transaction_id)
     WHERE order_id = $1
     RETURNING tg_id, amount, provider, perform_time
  `,
    [order_id, toDateOrNull(perform_time), transaction_id]
  );

  if (rows.length) {
    const { tg_id, perform_time: pt } = rows[0];
    await pool.query(
      `
      UPDATE users
         SET status = 'paid',
             paid_at = COALESCE($2, now()),
             updated_at = now()
       WHERE tg_id = $1
    `,
      [tg_id, pt]
    );
  }
}

// ------- Reads (admin API) -------
export async function listUsers() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT * FROM users ORDER BY created_at DESC`
  );
  return rows.map((r) => ({
    tg_id: Number(r.tg_id),
    username: r.username,
    full_name: r.full_name,
    status: r.status,
    joined_at: toMsOrNull(r.joined_at),
    paid_at: toMsOrNull(r.paid_at),
    channel_id: r.channel_id ? Number(r.channel_id) : null,
    channel_joined_at: toMsOrNull(r.channel_joined_at),
    created_at: toMsOrNull(r.created_at),
    updated_at: toMsOrNull(r.updated_at),
  }));
}

export async function listOrders() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT * FROM orders ORDER BY create_time DESC`
  );
  return rows.map((r) => ({
    order_id: r.order_id,
    tg_id: Number(r.tg_id),
    provider: r.provider,
    amount: Number(r.amount),
    state: Number(r.state),
    transaction_id: r.transaction_id,
    create_time: toMsOrNull(r.create_time),
    perform_time: toMsOrNull(r.perform_time),
  }));
}

// Modul import qilinganda schema yaratilishini ta'minlaymiz
ensureSchema().catch((e) => console.error('[store] ensureSchema error', e));
