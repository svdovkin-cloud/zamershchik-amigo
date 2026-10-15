import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Настройки, которые меняет администратор из приложения.
// Живут в data/settings.json и перекрывают значения из .env,
// поэтому смену адреса почты не нужно делать через файл и перезапуск.

const settingsFile = () => path.join(config.dataDir, 'settings.json');

function defaults() {
  return {
    mailTo: config.mail.to.join(', '),
    mailFrom: config.mail.from,
    subjectPrefix: config.mail.subjectPrefix,
    updatedAt: null,
  };
}

export function readSettings() {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { ...defaults(), ...stored };
  } catch {
    return defaults();
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validate(patch) {
  const errors = [];
  const clean = {};

  if (patch.mailTo !== undefined) {
    const list = parseRecipients(patch.mailTo);
    if (!list.length) errors.push('Укажите хотя бы один адрес получателя');
    if (list.length > 10) errors.push('Слишком много получателей, максимум 10');
    const bad = list.filter((address) => !EMAIL_RE.test(address));
    if (bad.length) errors.push(`Некорректный адрес: ${bad.join(', ')}`);
    if (!errors.length) clean.mailTo = list.join(', ');
  }

  if (patch.mailFrom !== undefined) {
    const value = String(patch.mailFrom).trim();
    // допускаем форму "Название <адрес>"
    const inner = value.match(/<([^>]+)>/);
    const check = inner ? inner[1] : value;
    if (value && !EMAIL_RE.test(check)) errors.push(`Некорректный адрес отправителя: ${value}`);
    if (!errors.length) clean.mailFrom = value;
  }

  if (patch.subjectPrefix !== undefined) {
    const value = String(patch.subjectPrefix).trim();
    if (value.length > 60) errors.push('Тема письма длиннее 60 символов');
    if (!errors.length) clean.subjectPrefix = value || 'Заявка с замера';
  }

  return { errors, clean };
}

/** Сохраняет настройки. Возвращает { settings } либо { errors }. */
export function updateSettings(patch) {
  const { errors, clean } = validate(patch || {});
  if (errors.length) return { errors };

  const current = readSettings();
  const next = { ...current, ...clean, updatedAt: new Date().toISOString() };

  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { settings: next };
}

/** Куда физически уходит письмо. */
export const recipients = () => {
  const list = parseRecipients(readSettings().mailTo);
  return list.length ? list : config.mail.to;
};

export const mailFrom = () => readSettings().mailFrom || config.mail.from;

export const subjectPrefix = () => readSettings().subjectPrefix || config.mail.subjectPrefix;

/** Для проверки связи: настройки считаются настроенными, если есть получатель. */
export const hasRecipients = () => recipients().length > 0;