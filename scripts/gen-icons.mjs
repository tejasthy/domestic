#!/usr/bin/env node
/** Renders the app icons from the same mark the UI uses. Run after a logo change. */
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const BLUE = '#00274C';
const MAIZE = '#FFCB05';

/** `inset` leaves the safe area maskable icons need for Android's circle crop. */
const mark = (bg, fg, inset = 0) => {
  const s = 1 - inset * 2;
  const t = `translate(${inset * 32} ${inset * 32}) scale(${s})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" fill="${bg}"/>
    <g transform="${t}">
      <path d="M16 7L26 15.5H23.2V25H8.8V15.5H6L16 7Z" fill="${fg}"/>
      <rect x="13.4" y="18.5" width="5.2" height="6.5" rx="1" fill="${bg}"/>
    </g>
  </svg>`;
};

const targets = [
  { file: 'icon-192.png', size: 192, svg: mark(BLUE, MAIZE) },
  { file: 'icon-512.png', size: 512, svg: mark(BLUE, MAIZE) },
  { file: 'icon-maskable-512.png', size: 512, svg: mark(BLUE, MAIZE, 0.12) },
  { file: 'apple-touch-icon.png', size: 180, svg: mark(BLUE, MAIZE) },
  { file: 'badge-96.png', size: 96, svg: mark('#00000000', '#FFFFFF') },
];

await mkdir(new URL('../public/icons/', import.meta.url), { recursive: true });

for (const { file, size, svg } of targets) {
  const png = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  await writeFile(new URL(`../public/icons/${file}`, import.meta.url), png);
  console.log(`public/icons/${file}  ${size}×${size}`);
}
