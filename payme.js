// payme.js — Payme JSON-RPC + Checkout helper (prefiks: /payme)
import { Router } from 'express';
import { Orders, nextOrderId } from './store.js';
import { buildCheckoutUrl } from './utils/buildCheckoutUrl.js';

const router = Router();

/* ---------- Auth ---------- */
function requirePaymeAuth(req, res) {
  const xAuth = req.get('X-Auth');
  if (!xAuth || xAuth !== process.env.PAYME_KEY) {
    return res.status(200).json({
      jsonrpc: '2.0',
      error: { code: -32504, message: { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещен', en: 'Unauthorized' } },
      id: req.body?.id ?? null
    });
  }
  return null;
}
const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg={}) => ({ jsonrpc: '2.0', error: { code, message: msg }, id });

/* ---------- Public helpers ---------- */
// Yangi order (ixtiyoriy)
router.get('/api/new-order', (req, res) => {
  const id = nextOrderId();
  const chat_id = req.query.chat_id ? String(req.query.chat_id) : null;
  const deliver_url = req.query.deliver_url ? String(req.query.deliver_url) : null;
  Orders.set(id, { amount: 0, state: 'new', chat_id, deliver_url, sent: false });
  res.json({ order_id: id });
});

// Payme checkout URL (amount = tiyinda)
router.get('/api/checkout-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amount  = Number(req.query.amount || 0);
  if (!orderId || !amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'order_id va amount (tiyin, integer) shart' });
  }
  const prev = Orders.get(orderId) || { amount: 0, state: 'new' };
  Orders.set(orderId, { ...prev, amount });

  const url = buildCheckoutUrl({
    merchantId:     process.env.PAYME_MERCHANT_ID,
    orderId:        orderId,
    amountInTiyin:  amount,
    lang:           'uz',
    callbackUrl:    process.env.CALLBACK_RETURN_URL, // ixtiyoriy qaytish (front sahifa)
    currencyIso:    'UZS',
    description:    'To‘lov'
  });

  if (String(req.query.redirect) === '1') return res.redirect(url);
  return res.json({ url });
});

/* ---------- JSON-RPC root ---------- */
router.post('/', async (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;

  const { method, params, id } = req.body || {};
  try {
    if (method === 'CheckPerformTransaction') {
      const orderId = String(params.account?.order_id || '');
      const order = Orders.get(orderId);
      if (!order)                    return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
      if (+order.amount !== +params.amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));
      return res.json(ok(id, { allow: true }));
    }

    if (method === 'CreateTransaction') {
      const orderId = String(params.account?.order_id || '');
      const order = Orders.get(orderId);
      if (!order) return res.json(err(id, -31050, { uz: 'Buyurtma topilmadi' }));
      if (order.state && order.state !== 'new') return res.json(err(id, -31008, { uz: 'Allaqachon yaratilgan' }));
      if (+order.amount !== +params.amount) return res.json(err(id, -31001, { uz: 'Summalar mos emas' }));

      Object.assign(order, { state: 'created', paycom_transaction_id: params.id, paycom_time: params.time });
      return res.json(ok(id, { transaction: params.id, state: 1, create_time: params.time }));
    }

    if (method === 'PerformTransaction') {
      const txId = params.id;
      const order = [...Orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));

      if (order.state !== 'performed') {
        order.state = 'performed';
        order.perform_time = Date.now();
      }
      return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
    }

    if (method === 'CancelTransaction') {
      const txId = params.id;
      const order = [...Orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, { uz: 'Tranzaksiya topilmadi' }));
      order.state = 'canceled';
      order.cancel_time = Date.now();
      order.cancel_reason = params.reason ?? 0;
      return res.json(ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }));
    }

    if (method === 'CheckTransaction') {
      const txId = params.id;
      const order = [...Orders.values()].find(o => o.paycom_transaction_id === txId);
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

    return res.json(err(id, -32601, { uz: 'Metod topilmadi' }));
  } catch (e) {
    console.error('PAYME ERROR:', e);
    return res.json(err(id ?? null, -32603, { uz: 'Server xatosi' }));
  }
});

export default router;
