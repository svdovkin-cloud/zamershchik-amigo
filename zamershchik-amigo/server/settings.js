// Настройки, которые меняет администратор из приложения.
// Раньше жили в data/settings.json, теперь за интерфейсом db.js:
// локально — тот же файл, на Render — таблица settings в Supabase.

import { readSettings, writeSettings } from './db.js';
import { config } from './config.js';

function defaults() {
  return {
    mailTo: config.mail.to.join(', '),
    mailFrom: config.mail.from,
    subjectPrefix: config.mail.subjectPrefix,
    updatedAt: null,
  };
}

export async function readSettingsAsync() {
  const stored = await readSettings();
  return { ...defaults(), ...(stored || {}) };
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
export async function updateSettings(patch) {
  const { errors, clean } = validate(patch || {});
  if (errors.length) return { errors };

  const current = await readSettingsAsync();
  const next = { ...current, ...clean, updatedAt: new Date().toISOString() };

  await writeSettings(next);
  return { settings: next };
}

/** Куда физически уходит письмо. */
export async function recipients() {
  const list = parseRecipients((await readSettingsAsync()).mailTo);
  return list.length ? list : config.mail.to;
}

export async function mailFrom() {
  return (await readSettingsAsync()).mailFrom || config.mail.from;
}

export async function subjectPrefix() {
  return (await readSettingsAsync()).subjectPrefix || config.mail.subjectPrefix;
}

/** Для проверки связи: настройки считаются настроенными, если есть получатель. */
export async function hasRecipients() {
  return (await recipients()).length > 0;
}
