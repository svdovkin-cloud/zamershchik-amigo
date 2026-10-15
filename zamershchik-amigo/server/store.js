import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Заявки лежат построчно в orders.jsonl — файл можно просто открыть и почитать,
// а Append не портит историю при обрыве связи.
const ordersFile = () => path.join(config.dataDir, 'orders.jsonl');

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export function readOrders() {
  const file = ordersFile();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // битая строка — пропускаем, не роняем всё
    }
  }
  return out;
}

function writeOrders(orders) {
  ensureDir();
  const tmp = `${ordersFile()}.tmp`;
  fs.writeFileSync(tmp, orders.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, ordersFile());
}

export function saveOrder(order) {
  ensureDir();
  fs.appendFileSync(ordersFile(), `${JSON.stringify(order)}\n`, 'utf8');
  return order;
}

export function updateOrder(id, patch) {
  const orders = readOrders();
  const index = orders.findIndex((o) => o.id === id);
  if (index < 0) return null;
  orders[index] = { ...orders[index], ...patch, updatedAt: new Date().toISOString() };
  writeOrders(orders);
  return orders[index];
}

export function findOrder(id) {
  return readOrders().find((o) => o.id === id) || null;
}

/** Номер заявки вида AM-20261009-004 — читаемый, сортируется как строка. */
export function nextOrderNumber(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const prefix = `AM-${y}${m}${d}`;
  const today = readOrders().filter((o) => String(o.id || '').startsWith(prefix));
  const max = today.reduce((acc, o) => {
    const tail = Number(String(o.id).slice(prefix.length + 1));
    return Number.isFinite(tail) && tail > acc ? tail : acc;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}