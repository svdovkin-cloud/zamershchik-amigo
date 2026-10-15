import { config } from './config.js';
import { kitsForModel } from './electric-kits.js';

// Клиент Amigo Customizer — это и есть «база знаний» приложения.
// Каталог систем/моделей/тканей/опций и расчёт цены отдаются без авторизации,
// поэтому замерщик видит ровно те цены, что видит менеджер в конфигураторе.

const cache = new Map();

/** Токен Amigo. Получаем один раз и переиспользуем до отказа. */
let authToken = null;
let authFailedAt = 0;

async function fetchAuthToken() {
  if (!config.amigo.login || !config.amigo.pass) return null;
  // после неудачной попытки не долбим сервер: ждём 10 минут
  if (authFailedAt && Date.now() - authFailedAt < 10 * 60_000) return null;
  if (authToken) return authToken;

  try {
    const response = await fetch(`${config.amigo.base}/api/get-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ login: config.amigo.login, password: config.amigo.pass }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const token = data?.token || data?.access_token || null;
    if (!token) throw new Error('в ответе нет токена');
    authToken = String(token).startsWith('Bearer ') ? String(token) : `Bearer ${token}`;
    authFailedAt = 0;
    return authToken;
  } catch (error) {
    authFailedAt = Date.now();
    console.warn(`[amigo] Не удалось войти: ${error.message}. Работаем без токена.`);
    return null;
  }
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlSec = config.catalogTtlSec) {
  cache.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  return value;
}

/** Изолирует запросы по кнопке: чтобы не долбить Amigo при 10 одинаковых тапах. */
function singleFlight(key, run) {
  const hit = cacheGet(key);
  if (hit) return Promise.resolve(hit);
  const inflight = cache.get(`inflight:${key}`);
  if (inflight) return inflight;
  const promise = run()
    .then((value) => cacheSet(key, value))
    .catch((error) => {
      cache.delete(`inflight:${key}`);
      throw error;
    });
  cache.set(`inflight:${key}`, promise);
  promise.finally(() => cache.delete(`inflight:${key}`));
  return promise;
}

async function request(path, { method = 'GET', body, timeoutMs = config.amigo.timeoutMs, retry = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await fetchAuthToken();
    const response = await fetch(`${config.amigo.base}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Amigo вернул не JSON (${response.status}) по адресу ${path}`);
    }
    // Токен протух — берём новый и повторяем ровно один раз
    if (response.status === 401 && retry && token) {
      authToken = null;
      return request(path, { method, body, timeoutMs, retry: false });
    }
    if (!response.ok) {
      const message = data?.errorMessage || `HTTP ${response.status}`;
      throw new Error(`Amigo API: ${message}`);
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Amigo API не ответил за ${timeoutMs} мс (${path})`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const imageUrl = (path) => (path ? `${config.amigo.base}${path}` : null);

/** Авторизованы ли мы в Amigo: от этого зависят ткани плиссе и гофре. */
export const isAuthorized = () => Boolean(config.amigo.login && config.amigo.pass);

// ─── Каталог ──────────────────────────────────────────────────────────────

/** Системы и модели: [{ id, name, models: [{ id, name }] }] */
export function getCatalog() {
  return singleFlight('catalog', async () => {
    const [systems, models] = await Promise.all([
      request('/api/systems'),
      request('/api/models'),
    ]);

    const systemsById = new Map((systems || []).map((s) => [s.id, s]));
    return (models || [])
      .map((system) => ({
        id: system.id,
        name: system.name,
        vendorCode: system.vendor_code || null,
        image: imageUrl(system.image),
        models: (system.models || [])
          .map((model) => ({
            id: model.id,
            name: model.name,
            code1c: model.code_1c || null,
            image: imageUrl(model.image),
            priceType: model.price_type ?? null,
            // Электрика в каталоге заведена только у ZIP, ZIP ROOF и LOCK.
            // Список для остальных рулонных моделей приходит из файла
            // data/electric-kits.json — его можно править без перезапуска.
            electricKits: kitsForModel(model.name),
            // У плиссе и гофре модель двухуровневая: «Модели MIDI» — это
            // семейство из 81 варианта (P1600, P2000…), и только у варианта
            // есть ткани, опции и цена. Без этого раздела они выглядят пустыми.
            subModels: (model.sub_models || [])
              .map((sub) => ({
                id: sub.id,
                name: sub.name,
                code1c: sub.code_1c || null,
                description: sub.description || null,
                image: imageUrl(sub.image_scheme),
              }))
              .filter((sub) => sub.id),
          }))
          .filter((model) => model.id),
      }))
      .filter((system) => system.models.length > 0)
      .sort((a, b) => {
        const order = (list, id) => {
          const index = list.findIndex((s) => s.id === id);
          return index < 0 ? 0 : index - list.length;
        };
        return order(systemsById, a.id) - order(systemsById, b.id);
      });
  });
}

/** Ткани модели — то, что замерщик листает на клиенте. */
export function getMaterials(modelId) {
  return singleFlight(`materials:${modelId}`, async () => {
    const rows = await request(`/api/models/${modelId}/materials`);
    return (rows || [])
      .map((row) => row.material || row)
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        name: m.name,
        vendorCode: m.vendor_code || null,
        collection: m.material_collection?.name || null,
        priceCategory: m.price_category_name || null,
        availability: m.availability ?? null,
        minPrice: m.min_price ?? null,
        colorName: m.color?.name || null,
        colorHex: m.color?.rgb_code || null,
        swatch: imageUrl(m.preview || m.image),
        thumb: imageUrl(m.image),
      }));
  });
}

