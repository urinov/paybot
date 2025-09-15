// store.js — buyurtmalar uchun umumiy in-memory storage
export const orders = new Map(); // order_id -> { amount(=tiyin), state, ... }
let orderCounter = 1;

export function nextOrderId() {
  const id = String(orderCounter++).padStart(7, '0');
  return id;
}
