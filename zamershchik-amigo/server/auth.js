// Пользователи и вход по PIN. Раньше лежали в users.json, теперь за
// интерфейсом db.js: локально — тот же файл, на Render — таблица users
// в Supabase. Хэширование PIN вынесено в pin.js.

import crypto from 'node:crypto';
import { config } from './config.js';
import { hashPin, verifyPin } from './pin.js';
import { listUsers, saveUser, deleteUser, ensureBootstrapUser } from './db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(value) {
  const email = String(value ?? '').trim();
  if (!email) return null; // почта необязательна
  if (!EMAIL_RE.test(email)) throw new Error(`Некорректный адрес почты: ${email}`);
  if (email.length > 120) throw new Error('Адрес почты слишком длинный');
  return email;
}

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Укажите имя');
  if (name.length > 80) throw new Error('Имя длиннее 80 символов');
  return name;
}

function cleanPin(value) {
  const pin = String(value ?? '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN должен состоять из 4–8 цифр');
  return pin;
}

export async function listUsersAsync() {
  const users = await listUsers();
  return users.map(({ id, name, email, role, createdAt }) => ({ id, name, email: email ?? '', role, createdAt }));
}

/** Кто автор заявки — по нему в письме ставятся Reply-To и подпись. */
export async function profileById(id) {
  const users = await listUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email ?? '', role: user.role };
}

async function replaceUser(id, patch) {
  const users = await listUsers();
  const index = users.findIndex((u) => u.id === id);
  if (index < 0) throw new Error('Замерщик не найден');
  users[index] = { ...users[index], ...patch };
  await saveUser(users[index]);
  return profileById(id);
}

/** Замерщик правит свой профиль. PIN здесь не меняется — для этого отдельный запрос. */
export async function updateOwnProfile(id, { name, email }) {
  const patch = {};
  if (name !== undefined) patch.name = cleanName(name);
  if (email !== undefined) patch.email = cleanEmail(email);
  if (!Object.keys(patch).length) throw new Error('Нечего менять');
  return replaceUser(id, patch);
}

/** Смена своего PIN. Требует текущий — телефон может быть разблокирован. */
export async function changeOwnPin(id, { currentPin, newPin }) {
  const users = await listUsers();
  const user = users.find((u) => u.id === id);
  if (!user) throw new Error('Замерщик не найден');
  if (!verifyPin(String(currentPin ?? '').trim(), user.salt, user.hash)) {
    throw new Error('Текущий PIN указан неверно');
  }
  const pin = cleanPin(newPin);
  if (verifyPin(pin, user.salt, user.hash)) throw new Error('Новый PIN совпадает с текущим');
  // Новую соль при смене PIN: старый хэш больше не подходит
  const { salt, hash } = hashPin(pin);
  return replaceUser(id, { salt, hash });
}

/** Администратор правит любого: имя, почту, PIN, роль. */
export async function updateUserById(id, { name, email, pin, role }) {
  const users = await listUsers();
  const current = users.find((u) => u.id === id);
  if (!current) throw new Error('Замерщик не найден');

  const patch = {};
  if (name !== undefined) patch.name = cleanName(name);
  if (email !== undefined) patch.email = cleanEmail(email);
  if (pin !== undefined && String(pin).trim() !== '') {
    const value = cleanPin(pin);
    const { salt, hash } = hashPin(value);
    patch.salt = salt;
    patch.hash = hash;
  }

  if (role !== undefined && role !== current.role) {
    if (!['admin', 'measurer'].includes(role)) throw new Error('Неизвестная роль');
    // Последнего администратора понижать нельзя — иначе в админку не попасть
    const admins = users.filter((u) => u.role === 'admin');
    if (current.role === 'admin' && role !== 'admin' && admins.length <= 1) {
      throw new Error('Нельзя убрать права у единственного администратора');
    }
    patch.role = role;
  }

  if (!Object.keys(patch).length) throw new Error('Нечего менять');
  return replaceUser(id, patch);
}

export async function addUser({ name, pin, email, role = 'measurer' }) {
  const clean = { name: cleanName(name), pin: cleanPin(pin), email: cleanEmail(email ?? '') };

  const users = await listUsers();
  if (users.some((u) => u.name.toLowerCase() === clean.name.toLowerCase())) {
    throw new Error(`Пользователь «${clean.name}» уже есть`);
  }
  const { salt, hash } = hashPin(clean.pin);
  const user = {
    id: crypto.randomUUID(),
    name: clean.name,
    email: clean.email,
    role,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  await saveUser(user);
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export async function removeUser(name) {
  const users = await listUsers();
  const left = users.filter((u) => u.name.toLowerCase() !== String(name || '').toLowerCase());
  if (left.length === users.length) throw new Error('Такого замерщика нет');
  await deleteUser(users.find((u) => u.name.toLowerCase() === String(name || '').toLowerCase()).id);
  return true;
}

export async function removeUserById(id) {
  const users = await listUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new Error('Замерщик не найден');
  await deleteUser(id);
  return target.name;
}

export async function countUsers() {
  return (await listUsers()).length;
}

/** Первый запуск: создаём замерщика из .env, чтобы приложение не было «закрытым». */
export function bootstrapUser() {
  return ensureBootstrapUser({ name: config.bootstrapName, pin: config.bootstrapPin, role: 'admin' });
}

/** Список для выбора при входе: без почты и без ничего лишнего. */
export async function listUsersForLogin() {
  const users = await listUsers();
  return users.map(({ id, name, role }) => ({ id, name, role }));
}

export async function findUserById(id) {
  const users = await listUsers();
  const user = users.find((u) => u.id === id);
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email ?? '', role: user.role };
}

async function findUserByPin(pin) {
  const clean = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(clean)) return null;
  // PIN короткий — перебор идёт по всем, задержка тут не нужна,
  // реальная защита — это HTTPS и то, что снаружи сервер не светится наружу.
  const users = await listUsers();
  for (const user of users) {
    if (verifyPin(clean, user.salt, user.hash)) {
      return { id: user.id, name: user.name, role: user.role };
    }
  }
  return null;
}

// ─── Токены входа ─────────────────────────────────────────────────────────
const tokens = new Map(); // token -> { user, expiresAt }

export async function login(pin, userId) {
  // Если человек выбран — PIN проверяется только у него.
  // Так два замерщика с одинаковым кодом не путаются между собой.
  let user = null;
  if (userId) {
    const users = await listUsers();
    const chosen = users.find((u) => u.id === userId);
    if (chosen && verifyPin(String(pin ?? '').trim(), chosen.salt, chosen.hash)) {
      user = { id: chosen.id, name: chosen.name, role: chosen.role };
    }
  } else {
    user = await findUserByPin(pin);
  }

  if (!user) return null;
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { user, expiresAt: Date.now() + config.tokenTtlMs });
  return { token, user };
}

export function userByToken(token) {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry.user;
}

export function logout(token) {
  return tokens.delete(token);
}
