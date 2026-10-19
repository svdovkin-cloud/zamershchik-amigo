// Письмо со заявкой. Только табличная вёрстка с инлайн-стилями —
// так оно корректно выглядит в Яндекс.Почте, Outlook и мобильных клиентах.

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const money = (value, symbol = '₽') =>
  `${Number(value || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;

const ddmmyyyy = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const colorDot = (hex) =>
  hex
    ? `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${esc(hex)};border:1px solid #cbd2d9;vertical-align:-1px;margin-right:4px;"></span>`
    : '';

const photoCells = (photos) =>
  photos
    .map(
      (photo) => `<td style="padding:0 6px 6px 0;">
        <img src="cid:${esc(photo.cid)}" alt="${esc(photo.name)}"
             style="display:block;max-width:220px;max-height:160px;border:1px solid #d7dde3;border-radius:6px;">
      </td>`,
    )
    .join('');

// В каталоге Amigo полей «по ткани / по штапику» нет — это пометка замерщика.
// В письме она нужна, чтобы офис раскроил ткань по тому краю, который сняли.
const MEASURE_LABELS = {
  by: { gabarit: 'габарит изделия', fabric: 'размер ткани' },
  from: { shtapik: 'по штапику', steklo: 'по стеклу' },
};

const measureNote = (measure) =>
  [MEASURE_LABELS.by[measure?.by], MEASURE_LABELS.from[measure?.from]]
    .filter(Boolean)
    .join(' · ');

// Тип открывания для вертикальных жалюзи: в Amigo этой опции у них нет,
// поэтому в письме её нужно назвать словами, а не кодом.
const CONTROL_LABELS = {
  'k-upravlenie': 'к управлению',
  'ot-upravleniya': 'от управления',
  'ot-tsentra': 'от центра',
  'k-tsentru': 'к центру',
};

const controlNote = (control) => CONTROL_LABELS[control?.type] || '';

// Тип крепления рулонных штор: в письме монтажник видит его прямо у позиции
const MOUNT_LABELS = {
  'na-proem-stena': 'на проём / на стену',
  'v-proem-potolok': 'в проём / на потолок',
};

const mountNote = (mount) => MOUNT_LABELS[mount?.type] || '';

// Электропривод и комплект электрики: в каталоге они есть только у ZIP,
// ZIP ROOF и LOCK, остальным рулонным моделям их выбирает замерщик вручную
const ELECTRIC_KIT_LABELS = {
  'dm35-wifi': 'DM35 (о/с, Wi-Fi)',
  'dm35-wire': 'DM35 (провод)',
  'dm35-rs485': 'DM35 (рад, RS485)',
  'dm35-radio': 'DM35 (радио)',
  'dm35-radio-os': 'DM35 (радио, о/с)',
  'dm45-wire': 'DM45 (провод)',
  'dm45-radio-os': 'DM45 (радио, о/с)',
};

const electricNote = (electric) => {
  const parts = [];
  if (electric?.motor === 'da') parts.push('электропривод');
  const kit = ELECTRIC_KIT_LABELS[electric?.kit];
  if (kit) parts.push(`комплект электрики Amigo ${kit}`);
  return parts.join(' · ');
};

