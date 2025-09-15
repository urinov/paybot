// payme.js — Payme JSON-RPC + Checkout helper (ESM)
import { Router } from 'express';
import { orders, nextOrderId } from './store.js';
import { sendTelegramLink } from './telegram.js';

export const paymeRouter = Router();

/* ------------------------- JSON-RPC helpers ------------------------- */
const ok = (id, result) => ({ jsonrpc: '2.0', result, id });

// Payme talabiga ko'ra error.message => string YOKI {ru,en,uz} obyekt bo'lishi shart.
// Shu helper har doim 3 tilni to'ldirib qaytaradi.
const normalizeMsg = (msg) => {
  if (typeof msg === 'string') {
    return { uz: msg, ru: msg, en: msg };
  }
  if (msg && typeof msg === 'object') {
    return {
      uz: msg.uz || msg.ru || msg.en || 'Xatolik',
      ru: msg.ru || msg.uz || msg.en || 'Ошибка',
      en: msg.en || msg.uz || msg.ru || 'Error',
    };
  }
  return { uz: 'Xatolik', ru: 'Ошибка', en: 'Error' };
};

const err = (id, code, msg) => ({
  jsonrpc: '2.0',
  error: { code, message: normalizeMsg(msg) },
  id,
});

/* ------------------------- Auth tekshiruvi -------------------------- */
// Payme: X-Auth: <PAYME_KEY> yoki Basic <base64(:PAYME_KEY)>
function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  const basic = req.get('Authorization');
  let okAuth = false;

  if (xAuth && xAuth === process.env.PAYME_KEY) okAuth = true;

  if (!okAuth && basic && basic.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8'); // "user:pass" yoki ":secret"
    const parts = decoded.split(':');
    const secret = parts[1] || parts[0];
    if (secret === process.env.PAYME_KEY) okAuth = true;
  }

  if (!okAuth) {
    res.status(200).json(
      err(req.body?.id ?? null, -32504, {
        uz: 'Ruxsat yo‘q',
        ru: 'Доступ запрещен',
        en: 'Unauthorized',
      }),
    );
    return true; // javob berildi
  }
  return false; // ruxsat berildi
}

/* -------------------------- Public helpers -------------------------- */
// 1) Yangi order yaratish (ixtiyoriy: chat_id, deliver_url saqlab qo'yamiz)
paymeRouter.get('/api/new-order', (req, res) => {
  const id = nextOrderId();
  const chat_id = req.query.chat_id ? String(req.query.chat_id) : null;
  const deliver_url = req.query.deliver_url ? String(req.query.deliver_url) : null;

  orders.set(id, {
    amount: 0,           // tiyinda
    state: 'new',        // new|created|performed|canceled
    chat_id,
    deliver_url,
    sent: false,         // tg ssilka yuborilganmi
  });

  res.json({ order_id: id });
});

// 2) Payme checkout URL (amount = tiyinda integer)
paymeRouter.get('/api/checkout-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amount = Number(req.query.amount || 0);

  if (!orderId || !amount || !Number.isInteger(amount) || amount <= 0) {
    return res.json({ error: 'order_id va amount (tiyin, integer) shart' });
  }

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount });

  const url = `https://checkout.paycom.uz/${process.env.PAYME_MERCHANT_ID}?order_id=${orderId}&amount=${amount}&lang=uz`;
  return res.json({ url });
});

/* ------------------------- JSON-RPC endpoint ------------------------ */
paymeRouter.post('/', async (req, res) => {
  if (requirePaymeAuth(req, res)) return;

  const { method, params, id } = req.body || {};
  if (!method || !params || typeof id === 'undefined') {
    return res.json(err(id ?? null, -32600, { uz: 'Noto‘g‘ri so‘rov' }));
  }

  try {
    switch (method) {
      /* --------- 1) CheckPerformTransaction --------- */
      case 'CheckPerformTransaction': {
        const orderId = String(params.account?.order_id || '');
        const order = orders.get(orderId);

        if (!order) {
          return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' })); // account not found
        }
        if (+order.amount !== +params.amount) {
          return res.json(err(id, -31001, { uz: 'Summalar mos emas' })); // wrong amount
        }
        return res.json(ok(id, { allow: true }));
      }

      /* --------------- 2) CreateTransaction ---------- */
      case 'CreateTransaction': {
        const orderId = String(params.account?.order_id || '');
        const order = orders.get(orderId);

        if (!order) {
          return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        }
        if (order.state && order.state !== 'new') {
          return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
        }
        if (+order.amount !== +params.amount) {
          return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
        }

        order.state = 'created';
        order.paycom_transaction_id = params.id;
        order.paycom_time = params.time;

        return res.json(ok(id, {
          transaction: params.id,
          state: 1,                 // created
          create_time: params.time,
        }));
      }

      /* --------------- 3) PerformTransaction --------- */
      case 'PerformTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) {
          return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        }

        if (order.state !== 'performed') {
          order.state = 'performed';
          order.perform_time = Date.now();

          // To'lov tasdiqlansa — Telegramga link (idempotent)
          if (!order.sent && order.chat_id && order.deliver_url) {
            try {
              const okSend = await sendTelegramLink(
                order.chat_id,
                `✅ To‘lov tasdiqlandi!\nSizning ssilka: ${order.deliver_url}`,
              );
              if (okSend) order.sent = true;
            } catch (_) {
              // logging only (xatolik JSON-RPC javobiga ta'sir qilmaydi)
            }
          }
        }

        return res.json(ok(id, {
          transaction: txId,
          state: 2,                 // performed
          perform_time: order.perform_time,
        }));
      }

      /* ---------------- 4) CancelTransaction --------- */
      case 'CancelTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) {
          return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        }

        order.state = 'canceled';
        order.cancel_time = Date.now();
        order.cancel_reason = params.reason ?? 0;

        return res.json(ok(id, {
          transaction: txId,
          state: -1,                // canceled
          cancel_time: order.cancel_time,
        }));
      }

      /* ------------------ 5) CheckTransaction -------- */
      case 'CheckTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) {
          return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
        }

        const map = { new: 0, created: 1, performed: 2, canceled: -1 };
        return res.json(ok(id, {
          transaction: txId,
          state: map[order.state] ?? 0,
          create_time: order.paycom_time ?? 0,
          perform_time: order.perform_time ?? 0,
          cancel_time: order.cancel_time ?? 0,
          reason: order.cancel_reason ?? null,
        }));
      }

      /* --------------------- default ------------------ */
      default:
        return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
    }
  } catch (e) {
    if (process.env.DEBUG_PAYME === '1') {
      console.error('PAYME ERROR:', e);
    }
    return res.json(err(id ?? null, -32603, { uz: 'Server xatosi' }));
  }
});
