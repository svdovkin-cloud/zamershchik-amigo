import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const usersFile = () => path.join(config.dataDir, 'users.json');

function readUsers() {
  const file = usersFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(usersFile(), `${JSON.stringify(users, null, 2)}\n`, 'utf8');
}

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

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPin(pin, salt, hash) {
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  const known = Buffer.from(hash, 'hex');
  if (candidate.length !== known.length) return false;
  return crypto.timingSafeEqual(candidate, known);
}

export function listUsers() {
  return readUsers().map(({ id, name, email, role, createdAt }) => ({ id, name, email: email ?? '', role, createdAt }));
}

/** Кто автор заявки — по нему в письме ставятся Reply-To и подпись. */
export function profileById(id) {
  const user = readUsers().find((u) => u.id === id);
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email ?? '', role: user.role };
}

function replaceUser(id, patch) {
  const users = readUsers();
  const index = users.findIndex((u) => u.id === id);
  if (index < 0) throw new Error('Замерщик не найден');
  users[index] = { ...users[index], ...patch };
  writeUsers(users);
  return profileById(id);
}

/** Замерщик правит свой профиль. PIN здесь не меняется — для этого отдельный запрос. */
export function updateOwnProfile(id, { name, email }) {
  const patch = {};
  if (name !== undefined) patch.name = cleanName(name);
  if (email !== undefined) patch.email = cleanEmail(email);
  if (!Object.keys(patch).length) throw new Error('Нечего менять');
  return replaceUser(id, patch);
}

/** Смена своего PIN. Требует текущий — телефон может быть разблокирован. */
export function changeOwnPin(id, { currentPin, newPin }) {
  const user = readUsers().find((u) => u.id === id);
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
export function updateUserById(id, { name, email, pin, role }) {
  const current = readUsers().find((u) => u.id === id);
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
    const admins = readUsers().filter((u) => u.role === 'admin');
    if (current.role === 'admin' && role !== 'admin' && admins.length <= 1) {
      throw new Error('Нельзя убрать права у единственного администратора');
    }
    patch.role = role;
  }

  if (!Object.keys(patch).length) throw new Error('Нечего менять');
  return replaceUser(id, patch);
}

export function addUser({ name, pin, email, role = 'measurer' }) {
  const clean = { name: cleanName(name), pin: cleanPin(pin), email: cleanEmail(email ?? '') };

  const users = readUsers();
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
  users.push(user);
  writeUsers(users);
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

export function removeUser(name) {
  const users = readUsers();
  const left = users.filter((u) => u.name.toLowerCase() !== String(name || '').toLowerCase());
  if (left.length === users.length) throw new Error('Такого замерщика нет');
  writeUsers(left);
  return true;
}

export function removeUserById(id) {
  const users = readUsers();
  const target = users.find((u) => u.id === id);
  if (!target) throw new Error('Замерщик не найден');
  writeUsers(users.filter((u) => u.id !== id));
  return target.name;
}

export function countUsers() {
  return readUsers().length;
}

/** Первый запуск: создаём замерщика из .env, чтобы приложение не было «закрытым». */
export function ensureBootstrapUser() {
  if (readUsers().length > 0) return null;
  const user = addUser({ name: config.bootstrapName, pin: config.bootstrapPin, role: 'admin' });
  return user;
}

/** Список для выбора при входе: без почты и без ничего лишнего. */
export function listUsersForLogin() {
  return readUsers().map(({ id, name, role }) => ({ id, name, role }));
}

export function findUserById(id) {
  const user = readUsers().find((u) => u.id === id);
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email ?? '', role: user.role };
}

function findUserByPin(pin) {
  const clean = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(clean)) return null;
  // PIN короткий — перебор идёт по всем, задержка тут не нужна,
  // реальная защита — это HTTPS и то, что снаружи сервер не светится наружу.
  for (const user of readUsers()) {
    if (verifyPin(clean, user.salt, user.hash)) {
      return { id: user.id, name: user.name, role: user.role };
    }
  }
  return null;
}

// ─── Токены входа ─────────────────────────────────────────────────────────
const tokens = new Map(); // token -> { user, expiresAt }

export function login(pin, userId) {
  // Если человек выбран — PIN проверяется только у него.
  // Так два замерщика с одинаковым кодом не путаются между собой.
  let user = null;
  if (userId) {
    const chosen = readUsers().find((u) => u.id === userId);
    if (chosen && verifyPin(String(pin ?? '').trim(), chosen.salt, chosen.hash)) {
      user = { id: chosen.id, name: chosen.name, role: chosen.role };
    }
  } else {
    user = findUserByPin(pin);
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