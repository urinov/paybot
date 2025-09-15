// telegram.js — to'lov tasdiqlanganda botga xabar yuborish
export async function sendTelegramLink(chatId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId || !text) return false;
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await resp.json();
    if (!data.ok) console.error('TG send error:', data);
    return data.ok;
  } catch (e) {
    console.error('TG send exception:', e);
    return false;
  }
}
