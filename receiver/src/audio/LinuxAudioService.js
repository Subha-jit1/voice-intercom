/**
 * LinuxAudioService - playback through PulseAudio / PipeWire's `paplay`.
 *
 * The default on Linux desktops, where PulseAudio or PipeWire owns the sound
 * device and ALSA access would be blocked. Also the base class for the
 * Termux backend, which speaks the same protocol to a PulseAudio daemon that
 * happens to be bridged to Android's audio stack.
 */

import { ProcessAudioService } from './ProcessAudioService.js';
import { runCommand, whichAll } from './exec.js';

export class LinuxAudioService extends ProcessAudioService {
  constructor(options) {
    super(options);
    this.name = 'linux';
  }

  /** @param {import('../config/types.js').AudioFormat} format */
  _playbackCommand(format) {
    const args = [
      '--raw',
      `--format=${format.bitDepth === 16 ? 's16le' : 's32le'}`,
      `--rate=${format.sampleRate}`,
      `--channels=${format.channels}`,
      '--stream-name=voice-intercom',
      '--latency-msec=60',
    ];
    if (this.config.device) args.push(`--device=${this.config.device}`);

    // paplay reads stdin when given no file argument.
    return { command: 'paplay', args };
  }

  /** @param {number} percent */
  async _applyVolume(percent) {
    const sink = this.config.device || '@DEFAULT_SINK@';
    const { code, stderr } = await runCommand('pactl', [
      'set-sink-volume',
      sink,
      `${percent}%`,
    ]);
    if (code !== 0) throw new Error(`pactl set-sink-volume failed: ${stderr.trim() || `exit ${code}`}`);
  }

  /** @returns {Promise<number|null>} */
  async _readVolume() {
    const sink = this.config.device || '@DEFAULT_SINK@';

    // pactl 15+ has get-sink-volume; older builds only list sinks.
    try {
      const { code, stdout } = await runCommand('pactl', ['get-sink-volume', sink]);
      if (code === 0) {
        const match = stdout.match(/(\d{1,3})%/);
        if (match) return Number.parseInt(match[1], 10);
      }
    } catch {
      /* fall through to the older path */
    }

    try {
      const { code, stdout } = await runCommand('pactl', ['list', 'sinks']);
      if (code !== 0) return null;
      const match = stdout.match(/Volume:.*?(\d{1,3})%/s);
      return match ? Number.parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  async probe() {
    const tools = await whichAll(['paplay', 'pactl']);

    if (!tools.paplay) {
      return {
        available: false,
        tools,
        detail: 'paplay not found. Install it with: sudo apt install pulseaudio-utils',
      };
    }

    try {
      const { code, stdout } = await runCommand('pactl', ['list', 'short', 'sinks']);
      const sinks = stdout.trim().split('\n').filter(Boolean);
      if (code !== 0 || sinks.length === 0) {
        return {
          available: false,
          tools,
          sinks,
          detail: 'paplay is installed but no PulseAudio sink is available. Is the daemon running?',
        };
      }
      return { available: true, tools, sinks, detail: `${sinks.length} PulseAudio sink(s)` };
    } catch (err) {
      return {
        available: false,
        tools,
        detail: `could not query PulseAudio: ${err.message}`,
      };
    }
  }
}
