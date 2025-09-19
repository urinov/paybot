// store.js — juda sodda in-memory "DB"
export const Orders = new Map(); // orderId -> { amount, state, userId, chat_id, deliver_url, ... }

let counter = 1;
export function nextOrderId() {
  const id = String(counter).padStart(7, '0');
  counter += 1;
  return id;
}
