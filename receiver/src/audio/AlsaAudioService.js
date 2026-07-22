/**
 * AlsaAudioService - playback through ALSA's `aplay`.
 *
 * This is the Raspberry Pi path, but nothing here is Pi-specific: any Debian
 * or Ubuntu machine with alsa-utils installed uses the same code. The Pi is
 * simply another ALSA host.
 */

import { ProcessAudioService } from './ProcessAudioService.js';
import { runCommand, whichAll } from './exec.js';

/**
 * Mixer controls worth trying, best first. Raspberry Pi OS exposes 'PCM' on
 * the headphone jack and 'Master' on most USB DACs; desktops usually have
 * 'Master'.
 */
const VOLUME_CONTROL_PREFERENCE = ['Master', 'PCM', 'Speaker', 'Headphone', 'Digital'];

export class AlsaAudioService extends ProcessAudioService {
  constructor(options) {
    super(options);
    this.name = 'alsa';
    /** @type {string | null} Discovered lazily on first volume change. */
    this.mixerControl = null;
  }

  /** @param {import('../config/types.js').AudioFormat} format */
  _playbackCommand(format) {
    const args = [
      '-q',
      '-t', 'raw',
      '-f', format.bitDepth === 16 ? 'S16_LE' : 'S32_LE',
      '-r', String(format.sampleRate),
      '-c', String(format.channels),
    ];
    if (this.config.device) args.push('-D', this.config.device);
    args.push('-'); // read from stdin

    return { command: 'aplay', args };
  }

  /**
   * Find a mixer control we can actually set. Cached after the first success.
   * @returns {Promise<string | null>}
   */
  async _findMixerControl() {
    if (this.mixerControl) return this.mixerControl;

    try {
      const { code, stdout } = await runCommand('amixer', ['scontrols']);
      if (code !== 0) return null;

      const available = [...stdout.matchAll(/Simple mixer control '([^']+)'/g)].map((m) => m[1]);
      this.mixerControl =
        VOLUME_CONTROL_PREFERENCE.find((c) => available.includes(c)) ?? available[0] ?? null;

      if (this.mixerControl) {
        this.log.debug('alsa mixer control selected', { control: this.mixerControl, available });
      }
      return this.mixerControl;
    } catch {
      return null;
    }
  }

  /** @param {number} percent */
  async _applyVolume(percent) {
    const control = await this._findMixerControl();
    if (!control) {
      throw new Error('no ALSA mixer control found (is alsa-utils installed?)');
    }
    const { code, stderr } = await runCommand('amixer', ['-q', 'set', control, `${percent}%`]);
    if (code !== 0) throw new Error(`amixer set failed: ${stderr.trim() || `exit ${code}`}`);
  }

  /** @returns {Promise<number|null>} */
  async _readVolume() {
    const control = await this._findMixerControl();
    if (!control) return null;

    const { code, stdout } = await runCommand('amixer', ['get', control]);
    if (code !== 0) return null;

    const match = stdout.match(/\[(\d{1,3})%\]/);
    return match ? Number.parseInt(match[1], 10) : null;
  }

  async probe() {
    const tools = await whichAll(['aplay', 'amixer']);

    if (!tools.aplay) {
      return {
        available: false,
        tools,
        detail: 'aplay not found. Install it with: sudo apt install alsa-utils',
      };
    }

    let devices = [];
    try {
      const { stdout } = await runCommand('aplay', ['-l']);
      devices = [...stdout.matchAll(/^card \d+: .*$/gm)].map((m) => m[0].trim());
    } catch {
      /* listing devices is best-effort */
    }

    if (devices.length === 0) {
      return {
        available: false,
        tools,
        devices,
        detail:
          'aplay is installed but reports no sound cards. On a Raspberry Pi check that ' +
          'audio is enabled and a speaker/DAC is connected.',
      };
    }

    return {
      available: true,
      tools,
      devices,
      detail: `${devices.length} ALSA playback device(s) available`,
    };
  }
}
