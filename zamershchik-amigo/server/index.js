import path from 'node:path';
import express from 'express';

import { config, ROOT } from './config.js';
import * as auth from './auth.js';
import * as amigo from './amigo.js';
import { addMotorSurcharge } from './electric-kits.js';
import * as store from './store.js';
import * as photos from './photos.js';
import { isMailConfigured, verifyMail, sendOrderMail, sendTestMail } from './mailer.js';
import { getRate, convert, needsConversion, rateInfo, symbolFor } from './currency.js';
import * as settings from './settings.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: `${config.uploadLimitMb}mb` }));

// ─── Вход по PIN ──────────────────────────────────────────────────────────

const attempts = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 12;

function loginGuard(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
    const seconds = Math.ceil((entry.resetAt - now) / 1000);
    return res.status(429).json({ error: `Слишком много попыток. Подождите ${seconds} с.` });
  }
  if (!entry || entry.resetAt <= now) attempts.set(key, { count: 0, resetAt: now + WINDOW_MS });
  next();
}

/**
 * Список замерщиков для экрана входа. Открыт специально: без него человек
 * не знает, чей PIN вводить. Секретом остаётся сам PIN.
 */
app.get('/api/login/users', async (_req, res) => {
  res.json({ users: await auth.listUsersForLogin() });
});

app.post('/api/login', loginGuard, async (req, res) => {
  const result = await auth.login(req.body?.pin, req.body?.userId);
  const key = req.ip || 'unknown';
  if (!result) {
    const entry = attempts.get(key) || { count: 0, resetAt: Date.now() + WINDOW_MS };
    entry.count += 1;
    attempts.set(key, entry);
    return res.status(401).json({ error: 'Неверный PIN' });
  }
  attempts.delete(key);
  res.json(result);
});

function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query?.token;
  const user = auth.userByToken(token);
  if (!user) return res.status(401).json({ error: 'Нужен вход' });
  req.user = user;
  req.token = token;
  next();
}

app.post('/api/logout', requireUser, (req, res) => {
  auth.logout(req.token);
  res.json({ ok: true });
});

app.get('/api/me', requireUser, async (req, res) => {
  res.json({
    user: (await auth.profileById(req.user.id)) ?? req.user,
    mailConfigured: isMailConfigured(),
    isAdmin: req.user.role === 'admin',
    mailTo: await settings.recipients(),
  });
});

// ─── Профиль замерщика ────────────────────────────────────────────────────

