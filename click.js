// click.js — Click redirect + callback (prefiks: /click)
import { Router } from 'express';
import { Orders } from './store.js';
import { buildPrepareSign, buildCompleteSign } from './utils/clickSign.js';
import { createOneTimeInviteLink, sendTelegramAccess } from './telegram.js'; // <-- ADD

const router = Router();

// Redirect URL (amount = tiyinda)
router.get('/api/click-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amountTiyin = Number(req.query.amount || 0);
  if (!orderId || !amountTiyin) return res.status(400).json({ error: 'order_id va amount (tiyin) shart' });

  const prev = Orders.get(orderId) || { amount: 0, state: 'new' };
  //Orders.set(orderId, { ...prev, amount: amountTiyin });
  Orders.set(orderId, {
    ...prev,
    amount: amountTiyin,
    chat_id:     prev?.chat_id ?? (req.query.chat_id ? String(req.query.chat_id) : undefined),
    deliver_url: prev?.deliver_url ?? (req.query.deliver_url ? String(req.query.deliver_url) : undefined),
    userId:      prev?.userId ?? (req.query.chat_id ? String(req.query.chat_id) : undefined)
  });

  const amountSoum = (amountTiyin / 100).toFixed(2);
  const u = new URL('https://my.click.uz/services/pay');
  u.searchParams.set('service_id',  process.env.CLICK_SERVICE_ID);
  u.searchParams.set('merchant_id', process.env.CLICK_MERCHANT_ID);
  if (process.env.CLICK_MERCHANT_USER_ID) u.searchParams.set('merchant_user_id', process.env.CLICK_MERCHANT_USER_ID);
  u.searchParams.set('transaction_param', orderId);
  u.searchParams.set('amount', amountSoum);
  if (process.env.CLICK_RETURN_URL) u.searchParams.set('return_url', process.env.CLICK_RETURN_URL);

  const url = u.toString();
  if (String(req.query.redirect) === '1') return res.redirect(url);
  return res.json({ url });
});

// Callback (prepare/complete)
router.post('/callback', async (req, res) => {
  const p = { ...req.body };
  const required = ['click_trans_id','service_id','merchant_trans_id','amount','action','sign_time','sign_string'];
  for (const k of required) if (typeof p[k] === 'undefined') return res.json({ error: -1, error_note: `Missing field: ${k}` });

  const orderId = String(p.merchant_trans_id);
  const order   = Orders.get(orderId);
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

      // === ADD: to‘lovdan keyin kanalga dostup (bir martalik) ===
      try {
        const chatId = order.chat_id || order.userId; // ikkala nomni ham qo‘llab
        if (!order.sent && chatId) {
          const invite = await createOneTimeInviteLink();
          await sendTelegramAccess(chatId, invite, order.deliver_url);
          order.sent = true;
        }
      } catch (e) {
        console.error('CLICK DELIVERY ERROR:', e);
      }
      // === /ADD ===

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

export default router;
