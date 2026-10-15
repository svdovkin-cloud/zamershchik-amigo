import nodemailer from 'nodemailer';
import { config } from './config.js';
import { buildOrderMail } from './order-template.js';
import * as settings from './settings.js';

let transporter = null;

// SMTP-реквизиты живут только в .env — их не меняют из приложения.
// А вот кто получатель письма, меняется администратором в папке «Администрирование».
export function isMailConfigured() {
  return Boolean(config.mail.host && config.mail.user && config.mail.pass && settings.hasRecipients());
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: { user: config.mail.user, pass: config.mail.pass },
      // Яндекс и Gmail любят блокировать «подозрительные» входы без TLS
      tls: { rejectUnauthorized: false },
    });
  }
  return transporter;
}

/** Проверка SMTP при старте — чтобы не искать проблему в поле у замерщика. */
export async function verifyMail() {
  if (!isMailConfigured()) return { ok: false, reason: 'не заполнены SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_TO' };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export async function sendOrderMail(order) {
  if (!isMailConfigured()) {
    return { ok: false, error: 'Почта не настроена: проверьте SMTP_* и MAIL_TO в .env' };
  }

  const { subject, html, text } = buildOrderMail(order);

  const attachments = (order.photos || []).map((photo) => ({
    filename: photo.name,
    content: Buffer.from(photo.base64, 'base64'),
    contentType: photo.contentType || 'image/jpeg',
    cid: photo.cid,
    encoding: 'base64',
  }));

  // Спецификация отдельным файлом — её удобно открыть и распечатать
  attachments.push({
    filename: `${order.id}.html`,
    content: Buffer.from(html, 'utf8'),
    contentType: 'text/html; charset=utf-8',
  });

  await getTransporter().sendMail({
    from: settings.mailFrom(),
    to: settings.recipients(),
    // Письмо уходит с ящика компании, но ответ менеджера сразу попадёт замерщику
    replyTo: order.measurer?.email || undefined,
    subject,
    text,
    html,
    attachments,
  });

  return { ok: true };
}

/** Пробное письмо — чтобы администратор убедился, что почта работает. */
export async function sendTestMail(address) {
  if (!isMailConfigured()) {
    return { ok: false, error: 'Не заполнены SMTP_HOST, SMTP_USER, SMTP_PASS в .env' };
  }

  await getTransporter().sendMail({
    from: settings.mailFrom(),
    to: address || settings.recipients(),
    subject: 'Замеры Amigo — проверка связи',
    text: 'Это тестовое письмо. Если вы его видите, заявки будут приходить на почту.',
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1b2733;">
      <h2 style="margin:0 0 8px;">Почта работает</h2>
      <p>Это тестовое письмо из приложения «Замеры Amigo».</p>
      <p style="color:#7b8a99;">Заявки с замеров будут приходить на этот адрес.</p>
    </div>`,
  });

  return { ok: true };
}