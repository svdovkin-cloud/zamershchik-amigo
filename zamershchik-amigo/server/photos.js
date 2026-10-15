import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Фото заказов хранятся файлами, а не в JSONL — иначе история разрастается
// на десятки мегабайт. Метаданные остаются в заявке, сами файлы — рядом.
const root = () => path.join(config.dataDir, 'photos');

function dirFor(orderId) {
  return path.join(root(), String(orderId).replace(/[^\w.-]/g, '_'));
}

function safeName(name, index) {
  const ext = (() => {
    const match = /\.([a-z0-9]{2,5})$/i.exec(String(name || ''));
    return match ? `.${match[1].toLowerCase()}` : '.jpg';
  })();
  const base = String(name || `photo-${index + 1}`)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\wа-яА-ЯёЁ\- ]/g, '')
    .trim()
    .slice(0, 60);
  return `${base || `photo-${index + 1}`}${ext}`;
}

export function savePhotos(orderId, photos) {
  const dir = dirFor(orderId);
  fs.mkdirSync(dir, { recursive: true });
  return photos.map((photo, index) => {
    const filename = safeName(photo.name, index);
    const buffer = Buffer.from(photo.base64, 'base64');
    fs.writeFileSync(path.join(dir, filename), buffer);
    return {
      name: filename,
      contentType: photo.contentType || 'image/jpeg',
      size: buffer.length,
    };
  });
}

export function readPhoto(orderId, filename) {
  const safe = path.basename(String(filename || ''));
  const file = path.join(dirFor(orderId), safe);
  if (!fs.existsSync(file)) return null;
  return { buffer: fs.readFileSync(file), contentType: contentTypeFor(safe) };
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.heic': 'image/heic',
    }[ext] || 'application/octet-stream'
  );
}

/** Разбирает data:URL из телефона в { base64, contentType }. */
export function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  return { contentType: match[1], base64: match[2] };
}