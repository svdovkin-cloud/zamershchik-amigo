#!/usr/bin/env node
// Проверка готовности перед запуском: .env, база знаний Amigo, почта.
//   npm run check
import fs from 'node:fs';
import path from 'node:path';

import { config, ROOT } from '../server/config.js';
import * as auth from '../server/auth.js';
import * as amigo from '../server/amigo.js';
import { isMailConfigured, verifyMail } from '../server/mailer.js';

const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail = '') => {
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
};

console.log('\nПроверка окружения\n');

// 1. .env
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) ok('.env найден');
else fail('.env не найден', 'скопируйте .env.example в .env и заполните значения');

// 2. Замерщики
const users = auth.listUsers();
if (users.length) ok('Замерщики', users.map((u) => u.name).join(', '));
else fail('Замерщиков нет', 'запустите: npm run pin -- --name "Иван" --pin 4321');

// 3. База знаний Amigo
try {
  const systems = await amigo.getCatalog();
  const modelCount = systems.reduce((sum, s) => sum + s.models.length, 0);
  ok('Amigo Customizer отвечает', `${systems.length} систем, ${modelCount} моделей`);

  const first = systems[0];
  const model = first.models[0];
  const materials = await amigo.getMaterials(model.id);
  ok('Ткани грузятся', `${first.name} / ${model.name}: ${materials.length} вариантов`);

  const options = await amigo.getOptions(model.id);
  ok('Опции грузятся', `${options.length} шт. (${options.map((o) => o.name).join(', ')})`);

  if (materials.length) {
    const calc = await amigo.calculate(
      amigo.buildCalcPayload({ modelId: model.id, materialId: materials[0].id, sizes: { width: 1000, height: 1500 } }),
    );
    const errors = calc.messages.filter((m) => m.type === 'error');
    if (errors.length) fail('Расчёт цены', errors.map((m) => m.text).join('. '));
    else ok('Расчёт цены', `1000×1500 мм → ${calc.price} ${calc.currency}, ${calc.area} м²`);
  }

  // Плиссе и гофре устроены двухуровнево: у семейства тканей нет, они лежат
  // у варианта. Проверяем именно варианты — и считаем их количество.
  let всегоВариантов = 0;
  const безТканей = [];
  for (const system of catalog) {
    for (const model of system.models) {
      for (const variant of model.subModels || []) {
        всегоВариантов += 1;
        const list = await amigo.getMaterials(variant.id);
        if (!list.length) безТканей.push(`${system.name} / ${model.name} / ${variant.name}`);
      }
    }
  }
  if (безТканей.length) {
    fail(
      'Варианты без тканей',
      `${безТканей.length} из ${всегоВариантов}: ${безТканей.slice(0, 5).join('; ')}`,
    );
  } else if (всегоВариантов) {
    ok('Варианты плиссе и гофре', `${всегоВариантов} вариантов, у всех есть ткани`);
  } else {
    ok('Варианты плиссе и гофре', 'двухуровневых моделей в каталоге нет');
  }
} catch (error) {
  fail('База знаний Amigo недоступна', error.message);
}

// 4. Почта
if (!isMailConfigured()) {
  fail('Почта не настроена', 'заполните SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_TO');
} else {
  const mail = await verifyMail();
  if (mail.ok) ok('SMTP отвечает', `письма → ${config.mail.to.join(', ')}`);
  else fail('SMTP не отвечает', mail.reason);
}

// 5. Публичный адрес
if (config.publicUrl) ok('PUBLIC_URL', config.publicUrl);
else console.log('  ⚠️  PUBLIC_URL не задан — в письме не будет ссылки на заявку');

console.log(process.exitCode ? '\nЕсть проблемы — см. пункт ❌ выше\n' : '\nВсё готово, можно запускать: npm start\n');