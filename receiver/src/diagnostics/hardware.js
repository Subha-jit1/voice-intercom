/**
 * Optional hardware sensors.
 *
 * Every reading here is best-effort and returns null when unavailable. This
 * is the only module besides platform/detect.js that touches hardware, and
 * nothing depends on it succeeding - which is what lets the identical build
 * run on a Raspberry Pi, a phone and a laptop.
 */

import { readFile } from 'node:fs/promises';
import { detectPlatform } from '../platform/detect.js';
import { runCommand, commandExists } from '../audio/exec.js';

/**
 * SoC temperature in Celsius via the generic Linux thermal zone interface.
 * Present on Raspberry Pi OS and on most Android kernels; absent elsewhere.
 * @returns {Promise<number | null>}
 */
export async function readTemperatureC() {
  try {
    const raw = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    const milli = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(milli)) return null;
    // Some kernels report Celsius directly, others millidegrees.
    return Math.round((milli > 1000 ? milli / 1000 : milli) * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Raspberry Pi power/thermal throttling.
 *
 * Genuinely Pi-only, and worth having: a Pi Zero 2 W on an underpowered
 * supply throttles silently, and the first symptom is stuttering audio that
 * looks like a network problem. Isolated here so no caller has to know it
 * exists - it simply returns null everywhere else.
 *
 * @returns {Promise<{raw: string, underVoltage: boolean, throttled: boolean, frequencyCapped: boolean} | null>}
 */
export async function readPiThrottling() {
  if (!detectPlatform().isRaspberryPi) return null;
  if (!(await commandExists('vcgencmd'))) return null;

  try {
    const { code, stdout } = await runCommand('vcgencmd', ['get_throttled']);
    if (code !== 0) return null;

    const match = stdout.match(/throttled=0x([0-9a-fA-F]+)/);
    if (!match) return null;

    const bits = Number.parseInt(match[1], 16);
    return {
      raw: `0x${match[1]}`,
      // Bits 0-2 are "right now"; bits 16-18 are "since boot".
      underVoltage: Boolean(bits & 0x1) || Boolean(bits & 0x10000),
      frequencyCapped: Boolean(bits & 0x2) || Boolean(bits & 0x20000),
      throttled: Boolean(bits & 0x4) || Boolean(bits & 0x40000),
    };
  } catch {
    return null;
  }
}

/**
 * Collect every optional sensor that this machine happens to expose.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readHardwareSensors() {
  const [temperatureC, throttling] = await Promise.all([readTemperatureC(), readPiThrottling()]);

  /** @type {Record<string, unknown>} */
  const sensors = {};
  if (temperatureC !== null) sensors.temperatureC = temperatureC;
  if (throttling !== null) sensors.piThrottling = throttling;
  return sensors;
}
