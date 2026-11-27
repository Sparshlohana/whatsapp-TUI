const sharp = require('sharp');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { unwrap } = require('./message');

const VIEWABLE = ['stickerMessage', 'imageMessage'];
const CACHE_MAX = 30;
const cache = new Map();
const logger = pino({ level: 'silent' });

function viewableKind(m) {
  const content = unwrap(m?.message);
  if (!content) return null;
  const key = VIEWABLE.find((k) => content[k]);
  return key ? key.replace('Message', '') : null;
}

async function downloadImage(m, client) {
  const id = m.key?.id;
  if (id && cache.has(id)) return cache.get(id);
  const buf = await downloadMediaMessage(
    m,
    'buffer',
    {},
    { logger, reuploadRequest: client?.updateMediaMessage }
  );
  if (id) {
    cache.set(id, buf);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return buf;
}

const hex = (d, i) =>
  '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');

async function renderHalfBlocks(buf, cols, rows) {
  const { data, info } = await sharp(buf, { animated: false })
    .ensureAlpha()
    .resize({
      width: Math.max(1, cols),
      height: Math.max(2, rows * 2),
      fit: 'inside',
      kernel: 'lanczos3',
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const opaque = (i) => data[i + 3] >= 128;
  const lines = [];
  for (let y = 0; y < height; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const t = (y * width + x) * 4;
      const b = y + 1 < height ? ((y + 1) * width + x) * 4 : -1;
      const top = opaque(t);
      const bot = b >= 0 && opaque(b);
      if (top && bot) line += `{${hex(data, t)}-fg}{${hex(data, b)}-bg}▀{/}`;
      else if (top) line += `{${hex(data, t)}-fg}▀{/}`;
      else if (bot) line += `{${hex(data, b)}-fg}▄{/}`;
      else line += ' ';
    }
    lines.push(line);
  }
  return { lines, width };
}

module.exports = { viewableKind, downloadImage, renderHalfBlocks };