/** Опции модели: цвет фурнитуры, сторона управления, длина управления и т.п. */
export function getOptions(modelId) {
  return singleFlight(`options:${modelId}`, async () => {
    const rows = await request(`/api/models/${modelId}/options`);
    return (rows || [])
      .filter((o) => o && o.id)
      .map((o) => ({
        id: o.id,
        name: o.name,
        code: o.code_1c || String(o.id),
        type: o.type, // S — выбор из списка, R — число/размер, V — вычисляемое
        fieldType: o.field_type,
        required: !!o.is_required,
        // Значения сервер подставляет сам (вариантов нет) — у замерщика не спрашиваем
        auto: !(o.options_values || []).length,
        // А вот значение по умолчанию показываем: замерщик должен видеть и менять его
        defaultValue: o.option_default ?? null,
        values: (o.options_values || [])
          .filter((v) => v && v.id)
          .map((v) => ({
            id: v.id,
            name: v.name,
            value: v.value ?? null,
            colorHex: v.color?.rgb_code || null,
            swatch: imageUrl(v.image),
            isDefault: !!v.is_default,
          })),
      }));
  });
}

export function getModelInfo(modelId) {
  return singleFlight(`model-info:${modelId}`, async () => {
    const info = await request(`/api/models/${modelId}/info`);
    return {
      name: info.full_name || null,
      description: info.full_description || null,
      media: (info.media || []).map(imageUrl).filter(Boolean),
    };
  });
}

// ─── Расчёт ───────────────────────────────────────────────────────────────

export function buildCalcPayload({ modelId, materialId, sizes, optionsValues, uuid = '' }) {
  return {
    uuid: uuid || '',
    model_id: Number(modelId),
    material_id: Number(materialId),
    sizes: {
      width: Number(sizes?.width) || 0,
      height: Number(sizes?.height) || 0,
    },
    options_values: optionsValues && typeof optionsValues === 'object' ? optionsValues : {},
  };
}

/**
 * Живая цена. Никогда не берём цену с телефона — считает только Amigo.
 *
 * ВАЖНО: у анонимного расчёта Amigo в ответе лежит currency_code: "RUB",
 * хотя сам прайс ведётся в долларах (в отчётах системы так и написано:
 * «На сумму, USD»). Это валюта по умолчанию для гостя, а не валюта прайса.
 * Поэтому метку из ответа игнорируем, а валюту берём из настроек.
 */
export async function calculate(payload) {
  const data = await request('/api/calculate', { method: 'POST', body: payload });
  return {
    price: Number(data.price) || 0,
    cost: Number(data.cost) || 0,
    discount: Number(data.discount) || 0,
    optionsPrice: Number(data.options_price) || 0,
    optionsCost: Number(data.options_cost) || 0,
    totalPrice: Number(data.total_price) || 0,
    area: Number(data.area) || 0,
    isWarranty: !!data.is_warranty,
    autoOptions: data.options_values || {},
    // Сообщения приходят по-русски и годятся как подсказки замерщику:
    // «Выберите материал», «Введите размеры!»
    messages: (data.messages || []).map((m) => ({ type: m.type || 'info', text: m.text })),
  };
}

/** Раскрой: какие размеры ткани сервер подобрал под изделие. */
export async function calculateOptionsValues(payload) {
  const data = await request('/api/calculate-options-values', { method: 'POST', body: payload });
  return data && typeof data === 'object' ? data : {};
}

/** Названия для письма — по id, чтобы в заявке не было того, что ввёл замерщик. */
export async function describeItem({ modelId, materialId }) {
  const [catalog, materials] = await Promise.all([
    getCatalog(),
    materialId ? getMaterials(modelId).catch(() => []) : Promise.resolve([]),
  ]);
  let system = null;
  let model = null;
  // Модель может лежать во вложенном списке: у плиссе и гофре замерщик
  // работает с вариантом (P1600), а он лежит внутри семейства «Модели MIDI»
  for (const s of catalog) {
    const found = s.models.find((m) => m.id === Number(modelId));
    if (found) {
      system = s;
      model = found;
      break;
    }
    const nested = s.models.find((m) => (m.subModels || []).some((sub) => sub.id === Number(modelId)));
    if (nested) {
      system = s;
      model = nested;
      break;
    }
  }
  const variant =
    (model?.subModels || []).find((sub) => sub.id === Number(modelId)) || null;
  const material = materials.find((m) => m.id === Number(materialId)) || null;
  return {
    systemName: system?.name || null,
    systemId: system?.id || null,
    modelName: model?.name || String(modelId),
    // Вариант двухуровневой модели: в письне нужно и семейство, и конкретный P1600
    subModelName: variant?.name || null,
    modelCode: (variant?.code1c || model?.code1c) || null,
    materialName: material?.name || null,
    materialVendorCode: material?.vendorCode || null,
    materialColor: material?.colorName || null,
    materialColorHex: material?.colorHex || null,
    // У части моделей (плиссе, гофре) в Amigo ткани не заведены
    hasMaterial: Boolean(material),
  };
}