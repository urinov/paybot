// utils/clickSign.js
import crypto from 'crypto';

export function buildPrepareSign({ click_trans_id, service_id, secret_key, merchant_trans_id, amount, action, sign_time }) {
  const s = '' + click_trans_id + service_id + secret_key + merchant_trans_id + amount + action + sign_time;
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

export function buildCompleteSign({ click_trans_id, service_id, secret_key, merchant_trans_id, merchant_prepare_id, amount, action, sign_time }) {
  const s = '' + click_trans_id + service_id + secret_key + merchant_trans_id + merchant_prepare_id + amount + action + sign_time;
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}
