// payme.js — Payme JSON-RPC + checkout helper
import { Router } from 'express';
import { orders, nextOrderId } from './store.js';
import { sendTelegramLink } from './telegram.js';

export const paymeRouter = Router();

const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  const basic = req.get('Authorization');
  let okAuth = false;

  if (xAuth && xAuth === process.env.PAYME_KEY) okAuth = true;

  if (!okAuth && basic && basic.startsWith('Basic ')) {
    const decoded = Buffer.from(basic.slice(6), 'base64').toString('utf8');
    const parts = decoded.split(':');
    const secret = parts[1] || parts[0];
    if (secret === process.env.PAYME_KEY) okAuth = true;
  }

  if (!okAuth) {
    return res.status(200).json({
      jsonrpc: '2.0',
      error: { code: -32504, message: { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещен', en: 'Unauthorized' } },
      id: req.body?.id ?? null
    });
  }
  return null;
}

// --- Public helpers (checkout)

// Yangi order (chat_id, deliver_url qo'shish mumkin)
paymeRouter.get('/api/new-order', (req, res) => {
  const id = nextOrderId();
  const chat_id = req.query.chat_id ? String(req.query.chat_id) : null;
  const deliver_url = req.query.deliver_url ? String(req.query.deliver_url) : null;
  orders.set(id, { amount: 0, state: 'new', chat_id, deliver_url, sent: false });
  res.json({ order_id: id });
});

// Payme checkout uchun URL (amount = tiyinda)
paymeRouter.get('/api/checkout-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amount  = Number(req.query.amount || 0);
  if (!orderId || !amount) return res.json({ error: 'order_id va amount (tiyin) shart' });

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount });

  // Payme checkout URL (klassik)
  const url = `https://checkout.paycom.uz/${process.env.PAYME_MERCHANT_ID}?order_id=${orderId}&amount=${amount}&lang=uz`;
  res.json({ url });
});

// --- JSON-RPC endpoint (root of router)
paymeRouter.post('/', async (req, res) => {
  if (requirePaymeAuth(req, res)) return;

  const { method, params, id } = req.body || {};
  if (!method || !params || typeof id === 'undefined') {
    return res.json(err(id ?? null, -32600, { uz: 'Invalid request' }));
  }

  try {
    switch (method) {
      case 'CheckPerformTransaction': {
        const orderId = String(params.account?.order_id || '');
        const order = orders.get(orderId);
        if (!order)                    return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' })); // account not found
        if (+order.amount !== +params.amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' })); // wrong amount
        return res.json(ok(id, { allow: true }));
      }

      case 'CreateTransaction': {
        const orderId = String(params.account?.order_id || '');
        const order = orders.get(orderId);
        if (!order)                         return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
        if (order.state && order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
        if (+order.amount !== +params.amount)      return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));

        order.state = 'created';
        order.paycom_transaction_id = params.id;
        order.paycom_time = params.time;
        return res.json(ok(id, { transaction: params.id, state: 1, create_time: params.time }));
      }

      case 'PerformTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));

        if (order.state !== 'performed') {
          order.state = 'performed';
          order.perform_time = Date.now();

          // 🔔 Telegramga ssilka (idempotent)
          if (!order.sent && order.chat_id && order.deliver_url) {
            const okSend = await sendTelegramLink(order.chat_id, `✅ To‘lov tasdiqlandi!\nSizning ssilka: ${order.deliver_url}`);
            if (okSend) order.sent = true;
          }
        }
        return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
      }

      case 'CancelTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));

        order.state = 'canceled';
        order.cancel_time = Date.now();
        order.cancel_reason = params.reason ?? 0;
        return res.json(ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }));
      }

      case 'CheckTransaction': {
        const txId = params.id;
        const order = [...orders.values()].find(o => o.paycom_transaction_id === txId);
        if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));

        const map = { new: 0, created: 1, performed: 2, canceled: -1 };
        return res.json(ok(id, {
          transaction: txId,
          state: map[order.state] ?? 0,
          create_time: order.paycom_time ?? 0,
          perform_time: order.perform_time ?? 0,
          cancel_time: order.cancel_time ?? 0,
          reason: order.cancel_reason ?? null
        }));
      }

      default:
        return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
    }
  } catch (e) {
    if (process.env.DEBUG_PAYME === '1') console.error('PAYME ERROR:', e);
    return res.json(err(id ?? null, -32603, { uz: 'Server xatosi' }));
  }
});
