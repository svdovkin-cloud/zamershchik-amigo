// Хэширование PIN. Вынесено в отдельный модуль, чтобы db.js и auth.js
// могли использовать его без циклической зависимости.

import crypto from 'node:crypto';

export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

export function verifyPin(pin, salt, hash) {
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  const known = Buffer.from(hash, 'hex');
  if (candidate.length !== known.length) return false;
  return crypto.timingSafeEqual(candidate, known);
}
