import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Минимальный загрузчик .env, чтобы не тянуть лишнюю зависимость
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const env = process.env;
const num = (value, fallback) => {
  const n = Number(value);
  return value === undefined || value === '' || Number.isNaN(n) ? fallback : n;
};
const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

const mailPort = num(env.SMTP_PORT, 465);

export const config = {
  host: env.HOST || '0.0.0.0',
  port: num(env.PORT, 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data'),

  bootstrapName: env.BOOTSTRAP_NAME || 'Замерщик',
  bootstrapPin: env.BOOTSTRAP_PIN || '0000',
  tokenTtlMs: num(env.TOKEN_TTL_HOURS, 24 * 30) * 3600_000,

  catalogTtlSec: num(env.CATALOG_TTL_SEC, 1800),

  amigo: {
    base: (env.AMIGO_BASE || 'https://1c87433dfbfcece8e76a55b998f72ec9.customizer.amigo.ru').replace(/\/+$/, ''),
    timeoutMs: num(env.AMIGO_TIMEOUT_MS, 15000),
    // Логин сотрудника-дилера в Amigo.
    // Без него ткани систем «Шторы плиссе» и «Шторы гофре» не отдаются:
    // анонимно эти списки пустые, а с токеном приходят настоящие.
    login: env.AMIGO_LOGIN || '',
    pass: env.AMIGO_PASS || '',
  },

  // ── Валюта ────────────────────────────────────────────────────────────
  // Прайс Amigo ведётся в долларах: в самой системе отчёты так и подписаны —
  // «На сумму, USD», «Наценка, USD». А ответ /api/calculate на анонимный запрос
  // приходит с меткой RUB — это валюта по умолчанию для гостя, а не ваша.
  // Поэтому валюту прайса и курс задаём явно.
  currency: {
    // В чём приходит прайс: USD или RUB
    source: (env.PRICE_SOURCE_CURRENCY || 'USD').toUpperCase(),
    // В чём показываем замерщику
    target: (env.PRICE_TARGET_CURRENCY || 'RUB').toUpperCase(),
    // Ручной курс. Пусто = брать официальный курс ЦБ РФ автоматически
    rate: env.USD_RATE ? Number(env.USD_RATE) : null,
    // cbr = курс ЦБ РФ (без ключей), manual = только USD_RATE
    provider: (env.RATE_PROVIDER || 'cbr').toLowerCase(),
    // Сколько часов держать курс в кэше (ЦБ обновляет раз в сутки)
    ttlHours: num(env.RATE_TTL_HOURS, 12),
    url: env.RATE_URL || 'https://www.cbr-xml-daily.ru/daily_json.js',
  },

  mail: {
    host: env.SMTP_HOST || '',
    port: mailPort,
    // 465 — SSL сразу, 587 — STARTTLS
    secure: bool(env.SMTP_SECURE, mailPort === 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
    to: (env.MAIL_TO || env.SMTP_USER || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    subjectPrefix: env.MAIL_SUBJECT_PREFIX || 'Заявка с замера',
  },

  uploadLimitMb: num(env.UPLOAD_LIMIT_MB, 25),
};