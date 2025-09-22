// utils/buildCheckoutUrl.js
function toBase64(str){ return Buffer.from(str,'utf8').toString('base64'); }

export function buildCheckoutUrl({
  checkoutOrigin='https://checkout.paycom.uz',
  merchantId, orderId, amountInTiyin,
  lang='uz', callbackUrl, callbackTimeoutMs=15000,
  currencyIso='UZS', description, detailBase64
}){
  const p=[];
  p.push(`m=${merchantId}`);
  p.push(`ac.order_id=${orderId}`);
  p.push(`a=${amountInTiyin}`);
  if(lang) p.push(`l=${lang}`);
  if(callbackUrl) p.push(`c=${encodeURIComponent(callbackUrl)}`);
  if(callbackTimeoutMs) p.push(`ct=${callbackTimeoutMs}`);
  if(currencyIso) p.push(`cr=${currencyIso}`);
  if(description) p.push(`description[${lang}]=${encodeURIComponent(description)}`);
  if(detailBase64) p.push(`detail=${detailBase64}`);
  const b64 = toBase64(p.join(';'));
  return `${checkoutOrigin}/${b64}`;
}