export function buildOrderMail(order) {
  const subject = `${order.mailSubjectPrefix || 'Заявка с замера'} ${order.id} · ${order.client?.name || 'без имени'}`;

  const itemRows = order.items
    .map((item, index) => {
      const options = (item.options || [])
        .map((o) => `${esc(o.name)}: <b>${esc(o.value)}</b>`)
        .join('<br>');
      const auto = Object.entries(item.autoOptions || {})
        .filter(([, value]) => value !== null && value !== '' && value !== undefined)
        .map(([code, value]) => `${esc(code)}: <b>${esc(value)}</b>`)
        .join('<br>');

      return `<tr>
        <td style="padding:10px;border-bottom:1px solid #e6eaee;vertical-align:top;color:#8895a1;">${index + 1}</td>
        <td style="padding:10px;border-bottom:1px solid #e6eaee;vertical-align:top;">
          <div style="font-weight:700;color:#1b2733;">${esc(item.systemName || '')} · ${esc(item.modelName || '')}${
            item.subModelName ? ` · ${esc(item.subModelName)}` : ''
          }</div>
          <div style="color:#5b6b7b;margin-top:2px;">${esc(item.materialName || 'ткань не выбрана — цену считает офис')}</div>
          <div style="margin-top:2px;">${colorDot(item.materialColorHex)}${esc(item.materialColor || '')}</div>
          ${item.modelCode ? `<div style="color:#8895a1;margin-top:2px;">Артикул модели: ${esc(item.modelCode)}</div>` : ''}
          ${item.materialVendorCode ? `<div style="color:#8895a1;">Артикул ткани: ${esc(item.materialVendorCode)}</div>` : ''}
          ${options ? `<div style="margin-top:6px;color:#33424f;">${options}</div>` : ''}
          ${item.optionsText ? `<div style="margin-top:4px;color:#8895a1;">${esc(item.optionsText)}</div>` : ''}
          ${auto ? `<div style="margin-top:6px;color:#8895a1;">Подобрано системой: ${auto}</div>` : ''}
        </td>
        <td style="padding:10px;border-bottom:1px solid #e6eaee;vertical-align:top;white-space:nowrap;">
          <div><b>${esc(item.sizes.width)} × ${esc(item.sizes.height)}</b> мм</div>
          <div style="color:#8895a1;">${esc(item.area || 0)} м² · ${esc(item.quantity || 1)} шт.</div>
          ${item.optionsPriceRub ? `<div style="color:#8895a1;">из них доп. опции: ${money(item.optionsPriceRub, item.currency)}</div>` : ''}
          ${measureNote(item.measure) ? `<div style="color:#8895a1;">Замер: ${measureNote(item.measure)}</div>` : ''}
          ${controlNote(item.control) ? `<div style="color:#8895a1;">Открывание: ${controlNote(item.control)}</div>` : ''}
          ${mountNote(item.mount) ? `<div style="color:#8895a1;">Крепление: ${mountNote(item.mount)}</div>` : ''}
          ${electricNote(item.electric) ? `<div style="color:#8895a1;">Электрика: ${electricNote(item.electric)}</div>` : ''}
          ${item.install ? `<div style="color:#8895a1;">Монтаж: ${money(item.install, item.currency)}</div>` : ''}
        </td>
        <td style="padding:10px;border-bottom:1px solid #e6eaee;vertical-align:top;text-align:right;white-space:nowrap;">
          ${
            item.noPrice
              ? '<div style="font-weight:700;color:#b03a3a;">цена не рассчитана</div><div style="color:#8895a1;">посчитает офис</div>'
              : `<div><b>${money(item.totalPrice, item.currency)}</b></div>
                 ${
                   item.priceSource !== undefined && item.priceSource !== null
                     ? `<div style="color:#8895a1;">${money(item.priceSource, item.sourceSymbol)} × ${esc(item.quantity || 1)}</div>`
                     : ''
                 }`
          }
        </td>
      </tr>`;
    })
    .join('');

  const clientRows = [
    ['Клиент', order.client.name],
    ['Юридическое лицо', order.client.isCompany ? 'да' : null],
    ['Телефон', order.client.phone],
    ['Адрес', order.client.address],
    ['Желаемая дата', order.client.desiredDate],
    ['Замерщик', order.measurer.name],
    ['Почта замерщика', order.measurer.email],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#8895a1;white-space:nowrap;vertical-align:top;">${esc(label)}</td>
         <td style="padding:4px 0;font-weight:600;color:#1b2733;">${esc(value)}</td></tr>`,
    )
    .join('');

  // Фото проёмов и реквизиты ЮЛ разводим по разным блокам:
// офису нужно видеть, где документ, а где снимок окна
const openingPhotos = (order.photos || []).filter((p) => p.kind !== 'requisites');
const requisitesPhotos = (order.photos || []).filter((p) => p.kind === 'requisites');

const photosBlock = openingPhotos.length
    ? `<tr><td style="padding:16px 20px;background:#f7f9fb;border-top:1px solid #e6eaee;">
         <div style="font-weight:700;color:#1b2733;margin-bottom:8px;">Фото с замера (${openingPhotos.length})</div>
         <table role="presentation" cellpadding="0" cellspacing="0"><tr>${photoCells(openingPhotos)}</tr></table>
       </td></tr>`
    : '';

const requisitesBlock = requisitesPhotos.length
    ? `<tr><td style="padding:16px 20px;background:#fdf6ec;border-top:1px solid #f0e2cc;">
         <div style="font-weight:700;color:#1b2733;margin-bottom:4px;">Реквизиты юридического лица</div>
         <div style="color:#7b6a52;font-size:12px;margin-bottom:8px;">Заявка оформлена на организацию. Реквизиты приложены отдельными файлами.</div>
         <table role="presentation" cellpadding="0" cellspacing="0"><tr>${photoCells(requisitesPhotos)}</tr></table>
       </td></tr>`
    : order.client.isCompany
      ? `<tr><td style="padding:16px 20px;background:#fdf6ec;border-top:1px solid #f0e2cc;">
           <div style="font-weight:700;color:#1b2733;">Реквизиты юридического лица</div>
           <div style="color:#b03a3a;font-size:13px;margin-top:4px;">Заявка на организацию, но реквизиты не приложены — запросите их у клиента.</div>
         </td></tr>`
      : '';

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:20px 0;">
<tr><td align="center">
  <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">

    <tr><td style="background:#1b2733;padding:18px 20px;">
      <div style="color:#ffffff;font-size:18px;font-weight:700;">Заявка с замера ${esc(order.id)}</div>
      <div style="color:#9fb0c0;font-size:13px;margin-top:2px;">${esc(ddmmyyyy(order.createdAt))}</div>
    </td></tr>

    <tr><td style="padding:16px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0">${clientRows}</table>
    </td></tr>

    <tr><td style="padding:0 20px 8px;font-weight:700;color:#1b2733;">Изделия</td></tr>

    <tr><td style="padding:0 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr>
            <th style="padding:8px;border-bottom:2px solid #e6eaee;text-align:left;color:#8895a1;font-size:12px;font-weight:600;">#</th>
            <th style="padding:8px;border-bottom:2px solid #e6eaee;text-align:left;color:#8895a1;font-size:12px;font-weight:600;">Изделие</th>
            <th style="padding:8px;border-bottom:2px solid #e6eaee;text-align:left;color:#8895a1;font-size:12px;font-weight:600;">Размер</th>
            <th style="padding:8px;border-bottom:2px solid #e6eaee;text-align:right;color:#8895a1;font-size:12px;font-weight:600;">Сумма</th>
          </tr>
        </thead>
        <tbody>${itemRows || '<tr><td colspan="4" style="padding:12px;color:#8895a1;">Изделия не указаны</td></tr>'}</tbody>
      </table>
    </td></tr>

    <tr><td style="padding:12px 20px;text-align:right;border-bottom:1px solid #e6eaee;">
      ${
        order.totals.installTotal || order.totals.motorTotal
          ? `<div style="color:#5b6b7b;margin-bottom:6px;">Изделия: ${money(order.totals.totalPrice, order.currency || '₽')}</div>
             <div style="color:#5b6b7b;margin-bottom:6px;">Монтаж: ${money(order.totals.installTotal, order.currency || '₽')}</div>
             <div style="color:#5b6b7b;margin-bottom:6px;">Электрика: ${money(order.totals.motorTotal, order.currency || '₽')}</div>`
          : ''
      }
      <span style="color:#5b6b7b;margin-right:8px;">Итого:</span>
      <span style="font-size:20px;font-weight:700;color:#1b2733;">${money(
        order.totals.grandTotal ?? order.totals.totalPrice,
        order.currency || '₽',
      )}</span>
      <div style="color:#8895a1;font-size:12px;margin-top:2px;">${esc(order.totals.quantity)} шт. · ${esc(order.totals.area)} м²${
        order.rate?.text ? ` · ${esc(order.rate.text)}` : ' · цены по прайсу Amigo Customizer'
      }</div>
    </td></tr>

    ${requisitesBlock}
    ${photosBlock}

    ${
      order.note || order.client.comment
        ? `<tr><td style="padding:16px 20px;border-top:1px solid #e6eaee;">
             <div style="font-weight:700;color:#1b2733;margin-bottom:6px;">Комментарий замерщика</div>
             <div style="color:#33424f;">${esc(order.note || order.client.comment).replace(/\n/g, '<br>')}</div>
           </td></tr>`
        : ''
    }

    ${
      order.publicUrl
        ? `<tr><td style="padding:0 20px 18px;">
             <a href="${esc(order.publicUrl)}" style="color:#2b6cb0;">Открыть заявку ${esc(order.id)} в приложении</a>
           </td></tr>`
        : ''
    }

  </table>
  <div style="color:#8895a1;font-size:11px;padding:12px;">Замерщик: ${esc(order.measurer.name)} · создано из приложения «Замеры Amigo»</div>
</td></tr></table>
</body></html>`;

  const text = [
    `Заявка с замера ${order.id}`,
    `Дата: ${ddmmyyyy(order.createdAt)}`,
    `Замерщик: ${order.measurer.name}`,
    '',
    `Клиент: ${order.client.name || '-'}`,
    `Телефон: ${order.client.phone || '-'}`,
    `Адрес: ${order.client.address || '-'}`,
    `Желаемая дата: ${order.client.desiredDate || '-'}`,
    `Юридическое лицо: ${order.client.isCompany ? 'да' : 'нет'}`,
    `Реквизиты приложены: ${(order.photos || []).some((p) => p.kind === 'requisites') ? 'да' : 'нет'}`,
    '',
    'Изделия:',
    ...order.items.map(
      (item, i) =>
        `${i + 1}. ${item.systemName} / ${item.modelName} / ${item.materialName || 'ткань не выбрана'}\n` +
        `   Размер ${item.sizes.width}×${item.sizes.height} мм, ${item.area} м², ${item.quantity} шт.` +
        (measureNote(item.measure) ? `, замер: ${measureNote(item.measure)}` : '') +
        (controlNote(item.control) ? `, открывание: ${controlNote(item.control)}` : '') +
        (mountNote(item.mount) ? `, крепление: ${mountNote(item.mount)}` : '') +
        (electricNote(item.electric) ? `, электрика: ${electricNote(item.electric)}` : '') +
        (item.install ? `, монтаж: ${money(item.install, item.currency)}` : '') +
        (item.noPrice ? ' — цена не рассчитана' : ` — ${money(item.totalPrice, item.currency)}`),
    ),
    '',
    `ИЗДЕЛИЯ: ${money(order.totals?.totalPrice, order.currency || '₽')}`,
    order.totals?.installTotal ? `МОНТАЖ: ${money(order.totals.installTotal, order.currency || '₽')}` : '',
    order.totals?.motorTotal ? `ЭЛЕКТРИКА: ${money(order.totals.motorTotal, order.currency || '₽')}` : '',
    `ИТОГО: ${money(order.totals?.grandTotal ?? order.totals?.totalPrice, order.currency || '₽')}`,
    order.rate?.text ? `Курс: ${order.rate.text}` : '',
    order.note ? `\nКомментарий: ${order.note}` : '',
    order.publicUrl ? `\nЗаявка в приложении: ${order.publicUrl}` : '',
  ].join('\n');

  return { subject, html, text };
}