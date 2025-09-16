// payme.js — Paycom JSON-RPC + Checkout helper (prefix: /payme)
import { Router } from 'express';
import { Orders, nextOrderId } from './store.js';
import { buildCheckoutUrl } from './utils/buildCheckoutUrl.js';
import { createOneTimeInviteLink, sendTelegramAccess } from './telegram.js'; // <-- ADD

const router = Router();

/* ----------------------------- i18n helpers ----------------------------- */
// Kalit -> uch tildagi matnlar
const MESSAGES = {
  unauthorized:   { uz: 'Ruxsat yo‘q', ru: 'Доступ запрещён', en: 'Unauthorized' },
  notFoundOrder:  { uz: 'Buyurtma topilmadi', ru: 'Счёт не найден', en: 'Order not found' },
  amountMismatch: { uz: 'Summalar mos emas', ru: 'Сумма не совпадает', en: 'Amount mismatch' },
  txNotFound:     { uz: 'Tranzaksiya topilmadi', ru: 'Транзакция не найдена', en: 'Transaction not found' },
  methodNotFound: { uz: 'Metod topilmadi', ru: 'Метод не найден', en: 'Method not found' },
  accountLocked:  { uz: 'Hisob bu holatda yangi to‘lov qabul qilmaydi', ru: 'Счёт в этом состоянии не принимает новый платёж', en: 'Account cannot accept a new payment in this state' },
  serverError:    { uz: 'Server xatosi', ru: 'Ошибка сервера', en: 'Server error' },
  // ➕ ADD:
  invalidParams:  { uz: 'Noto‘g‘ri parametrlar', ru: 'Неверные параметры', en: 'Invalid params' },
};

// msg string bo‘lsa 3 tilda ko‘paytiradi; obyekt bo‘lsa yo‘q tildagilarni to‘ldiradi
const normalizeMsg = (msg) => {
  if (typeof msg === 'string') return { uz: msg, ru: msg, en: msg };
  return {
    uz: msg.uz ?? msg.ru ?? msg.en ?? 'Xatolik',
    ru: msg.ru ?? msg.uz ?? msg.en ?? 'Ошибка',
    en: msg.en ?? msg.uz ?? msg.ru ?? 'Error',
  };
};

const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });
const err = (id, code, msg) => ({ jsonrpc: '2.0', error: { code, message: normalizeMsg(msg) }, id });

/* ------------------------------- Auth ---------------------------------- */
function isBasicAuthValid(req) {
  const hdr = req.get('Authorization');
  if (!hdr || !hdr.startsWith('Basic ')) return false;
  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8'); // "Paycom:<KEY>"
  const [user, key] = decoded.split(':');
  return user === 'Paycom' && key === process.env.PAYME_KEY;
}

function requirePaymeAuth(req, res) {
  const xauth = req.get('X-Auth');
  const pass  = (xauth && xauth === process.env.PAYME_KEY) || isBasicAuthValid(req);
  if (!pass) {
    return res.status(200).json(err(req.body?.id ?? null, -32504, MESSAGES.unauthorized));
  }
  return null;
}

/* --------------------------- Public helpers ---------------------------- */
// 1) Yangi order (ixtiyoriy)
router.get('/api/new-order', (req, res) => {
  const id = nextOrderId();
  const chat_id = req.query.chat_id ? String(req.query.chat_id) : null;
  const deliver_url = req.query.deliver_url ? String(req.query.deliver_url) : null;
  Orders.set(id, { amount: 0, state: 'new', chat_id, deliver_url, sent: false });
  res.json({ order_id: id });
});

// 2) Payme checkout URL (amount = tiyinda)
router.get('/api/checkout-url', (req, res) => {
  const orderId = String(req.query.order_id || '');
  const amount  = Number(req.query.amount || 0);
  if (!orderId || !amount || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'order_id va amount (tiyin, integer) shart' });
  }
  const prev = Orders.get(orderId) || { amount: 0, state: 'new' };

  Orders.set(orderId, {
    ...prev,
    amount,
    // query orqali kelsa — yozamiz, yo‘q bo‘lsa eski qiymatni saqlaymiz
    chat_id:     prev?.chat_id ?? (req.query.chat_id ? String(req.query.chat_id) : undefined),
    deliver_url: prev?.deliver_url ?? (req.query.deliver_url ? String(req.query.deliver_url) : undefined),
    userId:      prev?.userId ?? (req.query.chat_id ? String(req.query.chat_id) : undefined) // fallback
  });

  const url = buildCheckoutUrl({
    merchantId:     process.env.PAYME_MERCHANT_ID,
    orderId,
    amountInTiyin:  amount,
    lang:           'uz',
    callbackUrl:    process.env.CALLBACK_RETURN_URL,
    currencyIso:    'UZS',
    description:    'To‘lov'
  });

  if (String(req.query.redirect) === '1') return res.redirect(url);
  return res.json({ url });
});

