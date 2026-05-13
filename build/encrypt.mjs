#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes, createCipheriv } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_FILE = resolve(ROOT, '.key');
const SRC = resolve(ROOT, 'src');
const DOCS = resolve(ROOT, 'docs');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function loadOrCreateKey() {
  if (existsSync(KEY_FILE)) {
    const raw = readFileSync(KEY_FILE, 'utf8').trim();
    const key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (key.length !== 32) throw new Error('.key invalide (32 octets attendus en base64url)');
    return key;
  }
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, b64url(key) + '\n', { mode: 0o600 });
  console.log('Nouvelle clé générée → .key');
  return key;
}

function encryptBuffer(key, plaintextBuf) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

const key = loadOrCreateKey();

// ---- 1. content (html + css + meta) → content.enc.json ----
const html = readFileSync(join(SRC, 'content.html'), 'utf8');
const css = readFileSync(join(SRC, 'content.css'), 'utf8');
const meta = JSON.parse(readFileSync(join(SRC, 'meta.json'), 'utf8'));
const contentObj = { html, css, ...meta };

// ---- 2. audio (.mp3/.wav/.ogg/.m4a) → audio.enc.bin ----
const AUDIO_RX = /\.(mp3|wav|ogg|m4a)$/i;
const audioFile = readdirSync(SRC).find((f) => AUDIO_RX.test(f));
if (audioFile) {
  const buf = readFileSync(join(SRC, audioFile));
  writeFileSync(join(DOCS, 'audio.enc.bin'), encryptBuffer(key, buf));
  contentObj.audio = true;
  console.log(`OK → docs/audio.enc.bin (source: "${audioFile}", ${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

// ---- 3. images (png/jpg/webp) → <name>.enc.bin + liste dans content ----
const IMG_RX = /\.(png|jpg|jpeg|webp)$/i;
const imageEntries = [];
for (const f of readdirSync(SRC)) {
  const m = f.match(IMG_RX);
  if (!m) continue;
  const name = f.slice(0, -m[0].length).toLowerCase();
  const ext = m[1].toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const buf = readFileSync(join(SRC, f));
  writeFileSync(join(DOCS, `${name}.enc.bin`), encryptBuffer(key, buf));
  imageEntries.push({ name, mime });
  console.log(`OK → docs/${name}.enc.bin (source: "${f}", ${(buf.length / 1024).toFixed(0)} KB)`);
}
if (imageEntries.length) contentObj.images = imageEntries;

// ---- 4. fonts (otf/ttf/woff/woff2) → <name>.enc.bin + liste dans content ----
const FONT_RX = /\.(otf|ttf|woff2|woff)$/i;
const fontEntries = [];
for (const f of readdirSync(SRC)) {
  const m = f.match(FONT_RX);
  if (!m) continue;
  const name = f.slice(0, -m[0].length).toLowerCase();
  const ext = m[1].toLowerCase();
  const mime = ext === 'otf' ? 'font/otf'
            : ext === 'ttf' ? 'font/ttf'
            : ext === 'woff2' ? 'font/woff2'
            : 'font/woff';
  const family = name.charAt(0).toUpperCase() + name.slice(1);
  const buf = readFileSync(join(SRC, f));
  writeFileSync(join(DOCS, `${name}.enc.bin`), encryptBuffer(key, buf));
  fontEntries.push({ name, family, mime });
  console.log(`OK → docs/${name}.enc.bin (font: "${f}" → family "${family}", ${(buf.length / 1024).toFixed(0)} KB)`);
}
if (fontEntries.length) contentObj.fonts = fontEntries;

// ---- 4. content.enc.json ----
const contentEnc = encryptBuffer(key, Buffer.from(JSON.stringify(contentObj), 'utf8'));
const iv = contentEnc.subarray(0, 12);
const rest = contentEnc.subarray(12);
writeFileSync(
  join(DOCS, 'content.enc.json'),
  JSON.stringify({ iv: b64url(iv), data: b64url(rest) })
);
console.log('OK → docs/content.enc.json');

// ---- 5. cache-bust : timestamp injecté dans docs/index.html ----
const INDEX = join(DOCS, 'index.html');
const idx = readFileSync(INDEX, 'utf8');
const stamped = idx.replace(/app\.js\?v=\d+/, `app.js?v=${Date.now()}`);
if (stamped !== idx) {
  writeFileSync(INDEX, stamped);
  console.log('OK → docs/index.html (cache-bust mis à jour)');
}

console.log('\nURL complète pour le QR :');
console.log('  https://bimbamboombimbim.github.io/Boop/#' + b64url(key) + '\n');
