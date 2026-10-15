// Электропривод для рулонных моделей, у которых его нет в каталоге Amigo.
//
// В Amigo опция «Электропривод» есть только у ZIP, ZIP ROOF и LOCK, и там же
// есть выбор конкретного комплекта. Остальным 45 рулонным моделям выбирать
// нечего, поэтому замерщик просто отмечает «нужен привод» — а доплату мы
// прибавляем сами: в расчёте Amigo она всегда 0 (проверено, options_price = 0).
//
// Сумма правится в data/electric-kits.json, перезапуск не нужен.

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FALLBACK_RUB = 5000;

const file = () => path.join(config.dataDir, 'electric-kits.json');

let cached = null;
let cachedAt = 0;
// Файл маленький, но читать его на каждый запрос незачем
const TTL_MS = 30_000;

/** Доплата за электропривод в рублях за одно изделие. */
export function motorSurchargeRub() {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  let value = FALLBACK_RUB;
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const parsed = Number(data?.motorSurchargeRub);
    if (Number.isFinite(parsed) && parsed >= 0) value = parsed;
  } catch {
    // файла нет или он повреждён — работаем с запасной суммой
  }
  cached = value;
  cachedAt = Date.now();
  return value;
}

/**
 * Прибавка к цене. Amigo считает в валюте прайса (USD), доплата задана в
 * рублях — поэтому переводим её в ту же валюту по текущему курсу и добавляем.
 */
export function addMotorSurcharge(rubAmount, rate) {
  const surcharge = motorSurchargeRub();
  const totalRub = rubAmount + surcharge;
  const source = rate > 0 ? totalRub / rate : rubAmount;
  return { totalRub, source, surcharge };
}