app.patch('/api/profile', requireUser, async (req, res) => {
  try {
    const user = await auth.updateOwnProfile(req.user.id, {
      name: req.body?.name,
      email: req.body?.email,
    });
    req.user = user;
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/profile/pin', requireUser, async (req, res) => {
  try {
    const user = await auth.changeOwnPin(req.user.id, {
      currentPin: req.body?.currentPin,
      newPin: req.body?.newPin,
    });
    // PIN сменился — текущая сессия больше не годится, пусть войдёт заново
    auth.logout(req.token);
    res.json({ ok: true, user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─── Каталог и расчёт (прокси к Amigo) ────────────────────────────────────

const asId = (value) => {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
};

app.get('/api/catalog', requireUser, async (_req, res) => {
  res.json({ systems: await amigo.getCatalog() });
});

app.get('/api/catalog/materials', requireUser, async (req, res) => {
  const modelId = asId(req.query.model);
  if (!modelId) return res.status(400).json({ error: 'Нужен ?model=<id>' });
  res.json({ items: await amigo.getMaterials(modelId) });
});

app.get('/api/catalog/options', requireUser, async (req, res) => {
  const modelId = asId(req.query.model);
  if (!modelId) return res.status(400).json({ error: 'Нужен ?model=<id>' });
  res.json({ items: await amigo.getOptions(modelId) });
});

app.get('/api/catalog/model-info', requireUser, async (req, res) => {
  const modelId = asId(req.query.model);
  if (!modelId) return res.status(400).json({ error: 'Нужен ?model=<id>' });
  res.json(await amigo.getModelInfo(modelId));
});

/** Сколько в рублях, сколько в валюте прайса и каким курсом посчитано. */
async function priceView(raw) {
  const { rate } = await getRate();
  const source = Number(raw) || 0;
  const rub = needsConversion() ? convert(source, rate) : source;
  return {
    source,
    rub,
    rate,
    sourceSymbol: symbolFor(config.currency.source),
    rubSymbol: symbolFor(config.currency.target),
  };
}

app.post('/api/calculate', requireUser, async (req, res) => {
  const body = req.body || {};
  if (!asId(body.modelId) || !asId(body.materialId)) {
    return res.status(400).json({ error: 'Не выбраны модель или ткань' });
  }
  const payload = amigo.buildCalcPayload(body);
  const calc = await amigo.calculate(payload);
  // Показываем полную сумму: в `price` Amigo отдаёт базу без платных опций,
  // доплата за цвет фурнитуры, привод и комплект лежит в `total_price`
  const price = await priceView(calc.totalPrice || calc.price);
  const optionsPrice = await priceView(calc.optionsPrice || 0);
  // Электропривод для моделей без этой опции в Amigo — доплату считаем сами
  const withMotor = body.electric?.motor === 'da' ? addMotorSurcharge(price.rub, price.rate) : null;

  res.json({
    priceRub: withMotor ? round2(withMotor.totalRub) : price.rub,
    priceUsd: withMotor ? round2(withMotor.source) : price.source,
    priceSource: price.sourceSymbol,
    currency: price.rubSymbol,
    rate: price.rate,
    // Доплата за выбранные опции — чтобы замерщик видел, из чего собрана сумма
    optionsPriceRub: round2((withMotor ? withMotor.surcharge : 0) + optionsPrice.rub),
    optionsPriceUsd: round2((withMotor ? withMotor.surcharge / price.rate : 0) + optionsPrice.source),
    motorSurchargeRub: withMotor ? withMotor.surcharge : 0,
    area: calc.area,
    messages: calc.messages,
    rateInfo: await rateInfo(),
  });
});

app.post('/api/calculate-options-values', requireUser, async (req, res) => {
  const payload = amigo.buildCalcPayload(req.body || {});
  res.json(await amigo.calculateOptionsValues(payload));
});

// ─── Администрирование ───────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Раздел только для администратора' });
  next();
}

app.get('/api/admin/overview', requireUser, requireAdmin, async (_req, res) => {
  res.json({
    users: await auth.listUsersAsync(),
    settings: await settings.readSettingsAsync(),
    mailConfigured: isMailConfigured(),
    mailTo: await settings.recipients(),
  });
});

app.post('/api/admin/users', requireUser, requireAdmin, async (req, res) => {
  try {
    const user = await auth.addUser({
      name: req.body?.name,
      pin: req.body?.pin,
      email: req.body?.email,
      role: req.body?.role === 'admin' ? 'admin' : 'measurer',
    });
    res.status(201).json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/** Администратор правит замерщика: имя, почту, PIN, права. */
app.patch('/api/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  try {
    const user = await auth.updateUserById(req.params.id, {
      name: req.body?.name,
      email: req.body?.email,
      pin: req.body?.pin,
      role: req.body?.role,
    });
    res.json({ user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  // Последнего администратора тоже нельзя — иначе в приложение будет не войти
  const users = await auth.listUsersAsync();
  const admins = users.filter((u) => u.role === 'admin');
  const target = users.find((u) => u.id === req.params.id);
  if (target?.role === 'admin' && admins.length <= 1) {
    return res.status(400).json({ error: 'Нельзя удалить единственного администратора' });
  }
  try {
    const name = await auth.removeUserById(req.params.id);
    res.json({ ok: true, name });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/admin/settings', requireUser, requireAdmin, async (req, res) => {
  const result = await settings.updateSettings({
    mailTo: req.body?.mailTo,
    mailFrom: req.body?.mailFrom,
    subjectPrefix: req.body?.subjectPrefix,
  });
  if (result.errors) return res.status(400).json({ error: result.errors.join('. ') });
  res.json({ settings: result.settings, mailTo: await settings.recipients() });
});

/** Проверочное письмо: сразу видно, дошло ли и на тот ли адрес. */
app.post('/api/admin/test-mail', requireUser, requireAdmin, async (req, res) => {
  try {
    await sendTestMail(req.body?.address);
    res.json({ ok: true, to: await settings.recipients() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Заявки ───────────────────────────────────────────────────────────────

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Названия опций берём из каталога Amigo, а не из того, что прислал телефон. */
function describeOptions(modelId, chosen) {
  const list = Array.isArray(chosen) ? chosen : [];
  if (!list.length) return Promise.resolve([]);
  return amigo
    .getOptions(modelId)
    .then((options) =>
      list
        .map((entry) => {
          const option = options.find((o) => o.code === entry.code || String(o.id) === String(entry.code));
          const value =
            option?.values.find((v) => String(v.id) === String(entry.valueId))?.name ?? entry.valueId ?? '';
          return { code: option?.code || entry.code, name: option?.name || entry.code, value: String(value) };
        })
        .filter((o) => o.name),
    )
    .catch(() => list.map((entry) => ({ code: entry.code, name: entry.code, value: String(entry.valueId ?? '') })));
}

async function buildItems(rawItems) {
  const items = [];
  for (const raw of rawItems) {
    const modelId = asId(raw.modelId);
    const materialId = asId(raw.materialId);
    const sizes = {
      width: Number(raw.sizes?.width) || 0,
      height: Number(raw.sizes?.height) || 0,
    };
    if (!modelId) throw new Error('Не выбрана модель');
    if (sizes.width <= 0 || sizes.height <= 0) throw new Error('Не заполнены размеры');

    const description = await amigo.describeItem({ modelId, materialId });
    const quantity = Math.max(1, Math.floor(Number(raw.quantity) || 1));

    // У моделей плиссе и гофре в Amigo ткани не заведены: цену не откуда взять.
    // Замерщик всё равно снимает размеры — принимаем изделие, посчитает офис.
    if (!materialId || !description.hasMaterial) {
      items.push({
        ...description,
        modelId,
        materialId: materialId ?? null,
        sizes,
        quantity,
        area: Math.round(((sizes.width * sizes.height) / 1_000_000) * 100) / 100,
        priceSource: 0,
        priceRub: 0,
        price: 0,
        totalPrice: 0,
        currency: symbolFor(config.currency.target),
        sourceSymbol: symbolFor(config.currency.source),
        noPrice: true,
        options: await describeOptions(modelId, raw.options),
        autoOptions: {},
        measure: normalizeMeasure(raw.measure),
        control: normalizeControl(raw.control),
        mount: normalizeMount(raw.mount),
        electric: normalizeElectric(raw.electric),
        install: normalizeInstall(raw.install),
        warnings: [],
      });
      continue;
    }

    // Цену считает только Amigo — телефон присылает лишь размеры и свой выбор
    const calc = await amigo.calculate(
      amigo.buildCalcPayload({ modelId, materialId, sizes, optionsValues: raw.optionsValues }),
    );
    const errors = calc.messages.filter((m) => m.type === 'error');
    const options = await describeOptions(modelId, raw.options);
    const measure = normalizeMeasure(raw.measure);
    const control = normalizeControl(raw.control);
    const mount = normalizeMount(raw.mount);
    const electric = normalizeElectric(raw.electric);
    const install = normalizeInstall(raw.install);

    // Amigo не смог посчитать: у Mono-систем он требует размеры второго
    // изделия, у некоторых моделей ругается на комбинацию опций. Если
    // замерщик нажал «всё равно в заявку» — не отклоняем замер, а помечаем
    // позицию как «цену посчитает офис». Иначе это ошибка отправки.
    if (errors.length) {
      if (!raw.allowNoPrice) throw new Error(errors.map((m) => m.text).join('. '));
      items.push({
        ...description,
        modelId,
        materialId,
        sizes,
        quantity,
        area: Math.round(((sizes.width * sizes.height) / 1_000_000) * 100) / 100,
        priceSource: 0,
        priceRub: 0,
        price: 0,
        totalPrice: 0,
        currency: symbolFor(config.currency.target),
        sourceSymbol: symbolFor(config.currency.source),
        noPrice: true,
        options,
        autoOptions: {},
        measure,
        control,
        mount,
        electric,
        install,
        warnings: errors.map((m) => m.text),
      });
      continue;
    }

    // Полная сумма: `price` у Amigo — база без платных опций, а доплата за цвет
    // фурнитуры, привод или комплект электрики приходит в `total_price`
    const price = await priceView(calc.totalPrice || calc.price);
    const optionsPrice = await priceView(calc.optionsPrice || 0);
    // Электропривод для моделей без этой опции в Amigo — доплату считаем сами
    const withMotor = raw.electric?.motor === 'da' ? addMotorSurcharge(price.rub, price.rate) : null;
    const priceRub = withMotor ? round2(withMotor.totalRub) : price.rub;

    items.push({
      ...description,
      modelId,
      materialId,
      sizes,
      quantity,
      area: calc.area,
      // Прайс в валюте Amigo (USD) и результат в рублях — в письме покажем оба
      priceSource: withMotor ? round2(withMotor.source) : price.source,
      priceRub,
      price: priceRub,
      optionsPriceSource: optionsPrice.source,
      optionsPriceRub: round2((withMotor ? withMotor.surcharge : 0) + optionsPrice.rub),
      totalPrice: round2(priceRub * quantity),
      currency: price.rubSymbol,
      sourceSymbol: price.sourceSymbol,
      noPrice: false,
      options,
      autoOptions: calc.autoOptions,
      measure,
      control,
      mount,
      electric,
      install,
      warnings: calc.messages.filter((m) => m.type !== 'error').map((m) => m.text),
    });
  }
  return items;
}

// Режим замера в каталоге Amigo отсутствует, поэтому сервер принимает только
// известные значения и не даёт в письмо попасть мусору из телефона.
const MEASURE_BY = new Set(['gabarit', 'fabric']);
const MEASURE_FROM = new Set(['shtapik', 'steklo']);
const CONTROL_TYPE = new Set(['k-upravlenie', 'ot-upravleniya', 'ot-tsentra', 'k-tsentru']);
// Тип крепления рулонных штор. В каталоге Amigo он заведён только у двух
// моделей Зебры (опция ТипУстановкиГИ), поэтому для остальных это ручная
// отметка замерщика — монтажникам она нужна на каждом объекте.
const MOUNT_TYPE = new Set(['na-proem-stena', 'v-proem-potolok']);
// Электропривод для моделей без этой опции в Amigo — замерщик отмечает
// только «нужен привод», комплект выбирать не нужно
const ELECTRIC_MOTOR = new Set(['net', 'da']);

function normalizeMeasure(raw) {
  const by = MEASURE_BY.has(raw?.by) ? raw.by : '';
  const from = MEASURE_FROM.has(raw?.from) ? raw.from : '';
  return { by, from };
}

// Тип открывания для вертикальных жалюзи: у них в Amigo есть только
// «Левое / Правое», а «К управлению / От управления / От центра» заведено
// лишь для шторных карнизов. Это ручная отметка замерщика для офиса.
function normalizeControl(raw) {
  return { type: CONTROL_TYPE.has(raw?.type) ? raw.type : '' };
}

function normalizeMount(raw) {
  return { type: MOUNT_TYPE.has(raw?.type) ? raw.type : '' };
}

function normalizeElectric(raw) {
  return { motor: ELECTRIC_MOTOR.has(raw?.motor) ? raw.motor : '', kit: '' };
}

// Стоимость монтажа замерщик вводит руками: в рублях, без пересчёта по курсу
// и без связи с ценой Amigo. Пустое или мусорное значение — ноль.
const INSTALL_MAX = 10_000_000;

function normalizeInstall(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return round2(Math.min(value, INSTALL_MAX));
}

function normalizePhotos(rawPhotos) {
  const limit = config.uploadLimitMb * 1024 * 1024;
  const list = Array.isArray(rawPhotos) ? rawPhotos : [];
  return list
    .map((photo) => {
      const parsed = photos.parseDataUrl(photo?.dataUrl);
      if (!parsed) return null;
      const size = Math.floor((parsed.base64.length * 3) / 4);
      if (size > limit) return null;
      return {
        name: photo.name || 'photo',
        // 'requisites' — скан реквизитов ЮЛ, 'opening' — проём
        kind: photo.kind === 'requisites' ? 'requisites' : 'opening',
        contentType: parsed.contentType,
        base64: parsed.base64,
        size,
      };
    })
    .filter(Boolean)
    .slice(0, 14);
}

app.post('/api/orders', requireUser, async (req, res) => {
  const body = req.body || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: 'Заявка пустая' });

  let items;
  try {
    items = await buildItems(rawItems);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const rawPhotos = normalizePhotos(body.photos);
  const id = await store.nextOrderNumber();
  const storedPhotos = rawPhotos.length ? photos.savePhotos(id, rawPhotos) : [];
  // Почта замерщика: в письме это Reply-To, чтобы менеджер отвечал ему сразу
  const measurer = (await auth.profileById(req.user.id)) ?? { name: req.user.name, email: '' };

  const order = {
    id,
    createdAt: new Date().toISOString(),
    measurer: { id: req.user.id, name: measurer.name, email: measurer.email || '' },
    client: {
      name: String(body.client?.name || '').slice(0, 120),
      phone: String(body.client?.phone || '').slice(0, 60),
      address: String(body.client?.address || '').slice(0, 300),
      desiredDate: String(body.client?.desiredDate || '').slice(0, 60),
      comment: String(body.client?.comment || '').slice(0, 2000),
      // Юридическое лицо: подтверждает, что к заявке приложены реквизиты
      isCompany: Boolean(body.client?.isCompany) || storedPhotos.some((p) => p.kind === 'requisites'),
    },
    note: String(body.note || '').slice(0, 2000),
    items,
    totals: {
      // Сумма изделий по прайсу Amigo — её видно отдельно от монтажа
      totalPrice: round2(items.reduce((sum, item) => sum + item.totalPrice, 0)),
      // Монтаж вводится вручную и просто прибавляется к изделиям
      installTotal: round2(items.reduce((sum, item) => sum + (item.install || 0), 0)),
      grandTotal: round2(
        items.reduce((sum, item) => sum + item.totalPrice + (item.install || 0), 0),
      ),
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      area: round2(items.reduce((sum, item) => sum + item.area * item.quantity, 0)),
    },
    // Курс, по которому посчитана заявка, едет вместе с ней
    rate: await rateInfo(),
    // В заявке храним только метаданные фото, а письмо собираем сразу из того,
    // что пришло с телефона — файлы уже на диске, перечитывать их не нужно
    photos: storedPhotos.map((photo, i) => ({ ...photo, cid: `photo${i}` })),
    publicUrl: config.publicUrl ? `${config.publicUrl}/?order=${id}` : '',
    mailSubjectPrefix: config.mail.subjectPrefix,
    mail: { status: isMailConfigured() ? 'sending' : 'not_configured' },
  };

  await store.appendOrder(order);

  const mailPayload = {
    ...order,
    photos: rawPhotos.map((photo, i) => ({
      ...photo,
      cid: `photo${i}`,
      name: order.photos[i].name,
    })),
  };

  try {
    await sendOrderMail(mailPayload);
    await store.updateOrder(id, { mail: { status: 'sent', sentAt: new Date().toISOString() } });
    res.status(201).json({ id, emailed: true, totals: order.totals, items: order.items.length });
  } catch (error) {
    await store.updateOrder(id, { mail: { status: 'failed', error: error.message } });
    res.status(201).json({
      id,
      emailed: false,
      error: `Заявка сохранена, но письмо не ушло: ${error.message}`,
      totals: order.totals,
    });
  }
});

app.get('/api/orders', requireUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const all = (await store.readOrders()).reverse();
  const visible = req.user.role === 'admin' ? all : all.filter((o) => o.measurer?.id === req.user.id);
  res.json({ items: visible.slice(0, limit) });
});

app.get('/api/orders/:id', requireUser, async (req, res) => {
  const order = await store.findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  if (req.user.role !== 'admin' && order.measurer?.id !== req.user.id) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  res.json({ order });
});

/** Письмо не ушло (был интернет, ящик отвечал медленно) — пробуем ещё раз. */
app.post('/api/orders/:id/resend', requireUser, async (req, res) => {
  const order = await store.findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  if (req.user.role !== 'admin' && order.measurer?.id !== req.user.id) {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const payload = { ...order, photos: [] };
  for (const photo of order.photos || []) {
    const file = photos.readPhoto(order.id, photo.name);
    if (file) {
      payload.photos.push({ ...photo, base64: file.buffer.toString('base64'), contentType: file.contentType });
    }
  }

  try {
    await sendOrderMail(payload);
    await store.updateOrder(order.id, { mail: { status: 'sent', sentAt: new Date().toISOString() } });
    res.json({ ok: true });
  } catch (error) {
    await store.updateOrder(order.id, { mail: { status: 'failed', error: error.message } });
    res.status(500).json({ error: error.message });
  }
});

// ─── Статика PWA ──────────────────────────────────────────────────────────

app.use(
  express.static(path.join(ROOT, 'public'), {
    setHeaders(res, filePath) {
      // Сервис-воркер и манифест нельзя отдавать из старого кэша
      if (/sw\.js$|manifest\.webmanifest$|\.html$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

app.use((error, _req, res, _next) => {
  console.error('[error]', error);
  res.status(error.status || 500).json({ error: error.message || 'Внутренняя ошибка' });
});

// ─── Запуск ───────────────────────────────────────────────────────────────

auth.bootstrapUser();

app.listen(config.port, config.host, async () => {
  const mail = await verifyMail();
  const users = await auth.listUsersAsync();

  console.log('');
  console.log('  Замеры Amigo — приложение запущено');
  console.log(`  В браузере:        http://localhost:${config.port}`);
  console.log(`  С телефона:        http://<ip-компьютера>:${config.port}`);
  console.log(`  База знаний:      ${config.amigo.base}`);
  console.log(`  Замерщиков:       ${users.length ? users.map((u) => `${u.name} (${u.role})`).join(', ') : '—'}`);
  console.log(
    `  Почта:            ${mail.ok ? `настроена, письма → ${(await settings.recipients()).join(', ')}` : `НЕ настроена — ${mail.reason}`}`,
  );
  if (!config.publicUrl) {
    console.log('  Внимание:        не задан PUBLIC_URL — в письме не будет ссылки на заявку');
  }
  console.log('');
});