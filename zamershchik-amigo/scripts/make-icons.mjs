#!/usr/bin/env node
// Генерация иконок PWA без единой зависимости: рисуем растр и кодируем PNG
// средствами Node (zlib + CRC32).
//   npm run icons
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'public', 'icons');

const BG = [22, 42, 68, 255]; // тёмно-синий
const FRAME = [255, 255, 255, 255];
const SLAT = [255, 176, 32, 255]; // акцент — «шторы»
const WARM = [255, 214, 140, 255];

function createCanvas(size) {
  return { size, data: new Uint8Array(size * size * 4) };
}

function put(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  canvas.data[i] = color[0];
  canvas.data[i + 1] = color[1];
  canvas.data[i + 2] = color[2];
  canvas.data[i + 3] = color[3];
}

/** Прямоугольник со скруглением: вне радиуса углов не рисуем. */
function roundedRect(canvas, x0, y0, w, h, radius, color) {
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const cx = x < x0 + radius ? x0 + radius : x > x1 - radius ? x1 - radius : x;
      const cy = y < y0 + radius ? y0 + radius : y > y1 - radius ? y1 - radius : y;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) put(canvas, x, y, color);
    }
  }
}

// ─── PNG ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // фильтр строки: none
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Рисунок: окно со шторой ──────────────────────────────────────────────

function draw(size, { padding }) {
  const canvas = createCanvas(size);
  roundedRect(canvas, 0, 0, size, size, Math.round(size * 0.22), BG);

  const box = Math.round(size * (1 - padding * 2));
  const ox = Math.round((size - box) / 2);
  const oy = Math.round((size - box) / 2);
  const radius = Math.round(size * 0.04);

  // рама
  roundedRect(canvas, ox, oy, box, box, radius, FRAME);
  // «стекло»
  const glassPad = Math.round(box * 0.09);
  roundedRect(
    canvas,
    ox + glassPad,
    oy + glassPad,
    box - glassPad * 2,
    box - glassPad * 2,
    Math.round(radius * 0.6),
    [214, 231, 244, 255],
  );

  // ламели жалюзи
  const slatPad = Math.round(box * 0.16);
  const slatArea = box - slatPad * 2;
  const slats = 4;
  const slatHeight = Math.max(2, Math.round(slatArea * 0.17));
  const gap = Math.round((slatArea - slats * slatHeight) / (slats - 1));
  for (let i = 0; i < slats; i += 1) {
    const y = oy + slatPad + i * (slatHeight + gap);
    roundedRect(canvas, ox + slatPad, y, slatArea, slatHeight, Math.round(slatHeight / 2), i % 2 ? WARM : SLAT);
  }

  // шнур управления
  const cordX = ox + box - Math.round(box * 0.06);
  for (let y = oy + slatPad; y < oy + box - slatPad; y += 2) put(canvas, cordX, y, FRAME);

  return canvas;
}

fs.mkdirSync(outDir, { recursive: true });
const targets = [
  { file: 'icon-192.png', size: 192, padding: 0.14 },
  { file: 'icon-512.png', size: 512, padding: 0.14 },
  // maskable: рисунок ужат внутрь безопасной зоны 80%
  { file: 'maskable-512.png', size: 512, padding: 0.26 },
  { file: 'apple-touch-icon.png', size: 180, padding: 0.16 },
];

for (const target of targets) {
  const png = encodePng(draw(target.size, { padding: target.padding }));
  fs.writeFileSync(path.join(outDir, target.file), png);
  console.log(`  ${target.file}  ${target.size}×${target.size}  ${(png.length / 1024).toFixed(1)} КБ`);
}
console.log(`Иконки записаны в ${outDir}`);