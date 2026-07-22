/**
 * Platform detection.
 *
 * This is the ONLY module allowed to care what hardware or OS we are on.
 * Everything else asks this module and then talks to an abstraction.
 *
 * Detection is done once at startup and cached - the answer cannot change
 * while the process is alive.
 */

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

/**
 * @typedef {'android' | 'raspberrypi' | 'linux' | 'windows' | 'macos' | 'unknown'} PlatformId
 */

/**
 * @typedef {object} PlatformInfo
 * @property {PlatformId} id            Coarse platform family.
 * @property {string}     label         Human readable description.
 * @property {string}     os            process.platform
 * @property {string}     arch          process.arch
 * @property {string}     kernel        os.release()
 * @property {boolean}    isTermux      Running inside Termux on Android.
 * @property {boolean}    isRaspberryPi Running on Raspberry Pi hardware.
 * @property {string|null} model        Board model string, when discoverable.
 */

/** Read a file, returning null instead of throwing. Used for /proc and /sys probes. */
function readTextOrNull(path) {
  try {
    if (!existsSync(path)) return null;
    // device-tree entries are NUL terminated.
    return readFileSync(path, 'utf8').replace(/\0/g, '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Is this Termux on Android?
 *
 * Two independent signals, and both are needed:
 *
 *   - `process.platform === 'android'`. Current Node builds shipped by Termux
 *     report this. Anything that only tests for 'linux' silently misidentifies
 *     the phone and falls back to a silent audio backend.
 *   - Termux's own markers. Older Node builds report 'linux' instead, so the
 *     prefix path and TERMUX_VERSION still have to be checked.
 *
 * @param {string} platform  process.platform
 * @param {NodeJS.ProcessEnv} env
 */
function detectTermux(platform, env) {
  if (platform === 'android') return true;
  if (env.TERMUX_VERSION) return true;
  if ((env.PREFIX || '').includes('com.termux')) return true;
  if (existsSync('/data/data/com.termux/files/usr')) return true;
  return false;
}

/**
 * Raspberry Pi boards advertise themselves in the device tree. Falling back to
 * /proc/cpuinfo covers older 32-bit Raspberry Pi OS images.
 */
function detectRaspberryPi() {
  const model = readTextOrNull('/proc/device-tree/model');
  if (model && /raspberry\s*pi/i.test(model)) return { isPi: true, model };

  const cpuinfo = readTextOrNull('/proc/cpuinfo');
  if (cpuinfo && /raspberry\s*pi/i.test(cpuinfo)) {
    const match = cpuinfo.match(/^Model\s*:\s*(.+)$/m);
    return { isPi: true, model: match ? match[1].trim() : 'Raspberry Pi' };
  }
  return { isPi: false, model: model ?? null };
}

/** @type {PlatformInfo | null} */
let cached = null;

/**
 * Detect the current platform.
 *
 * @param {{platform?: string, arch?: string, env?: NodeJS.ProcessEnv}} [overrides]
 *   Test seam only. When supplied, the result is neither read from nor written
 *   to the cache, so tests cannot poison the real detection.
 * @returns {PlatformInfo}
 */
export function detectPlatform(overrides) {
  if (!overrides && cached) return cached;

  const platform = overrides?.platform ?? process.platform;
  const arch = overrides?.arch ?? process.arch;
  const env = overrides?.env ?? process.env;

  const base = { os: platform, arch, kernel: os.release() };

  /** @param {PlatformInfo} info */
  const finish = (info) => {
    if (!overrides) cached = info;
    return info;
  };

  // Android first: a Termux install reports platform 'android' on current Node
  // builds and 'linux' on older ones, so this check has to come before the
  // Linux branch or phones get classified as generic Linux (or, worse, as
  // unknown - which is what shipped and left every phone silent).
  if (detectTermux(platform, env)) {
    return finish({
      ...base,
      id: 'android',
      label: `Android / Termux (${arch})`,
      isTermux: true,
      isRaspberryPi: false,
      model: readTextOrNull('/proc/device-tree/model'),
    });
  }

  if (platform === 'linux') {
    const { isPi, model } = detectRaspberryPi();
    return finish({
      ...base,
      id: isPi ? 'raspberrypi' : 'linux',
      label: isPi ? `${model} (${arch})` : `Linux ${os.release()} (${arch})`,
      isTermux: false,
      isRaspberryPi: isPi,
      model,
    });
  }

  /** @type {Record<string, PlatformId>} */
  const others = { win32: 'windows', darwin: 'macos' };
  const id = others[platform] ?? 'unknown';

  return finish({
    ...base,
    id,
    label: `${id === 'unknown' ? platform : id} ${os.release()} (${arch})`,
    isTermux: false,
    isRaspberryPi: false,
    model: null,
  });
}

/** Test seam: forget the cached detection result. */
export function resetPlatformCache() {
  cached = null;
}
