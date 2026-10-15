import { config } from './config.js';

// Курс USD → RUB. Прайс Amigo в долларах, замерщику показываем в рублях,
// как привык видеть цены в заявке.
//
// Приоритет источников:
//   1. RATE_PROVIDER=manual или заданный USD_RATE — курс из .env (ваш выбор главный)
//   2. Курс ЦБ РФ — официальный, обновляется сам, ключи не нужны
//
// Если ЦБ недоступен (нет интернета на сервере), остаёмся на последнем
// удачном курсе и честно помечаем это в заявке.

const SYMBOLS = { USD: '$', RUB: '₽', EUR: '€', KZT: '₸', BYN: 'Br' };

let cached = null; // { rate, date, source, fetchedAt }

async function fetchCbrRate() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(config.currency.url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`ЦБ РФ ответил ${response.status}`);
    const data = await response.json();
    const usd = data?.Valute?.USD ?? data?.USD;
    if (!usd?.Value) throw new Error('В ответе ЦБ РФ нет курса доллара');
    const nominal = Number(usd.Nominal) || 1;
    const value = Number(usd.Value) / nominal; // рублей за одну единицу
    if (!Number.isFinite(value) || value <= 0) throw new Error('Курс не похож на число');
    return { rate: value, date: (data.Date || '').slice(0, 10), source: 'ЦБ РФ' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Текущий курс. Никогда не бросает: если всё сломалось, отдаёт последний
 * удачный, а в самом худшем случае — 1, чтобы заявка не потерялась.
 */
export async function getRate() {
  const ttlMs = config.currency.ttlHours * 3600_000;
  if (cached && Date.now() - cached.fetchedAt < ttlMs) return cached;

  // Ручной курс из .env — не перебиваем его автоподменой
  if (config.currency.provider === 'manual' || config.currency.rate) {
    cached = {
      rate: config.currency.rate || 1,
      date: 'задан вручную',
      source: config.currency.rate ? 'курс из .env' : 'не задан',
      fetchedAt: Date.now(),
      stale: false,
    };
    return cached;
  }

  try {
    const fresh = await fetchCbrRate();
    cached = { ...fresh, fetchedAt: Date.now(), stale: false };
  } catch (error) {
    if (cached) {
      // Вчерашний курс лучше, чем никакого: заявка уйдёт, но с пометкой
      cached = { ...cached, stale: true, error: error.message };
    } else {
      cached = {
        rate: config.currency.rate || 1,
        date: 'не удалось получить',
        source: 'запасной',
        fetchedAt: Date.now(),
        stale: true,
        error: error.message,
      };
    }
  }
  return cached;
}

export const symbolFor = (code) => SYMBOLS[String(code || '').toUpperCase()] || '';

/** Переводит сумму из валюты прайса в валюту показа. */
export function convert(value, rate) {
  return Math.round((Number(value) || 0) * (Number(rate) || 1) * 100) / 100;
}

/** Нужно ли вообще пересчитывать. */
export const needsConversion = () => config.currency.source !== config.currency.target;

/** Описание курса для письма и для телефона. */
export async function rateInfo() {
  const { rate, date, source, stale } = await getRate();
  return {
    rate,
    date,
    source,
    stale,
    from: config.currency.source,
    to: config.currency.target,
    fromSymbol: symbolFor(config.currency.source),
    toSymbol: symbolFor(config.currency.target),
    text: needsConversion()
      ? `${rate} ${symbolFor(config.currency.target)} за 1 ${symbolFor(config.currency.source)} · ${source}, ${date}${stale ? ' (данные не удалось обновить)' : ''}`
      : `Прайс уже в ${config.currency.target}`,
  };
}