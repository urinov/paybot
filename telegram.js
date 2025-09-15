// telegram.js — bot logikasi (/start va webhook)
import { Telegraf } from 'telegraf';
import { nextOrderId, Orders } from './store.js';

const BOT_TOKEN     = process.env.BOT_TOKEN;
const BASE_URL      = process.env.BASE_URL;      // https://<service>.onrender.com
if (!BOT_TOKEN) throw new Error('BOT_TOKEN env kerak');

export const bot = new Telegraf(BOT_TOKEN);

const fullName = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ')
  || (u?.username ? '@' + u.username : 'foydalanuvchi');
const soM = (tiyin) => (tiyin/100).toLocaleString('uz-UZ',{minimumFractionDigits:2, maximumFractionDigits:2});

bot.start(async (ctx) => {
  const orderId = nextOrderId();
  const amountTiyin = 1_100_000; // 11 000 so'm (demo)

  Orders.set(orderId, { amount: amountTiyin, state: 'new', userId: ctx.from.id });

  // E’TIBOR: prefikslar qo‘yildi -> /payme/... va /click/...
  const paymeUrl = `${BASE_URL}/payme/api/checkout-url?order_id=${orderId}&amount=${amountTiyin}&redirect=1`;
  const clickUrl = `${BASE_URL}/click/api/click-url?order_id=${orderId}&amount=${amountTiyin}&redirect=1`;

  const text =
    `👋 Salom, <b>${fullName(ctx.from)}</b>!\n\n` +
    `Siz <b>shaxsiy rivojlanish</b> yo‘lida to‘g‘ri yo‘ldasiz. Faqat bitta qadam qoldi — to‘lovni tasdiqlang.\n\n` +
    `🧾 <b>Buyurtma:</b> #${orderId}\n` +
    `💰 <b>Summa:</b> ${soM(amountTiyin)} so‘m\n\n` +
    `Quyidan to‘lov usulini tanlang:`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[
      { text: '💳 Payme', url: paymeUrl },
      { text: '💠 Click', url: clickUrl }
    ]]}
  });
});

bot.on('message', (ctx) => ctx.reply('To‘lov uchun /start ni bosing.', { disable_web_page_preview: true }));

// Webhook URL idempotent
if (BASE_URL) {
  bot.telegram.setWebhook(`${BASE_URL}/telegram/webhook`).catch(console.error);
}
