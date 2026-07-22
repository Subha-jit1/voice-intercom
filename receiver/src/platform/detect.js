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
 * Termux exposes itself through its prefix path and, on recent versions, an
 * explicit TERMUX_VERSION variable. We check several signals because users
 * run the receiver from systemd-like supervisors that strip the environment.
 */
function detectTermux() {
  if (process.env.TERMUX_VERSION) return true;
  const prefix = process.env.PREFIX || '';
  if (prefix.includes('com.termux')) return true;
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
 * @returns {PlatformInfo}
 */
export function detectPlatform() {
  if (cached) return cached;

  const base = {
    os: process.platform,
    arch: process.arch,
    kernel: os.release(),
  };

  if (process.platform === 'linux') {
    const isTermux = detectTermux();
    if (isTermux) {
      cached = {
        ...base,
        id: 'android',
        label: `Android / Termux (${process.arch})`,
        isTermux: true,
        isRaspberryPi: false,
        model: readTextOrNull('/proc/device-tree/model'),
      };
      return cached;
    }

    const { isPi, model } = detectRaspberryPi();
    cached = {
      ...base,
      id: isPi ? 'raspberrypi' : 'linux',
      label: isPi ? `${model} (${process.arch})` : `Linux ${os.release()} (${process.arch})`,
      isTermux: false,
      isRaspberryPi: isPi,
      model,
    };
    return cached;
  }

  /** @type {Record<string, PlatformId>} */
  const nonLinux = { win32: 'windows', darwin: 'macos' };
  const id = nonLinux[process.platform] ?? 'unknown';

  cached = {
    ...base,
    id,
    label: `${id} ${os.release()} (${process.arch})`,
    isTermux: false,
    isRaspberryPi: false,
    model: null,
  };
  return cached;
}

/** Test seam: forget the cached detection result. */
export function resetPlatformCache() {
  cached = null;
}
