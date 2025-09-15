// click.js — Click redirect + callback (prepare/complete)
import { Router } from 'express';
import { orders, nextOrderId } from './store.js';
import crypto from 'crypto';
import { sendTelegramLink } from './telegram.js';

export const clickRouter = Router();

// Yangi order (chat_id, deliver_url qo'shish mumkin)
clickRouter.get('/api/new-order', (req, res) => {
  const id = nextOrderId();
  const chat_id = req.query.chat_id ? String(req.query.chat_id) : null;
  const deliver_url = req.query.deliver_url ? String(req.query.deliver_url) : null;
  orders.set(id, { amount: 0, state: 'new', chat_id, deliver_url, sent: false });
  res.json({ order_id: id });
});

// Redirect URL (amount = tiyinda)
clickRouter.get('/api/click-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amountTiyin = Number(req.query.amount || 0);
  if (!orderId || !amountTiyin) return res.json({ error: 'order_id va amount (tiyin) shart' });

  const prev = orders.get(orderId) || { amount: 0, state: 'new' };
  orders.set(orderId, { ...prev, amount: amountTiyin });

  const amountSoum = (amountTiyin / 100).toFixed(2);
  const u = new URL('https://my.click.uz/services/pay');
  u.searchParams.set('service_id',  process.env.CLICK_SERVICE_ID);
  u.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  if (process.env.CLICK_MERCHANT_USER_ID) u.searchParams.set('merchant_user_id', process.env.CLICK_MERCHANT_USER_ID);
  u.searchParams.set('transaction_param', orderId);
  u.searchParams.set('amount', amountSoum);
  if (process.env.CLICK_RETURN_URL) u.searchParams.set('return_url', process.env.CLICK_RETURN_URL);

  res.json({ url: u.toString() });
});

// Sign builders (Click talabiga ko‘ra)
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}
function buildPrepareSign(p) {
  // click_trans_id+service_id+secret_key+merchant_trans_id+amount+action+sign_time
  return md5(`${p.click_trans_id}${p.service_id}${p.secret_key}${p.merchant_trans_id}${p.amount}${p.action}${p.sign_time}`).toLowerCase();
}
function buildCompleteSign(p) {
  // click_trans_id+service_id+secret_key+merchant_trans_id+merchant_prepare_id+amount+action+sign_time
  return md5(`${p.click_trans_id}${p.service_id}${p.secret_key}${p.merchant_trans_id}${p.merchant_prepare_id}${p.amount}${p.action}${p.sign_time}`).toLowerCase();
}

// Callback (prepare/complete)
clickRouter.post('/callback', async (req, res) => {
  const p = { ...req.body };
  const required = ['click_trans_id','service_id','merchant_trans_id','amount','action','sign_time','sign_string'];
  for (const k of required) if (typeof p[k] === 'undefined') return res.json({ error: -1, error_note: `Missing field: ${k}` });

  const orderId = String(p.merchant_trans_id);
  const order   = orders.get(orderId);
  if (!order) return res.json({ error: -5, error_note: 'Order not found' });

  const action = Number(p.action); // 0=prepare, 1=complete
  const amtStr = String(p.amount);
  const secret = process.env.CLICK_SECRET_KEY;

  if (action === 0) {
    const expected = buildPrepareSign({
      click_trans_id: p.click_trans_id,
      service_id:     p.service_id,
      secret_key:     secret,
      merchant_trans_id: p.merchant_trans_id,
      amount:         amtStr,
      action:         p.action,
      sign_time:      p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) return res.json({ error: -1, error_note: 'Invalid sign (prepare)' });

    if (Math.round(order.amount / 100) !== Math.round(Number(amtStr))) {
      return res.json({ error: -2, error_note: 'Incorrect amount' });
    }

    order.state = 'created';
    return res.json({
      click_trans_id:      p.click_trans_id,
      merchant_trans_id:   orderId,
      merchant_prepare_id: orderId,
      error: 0, error_note: 'Success'
    });
  }

  if (action === 1) {
    if (typeof p.merchant_prepare_id === 'undefined') {
      return res.json({ error: -1, error_note: 'Missing field: merchant_prepare_id' });
    }

    const expected = buildCompleteSign({
      click_trans_id:      p.click_trans_id,
      service_id:          p.service_id,
      secret_key:          secret,
      merchant_trans_id:   p.merchant_trans_id,
      merchant_prepare_id: p.merchant_prepare_id,
      amount:              amtStr,
      action:              p.action,
      sign_time:           p.sign_time
    });
    if (expected !== String(p.sign_string).toLowerCase()) return res.json({ error: -1, error_note: 'Invalid sign (complete)' });

    if (Number(p.error) === 0) {
      order.state = 'performed';
      order.perform_time = Date.now();

      // 🔔 Telegramga ssilka (idempotent)
      if (!order.sent && order.chat_id && order.deliver_url) {
        const okSend = await sendTelegramLink(order.chat_id, `✅ To‘lov tasdiqlandi!\nSizning ssilka: ${order.deliver_url}`);
        if (okSend) order.sent = true;
      }

      return res.json({
        click_trans_id:      p.click_trans_id,
        merchant_trans_id:   orderId,
        merchant_confirm_id: orderId,
        error: 0, error_note: 'Success'
      });
    } else {
      order.state = 'canceled';
      order.cancel_time = Date.now();
      return res.json({
        click_trans_id:      p.click_trans_id,
        merchant_trans_id:   orderId,
        merchant_confirm_id: orderId,
        error: -9, error_note: 'Payment canceled'
      });
    }
  }

  return res.json({ error: -3, error_note: 'Unknown action' });
});
