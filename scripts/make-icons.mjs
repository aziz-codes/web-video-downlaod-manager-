// Renders the extension icon at every size Chrome needs.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#4f8bff"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#g)"/>
  <path d="M25 17.5v17l14-8.5z" fill="#fff" opacity=".95"/>
  <path d="M32 38v9m-6-5 6 6 6-6M20 51h24" stroke="#fff" stroke-width="${size <= 16 ? 5 : 4}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

mkdirSync(new URL('../public/icon/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 96, 128]) {
  await sharp(Buffer.from(svg(size)), { density: 72 * 8 })
    .resize(size, size)
    .png()
    .toFile(new URL(`../public/icon/${size}.png`, import.meta.url).pathname);
}
console.log('icons written');
