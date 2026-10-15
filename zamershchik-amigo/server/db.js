// Хранилище данных. Два бэкенда за одним интерфейсом:
//
//   1. Локальные JSON-файлы (config.dataDir) — работает без настройки,
//      используется макетом и при разработке.
//   2. Supabase (PostgREST) — включается, когда заданы SUPABASE_URL и
//      SUPABASE_KEY. Нужен для Render: у него файловая система временная,
//      без базы заказы терялись бы при каждом пересборке.
//
// Все запросы к Supabase идут через fetch, поэтому новых npm-зависимостей
// нет — достаточно Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { hashPin } from './pin.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

// ─── Supabase (PostgREST) ───────────────────────────────────────────────────

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sb(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: sbHeaders(options.headers),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const sbListUsers = () => sb('users?select=*&order=created_at.asc').then((rows) => rows || []);

const sbSaveUser = (user) =>
  sb('users', {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(user),
  }).then((rows) => Array.isArray(rows) ? rows[0] : user);

const sbDeleteUser = (id) => sb(`users?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });

const sbReadSettings = () =>
  sb('settings?id=eq.1&select=data').then((rows) => (rows && rows.length ? rows[0].data : null));

const sbWriteSettings = (data) =>
  sb('settings', {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify({ id: 1, data }),
  });

const sbListOrders = () =>
  sb('orders?select=*&order=created_at.asc').then((rows) => rows || []);

const sbAppendOrder = (order) =>
  sb('orders', {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ id: order.id, data: order }),
  });

const sbUpdateOrder = (id, patch) =>
  sb(`orders?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ data: { ...patch } }),
  });

// ─── Локальные файлы ────────────────────────────────────────────────────────

const usersFile = () => path.join(config.dataDir, 'users.json');
const ordersFile = () => path.join(config.dataDir, 'orders.jsonl');

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readUsers() {
  const file = usersFile();
  if (!fs.existsSync(file)) return [];
  const parsed = readJson(file, []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeUsers(users) {
  ensureDir();
  const tmp = `${usersFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, usersFile());
}

function readOrders() {
  const file = ordersFile();
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
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

// ─── Интерфейс ──────────────────────────────────────────────────────────────

export const isDatabase = () => useSupabase;

export function listUsers() {
  return useSupabase ? sbListUsers() : Promise.resolve(readUsers());
}

export function saveUser(user) {
  return useSupabase ? sbSaveUser(user) : Promise.resolve(writeUsers([...readUsers().filter((u) => u.id !== user.id), user]));
}

export function deleteUser(id) {
  return useSupabase ? sbDeleteUser(id) : Promise.resolve(writeUsers(readUsers().filter((u) => u.id !== id)));
}

/** Настройки одним объектом — как их меняет администратор. */
export function readSettings() {
  return useSupabase ? sbReadSettings() : Promise.resolve(readJson(path.join(config.dataDir, 'settings.json'), null));
}

export function writeSettings(data) {
  return useSupabase
    ? sbWriteSettings(data)
    : Promise.resolve(
        (() => {
          ensureDir();
          fs.writeFileSync(path.join(config.dataDir, 'settings.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        })(),
      );
}

export function readOrders() {
  return useSupabase ? sbListOrders() : Promise.resolve(readOrders());
}

export function appendOrder(order) {
  if (useSupabase) return sbAppendOrder(order);
  ensureDir();
  fs.appendFileSync(ordersFile(), `${JSON.stringify(order)}\n`, 'utf8');
  return Promise.resolve(order);
}

export function updateOrder(id, patch) {
  if (useSupabase) {
    return sbUpdateOrder(id, patch).then((rows) => (Array.isArray(rows) && rows.length ? rows[0].data : null));
  }
  const orders = readOrders();
  const index = orders.findIndex((o) => o.id === id);
  if (index < 0) return Promise.resolve(null);
  orders[index] = { ...orders[index], ...patch, updatedAt: new Date().toISOString() };
  const tmp = `${ordersFile()}.tmp`;
  fs.writeFileSync(tmp, orders.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, ordersFile());
  return Promise.resolve(orders[index]);
}

export async function findOrder(id) {
  const orders = await readOrders();
  return orders.find((o) => o.id === id) || null;
}

/** Номер заявки вида AM-20261015-001 — читаемый, сортируется как строка. */
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

/** Первый запуск: создаём замерщика из .env, чтобы приложение не было «закрытым». */
export function ensureBootstrapUser({ name, pin, role = 'admin' }) {
  if (readUsers().length > 0) return null;
  const user = {
    id: crypto.randomUUID(),
    name,
    email: null,
    role,
    ...hashPin(pin),
    createdAt: new Date().toISOString(),
  };
  return saveUser(user).then(() => user);
}
