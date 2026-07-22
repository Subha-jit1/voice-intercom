/**
 * make-icon - render the application icon as a PNG.
 *
 * electron-builder needs a real raster icon (it derives .ico and the various
 * Linux sizes from a 512x512 PNG). Rather than add an image library or commit
 * a binary blob nobody can diff, this draws the icon from the same geometry as
 * controller/icon.svg and encodes the PNG by hand with node:zlib.
 *
 *   node tools/make-icon.js controller-desktop/build/icon.png [size] [--maskable]
 *
 * --maskable produces the Android adaptive-icon variant: full-bleed background
 * with the glyph shrunk into the centre safe zone, so the launcher can crop it
 * to a circle or squircle without clipping.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const MASKABLE = process.argv.includes('--maskable');

const OUTPUT = resolve(args[0] ?? 'controller-desktop/build/icon.png');
const SIZE = Number(args[1] ?? 512);

/**
 * Fraction of the canvas the glyph may occupy in maskable mode. Android
 * guarantees only the centre 80% survives cropping; 66% leaves margin.
 */
const SAFE_ZONE = 0.66;

/** Samples per axis. Edges are drawn by testing coverage, so this is the antialiasing. */
const SUPERSAMPLE = 4;

const BACKGROUND = [0x0f, 0x14, 0x19];
const FOREGROUND = [0x3f, 0xb9, 0x50];

// --- Geometry ---------------------------------------------------------------
// All coordinates are fractions of the icon's edge, so the shape is identical
// at any size.

/** Rounded rectangle, measured from its centre. */
function inRoundedRect(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  if (dx <= 0 && dy <= 0) return true;
  const qx = Math.max(dx, 0);
  const qy = Math.max(dy, 0);
  return qx * qx + qy * qy <= radius * radius;
}

/** The lower half of a ring — the cradle under a microphone. */
function inLowerAnnulus(px, py, cx, cy, outer, inner) {
  if (py < cy) return false;
  const distance = Math.hypot(px - cx, py - cy);
  return distance <= outer && distance >= inner;
}

function isBackground(px, py) {
  // Maskable icons must fill the whole canvas - the launcher supplies the
  // shape, and rounding it ourselves would show as a gap inside the crop.
  if (MASKABLE) return true;
  return inRoundedRect(px, py, 0.5, 0.5, 0.5, 0.5, 0.225);
}

function isGlyph(px, py) {
  // Capsule: the microphone body.
  if (inRoundedRect(px, py, 0.5, 0.36, 0.085, 0.16, 0.085)) return true;
  // Cradle.
  if (inLowerAnnulus(px, py, 0.5, 0.475, 0.215, 0.175)) return true;
  // Stem.
  if (inRoundedRect(px, py, 0.5, 0.715, 0.018, 0.068, 0.018)) return true;
  // Base.
  if (inRoundedRect(px, py, 0.5, 0.80, 0.105, 0.021, 0.021)) return true;
  return false;
}

function isForeground(px, py) {
  if (!MASKABLE) return isGlyph(px, py);
  // Sample the glyph through an inverse scale about the centre, which shrinks
  // it into the safe zone without redefining any of the geometry above.
  return isGlyph(0.5 + (px - 0.5) / SAFE_ZONE, 0.5 + (py - 0.5) / SAFE_ZONE);
}

// --- Rasterise --------------------------------------------------------------

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bg = 0;
      let fg = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!isBackground(px, py)) continue;
          bg += 1;
          if (isForeground(px, py)) fg += 1;
        }
      }

      const offset = (y * size + x) * 4;
      if (bg === 0) {
        pixels.writeUInt32BE(0, offset); // fully transparent outside the rounded square
        continue;
      }

      // Blend foreground over background by sub-pixel coverage, then apply the
      // background's own coverage as alpha so the rounded corners stay smooth.
      const mix = fg / bg;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - mix) + FOREGROUND[channel] * mix
        );
      }
      pixels[offset + 3] = Math.round((bg / samples) * 255);
    }
  }

  return pixels;
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

/** @param {Buffer} pixels RGBA @param {number} size */
function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 means "none", which
  // costs a little size but keeps this readable.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Run --------------------------------------------------------------------

mkdirSync(dirname(OUTPUT), { recursive: true });
const png = encodePng(render(SIZE), SIZE);
writeFileSync(OUTPUT, png);

process.stdout.write(`Wrote ${OUTPUT} (${SIZE}x${SIZE}, ${png.length} bytes)\n`);