/* ---------------------------- JSON-RPC root ---------------------------- */
router.post('/', async (req, res) => {
  const unauth = requirePaymeAuth(req, res);
  if (unauth) return;

  const { method, params, id } = req.body || {};

  try {
    /* -------------------- CheckPerformTransaction -------------------- */
    if (method === 'CheckPerformTransaction') {
      const orderId = String(params?.account?.order_id || '');
      const order = Orders.get(orderId);
      if (!order) return res.json(err(id, -31050, MESSAGES.notFoundOrder));
      if (+order.amount !== +params.amount) return res.json(err(id, -31001, MESSAGES.amountMismatch));
      return res.json(ok(id, { allow: true }));
    }

    /* ------------------------ CreateTransaction ---------------------- */
    if (method === 'CreateTransaction') {
      const orderId = String(params?.account?.order_id || '');
      const order = Orders.get(orderId);
      if (!order) return res.json(err(id, -31050, MESSAGES.notFoundOrder));
      if (+order.amount !== +params.amount) return res.json(err(id, -31001, MESSAGES.amountMismatch));

      // Idempotent: aynan shu transaction id bilan takror so'rov bo'lsa — bir xil javob
      if (order.state && order.state !== 'new') {
        if (order.paycom_transaction_id === params.id) {
          return res.json(ok(id, {
            transaction: order.paycom_transaction_id,
            state: 1,
            create_time: order.paycom_time
          }));
        }
        // Bitta order uchun bitta transaction — boshqa params.id bilan yaratishni blokla
        return res.json(err(id, -31050, MESSAGES.accountLocked));
      }

      // Yangi transaction
      Object.assign(order, {
        state: 'created',
        paycom_transaction_id: params.id,
        paycom_time: params.time
      });
      return res.json(ok(id, { transaction: params.id, state: 1, create_time: params.time }));
    }

    /* ------------------------ PerformTransaction --------------------- */
    if (method === 'PerformTransaction') {
      const txId = params.id;
      const order = [...Orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, MESSAGES.txNotFound));

      if (order.state !== 'performed') {
        order.state = 'performed';
        order.perform_time = Date.now();
      }

      // To‘lovdan keyin kanalga dostup (bir martalik)
      try {
        const chatId = order.chat_id || order.userId; // ikkala nomni ham qo‘llab
        if (!order.sent && chatId) {
          const invite = await createOneTimeInviteLink();
          await sendTelegramAccess(chatId, invite, order.deliver_url);
          order.sent = true;
        }
      } catch (e) {
        console.error('PAYME DELIVERY ERROR:', e);
      }

      return res.json(ok(id, { transaction: txId, state: 2, perform_time: order.perform_time }));
    }

    /* ------------------------ CancelTransaction ---------------------- */
    if (method === 'CancelTransaction') {
      const txId = params.id;
      const order = [...Orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, MESSAGES.txNotFound));

      const now = Date.now();

      // Idempotent javoblar
      if (order.state === 'canceled_after_perform') {
        return res.json(ok(id, { transaction: txId, state: -2, cancel_time: order.cancel_time }));
      }
      if (order.state === 'canceled') {
        return res.json(ok(id, { transaction: txId, state: -1, cancel_time: order.cancel_time }));
      }

      // Reason xaritasi: 5 -> -2; 3 -> -1; (aks holda: performed bo'lsa -2, bo'lmasa -1)
      const r = Number(params.reason);
      let targetState;
      if (r === 5) targetState = -2;
      else if (r === 3) targetState = -1;
      else targetState = (order.state === 'performed') ? -2 : -1;

      order.cancel_time = now;
      order.cancel_reason = isNaN(r) ? null : r;

      if (targetState === -2) {
        order.state = 'canceled_after_perform';
        return res.json(ok(id, { transaction: txId, state: -2, cancel_time: now }));
      } else {
        order.state = 'canceled';
        return res.json(ok(id, { transaction: txId, state: -1, cancel_time: now }));
      }
    }

    /* ------------------------- CheckTransaction ---------------------- */
    if (method === 'CheckTransaction') {
      const txId = params.id;
      const order = [...Orders.values()].find(o => o.paycom_transaction_id === txId);
      if (!order) return res.json(err(id, -31003, MESSAGES.txNotFound));

      const map = { new: 0, created: 1, performed: 2, canceled: -1, canceled_after_perform: -2 };
      const state = map[order.state] ?? 0;

      return res.json(ok(id, {
        transaction: txId,
        state,
        create_time: order.paycom_time ?? 0,
        perform_time: order.perform_time ?? 0,
        cancel_time: (state === 2) ? 0 : (order.cancel_time ?? 0),
        reason:      (state === 2) ? null : (order.cancel_reason ?? null)
      }));
    }

    /* ---------------------------- GetStatement ---------------------------- */
    if (method === 'GetStatement') {
      const fromRaw = params?.from;
      const toRaw   = params?.to;
    
      const normTs = (v) => {
        const n = Number(v) || 0;
        return n < 1e12 ? n * 1000 : n; // sec -> ms
      };
    
      const from = normTs(fromRaw);
      const to   = normTs(toRaw);
      if (!from || !to || from > to) {
        return res.json(err(id, -32602, MESSAGES.invalidParams));
      }
    
      const map = { new: 0, created: 1, performed: 2, canceled: -1, canceled_after_perform: -2 };
      const wantedStates = new Set([1, 2, -1, -2]);
    
      const transactions = [];
      for (const [orderId, o] of Orders.entries()) {
        if (!o?.paycom_transaction_id || !o?.paycom_time) continue;
    
        const createTime = Number(o.paycom_time);
        if (createTime < from || createTime > to) continue;
    
        const state = map[o.state] ?? 0;
        if (!wantedStates.has(state)) continue;
    
        // 🔵 faqat order_id
        const account = { order_id: String(orderId) };
    
        transactions.push({
          id: String(o.paycom_transaction_id),
          time: createTime,
          amount: Number(o.amount) || 0,
          account,
          create_time: createTime,
          perform_time: o.perform_time ?? 0,
          cancel_time: o.cancel_time ?? 0,
          transaction: String(o.paycom_transaction_id),
          state,
          reason: state === 2 ? null : (o.cancel_reason ?? null),
        });
      }
    
      return res.json(ok(id, { transactions }));
    }


    /* --------------------------- Fallback ---------------------------- */
    return res.json(err(id, -32601, MESSAGES.methodNotFound));
  } catch (e) {
    console.error('PAYME ERROR:', e);
    return res.json(err(id ?? null, -32603, MESSAGES.serverError));
  }
});

export default router;
