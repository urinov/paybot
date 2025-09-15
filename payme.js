// payme.js — Payme JSON-RPC + Checkout helper (ESM)
import { Router } from 'express';
import { orders, nextOrderId } from './store.js';
import { sendTelegramLink } from './telegram.js';

export const paymeRouter = Router();

/* ---------------------- Default multilingual messages ---------------------- */
// Payme error codes we use -> { uz, ru, en }
const DEFAULT_MSG = {
  [-31050]: { uz: 'Buyurtma topilmadi',     ru: 'Счёт не найден',              en: 'Order not found' },
  [-31001]: { uz: 'Summalar mos emas',      ru: 'Неверная сумма',              en: 'Incorrect amount' },
  [-31008]: { uz: 'Allaqachon yaratilgan',  ru: 'Уже создано',                 en: 'Already created' },
  [-31003]: { uz: 'Tranzaksiya topilmadi',  ru: 'Транзакция не найдена',       en: 'Transaction not found' },
  [-32504]: { uz: 'Ruxsat yo‘q',            ru: 'Доступ запрещен',             en: 'Unauthorized' },
  [-32600]: { uz: 'Noto‘g‘ri so‘rov',       ru: 'Некорректный запрос',         en: 'Invalid request' },
  [-32601]: { uz: 'Metod topilmadi',        ru: 'Метод не найден',             en: 'Method not found' },
  [-32603]: { uz: 'Server xatosi',          ru: 'Внутренняя ошибка сервера',   en: 'Internal error' },
};

/* ------------------------------- RPC helpers ------------------------------- */
const ok = (id, result) => ({ jsonrpc: '2.0', result, id });

// error.message Payme talabiga ko‘ra string yoki {ru,en,uz} bo‘lishi shart.
// normalizeMsg: msg'ni 3 tilda to‘ldiradi.
const normalizeMsg = (msg) => {
  if (typeof msg === 'string') return { uz: msg, ru: msg, en: msg };
  if (msg && typeof msg === 'object') {
    return {
      uz: msg.uz || msg.ru || msg.en || 'Xatolik',
      ru: msg.ru || msg.uz || msg.en || 'Ошибка',
      en: msg.en || msg.uz || msg.ru || 'Error',
    };
  }
  return { uz: 'Xatolik', ru: 'Ошибка', en: 'Error' };
};

// err(): kod bo‘yicha DEFAULT_MSG ni oladi, so‘ng berilgan msg bilan merge qiladi
const err = (id, code, msg) => {
  const def = DEFAULT_MSG[code] || {};
  const merged =
    typeof msg === 'string'
      ? { ...def, uz: msg }      // string kelsa — uz ni yangilaymiz, ru/en defaultdan
      : { ...def, ...(msg || {}) }; // obyekt kelsa — foydalanuvchinikini ustun qo‘yamiz

  return { jsonrpc: '2.0', error: { code, message: normalizeMsg(merged) }, id };
};

/* --------------------------------- Auth ----------------------------------- */
// Payme JSON-RPC: X-Auth: <PAYME_KEY> yoki Basic <base64(:PAYME_KEY)>
function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  const basic = req.get('Authorization');
  let okAuth = false;

  if (xAuth && xAuth === process.env.PAYME_KEY) okAuth = true;

  if (!okAuth && basic && basic.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8'); // "user:pass" yoki ":secret"
    const [user, pass] = decoded.split(':');
    const secret = pass || user; // ba’zida ":secret" ko‘rinishida bo‘ladi
    if (secret === process.env.PAYME_KEY) okAuth = true;
  }

  if (!okAuth) {
    res.status(200).json(err(req.body?.id ?? null, -32504));
    return true; // javob berildi
  }
  return false; // davom etamiz
}

/* ------------------------------ Public helpers ----------------------------- */
// 1) Yangi order (ixtiyoriy: chat_id, deliver_url saqlanadi)
paymeRouter.get('/api/new-order', (req, res) => {
  const id = nextOrderId();
  const chat_id = req.query.chat_id ? String(req.query.chat_id) : null;
  const deliver_url = req.query.deliver_url ? String(req.query.deliver_url) : null;

  orders.set(id, {
    amount: 0,             // tiyinda
    state: 'new',          // new|created|performed|canceled
    chat_id,
    deliver_url,
    sent: false,           // tg ssilka yuborilganmi
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

/* ----------------------------- JSON-RPC root ------------------------------- */
paymeRouter.post('/', async (req, res) => {
  if (requirePaymeAuth(req, res)) return;

  const { method, params, id } = req.body || {};
  if (!method || !params || typeof id === 'undefined') {
    return res.json(err(id ?? null, -32600));
  }

  try {
    switch (method) {
      /* -------------------- 1) CheckPerformTransaction -------------------- */
      case 'CheckPerformTransaction': {
        const orderId = String(params.account?.order_id || '');
        const order = orders.get(orderId);

        if (!order) return res.json(err(id, -31050));           // account not found
        if (+order.amount !== +params.amount) return res.json(err(id, -31001)); // wrong amount

        return res.json(ok(id, { allow: true }));
      }

      /* ----------------------- 2) CreateTransaction ----------------------- */
      case 'CreateTransaction': {
        const orderId = String(params.account?.order_id || '');
        const order = orders.get(orderId);

        if (!order) return res.json(err(id, -31050));
        if (order.state && order.state !== 'new') return res.json(err(id, -31008));
        if (+order.amount !== +params.amount) return res.json(err(id, -31001));

        order.state = 'created';
        order.paycom_transaction_id = params.id;
        order.paycom_time = params.time;

        return res.json(
          ok(id, { transaction: params.id, state: 1, create_time: params.time }),
        );
      }

      /* ----------------------- 3) PerformTransaction ---------------------- */
      case 'PerformTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003));

        if (order.state !== 'performed') {
          order.state = 'performed';
          order.perform_time = Date.now();

          // To‘lov tasdiqlanganda — Telegramga ssilka (idempotent)
          if (!order.sent && order.chat_id && order.deliver_url) {
            try {
              const okSend = await sendTelegramLink(
                order.chat_id,
                `✅ To‘lov tasdiqlandi!\nSizning ssilka: ${order.deliver_url}`,
              );
              if (okSend) order.sent = true;
            } catch {
              // logging only; RPC javobiga ta’sir qilmaydi
            }
          }
        }

        return res.json(
          ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }),
        );
      }

      /* ----------------------- 4) CancelTransaction ----------------------- */
      case 'CancelTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003));

        order.state = 'canceled';
        order.cancel_time = Date.now();
        order.cancel_reason = params.reason ?? 0;

        return res.json(
          ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }),
        );
      }

      /* ------------------------ 5) CheckTransaction ----------------------- */
      case 'CheckTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003));

        const map = { new: 0, created: 1, performed: 2, canceled: -1 };
        return res.json(
          ok(id, {
            transaction: txId,
            state: map[order.state] ?? 0,
            create_time: order.paycom_time ?? 0,
            perform_time: order.perform_time ?? 0,
            cancel_time: order.cancel_time ?? 0,
            reason: order.cancel_reason ?? null,
          }),
        );
      }

      /* -------------------------------- default --------------------------- */
      default:
        return res.json(err(id, -32601));
    }
  } catch (e) {
    if (process.env.DEBUG_PAYME === '1') console.error('PAYME ERROR:', e);
    return res.json(err(id ?? null, -32603));
  }
});
