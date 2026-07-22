/**
 * AndroidAudioService - playback on Android under Termux.
 *
 * Android has no ALSA access from userspace, and Termux's own
 * `termux-media-player` only plays finished files, which is useless for a
 * live push-to-talk stream. The working path is PulseAudio built for Termux
 * with `module-sles-sink`, which bridges to Android's OpenSL ES output.
 *
 * Once that daemon is up, playback is ordinary `paplay` - exactly what a
 * Linux desktop does. So this class inherits the entire Linux implementation
 * and adds only the Android-specific bootstrap and volume control.
 *
 *   pkg install pulseaudio
 *
 * Note the package name: on Termux, paplay and pactl ship inside `pulseaudio`
 * itself. `pulseaudio-utils` is a Debian name and does not exist here.
 */

import { LinuxAudioService } from './LinuxAudioService.js';
import { runCommand, whichAll, commandExists } from './exec.js';

const SINK_MODULE = 'module-sles-sink';

export class AndroidAudioService extends LinuxAudioService {
  constructor(options) {
    super(options);
    this.name = 'android';
    /** Whether termux-api's volume control is usable. Resolved during init(). */
    this.hasTermuxApi = false;
  }

  /**
   * Make sure a PulseAudio daemon with an Android sink is running before the
   * first push-to-talk arrives - starting it lazily would clip the first word.
   *
   * Start the daemon first, then load a sink only if one is missing. Passing
   * `--load=module-sles-sink` at startup looks tidier but is wrong: Termux's
   * own default.pa already loads that module on most installs, so doing both
   * produces two sinks pointing at the same output. That is not fatal, but it
   * makes "which sink does the volume control affect?" ambiguous.
   */
  async init() {
    this.hasTermuxApi = await commandExists('termux-volume');

    if (!(await commandExists('pulseaudio'))) {
      this.log.warn('pulseaudio not installed; audio playback will fail', {
        fix: 'pkg install pulseaudio',
      });
      return;
    }

    if (!(await this.#isDaemonRunning())) {
      this.log.info('starting pulseaudio');
      try {
        const { code, stderr } = await runCommand(
          'pulseaudio',
          // Never let the daemon shut down between transmissions.
          ['--start', '--exit-idle-time=-1'],
          { timeoutMs: 10_000 }
        );
        if (code !== 0) {
          this.log.warn('pulseaudio failed to start', { stderr: stderr.trim(), exitCode: code });
          return;
        }
      } catch (err) {
        this.log.warn('could not start pulseaudio', { error: err });
        return;
      }
    }

    await this.#ensureAndroidSink();
  }

  /** @returns {Promise<boolean>} */
  async #isDaemonRunning() {
    try {
      const { code } = await runCommand('pulseaudio', ['--check']);
      return code === 0;
    } catch {
      // --check exits non-zero when not running; treat errors the same way.
      return false;
    }
  }

  /**
   * Load the Android output sink only if the daemon does not already have one.
   */
  async #ensureAndroidSink() {
    let sinks = '';
    try {
      const { code, stdout } = await runCommand('pactl', ['list', 'short', 'sinks']);
      if (code === 0) sinks = stdout;
    } catch {
      /* fall through and try to load one anyway */
    }

    // Termux names it OpenSL_ES_sink by default; we name ours OpenSLES_SINK.
    // Match on the module rather than either name so both count.
    if (/sles/i.test(sinks)) {
      this.log.info('android audio sink already present', {
        sinks: sinks.trim().split('\n').length,
      });
      return;
    }

    this.log.info('loading the Android SLES sink');
    try {
      const { code, stderr } = await runCommand('pactl', [
        'load-module',
        SINK_MODULE,
        'sink_name=OpenSLES_SINK',
      ]);
      if (code !== 0) {
        this.log.warn('could not load the Android audio sink', { stderr: stderr.trim() });
      }
    } catch (err) {
      this.log.warn('could not load the Android audio sink', { error: err });
    }
  }

  /**
   * Prefer Android's own media volume when termux-api is installed, because
   * that is the slider the user actually reaches for on the device. Fall back
   * to PulseAudio's software volume otherwise.
   * @param {number} percent
   */
  async _applyVolume(percent) {
    if (this.hasTermuxApi) {
      // termux-volume uses the stream's native scale, not a percentage.
      const max = await this._readTermuxMaxVolume();
      if (max) {
        const level = Math.round((percent / 100) * max);
        const { code, stderr } = await runCommand('termux-volume', ['music', String(level)]);
        if (code === 0) return;
        this.log.debug('termux-volume failed, falling back to pactl', { stderr: stderr.trim() });
      }
    }
    await super._applyVolume(percent);
  }

  /** @returns {Promise<number|null>} */
  async _readVolume() {
    if (this.hasTermuxApi) {
      const stream = await this._readTermuxStream();
      if (stream) return Math.round((stream.volume / stream.max_volume) * 100);
    }
    return super._readVolume();
  }

  /** @returns {Promise<{volume: number, max_volume: number} | null>} */
  async _readTermuxStream() {
    try {
      const { code, stdout } = await runCommand('termux-volume', []);
      if (code !== 0) return null;
      const streams = JSON.parse(stdout);
      return streams.find((s) => s.stream === 'music') ?? null;
    } catch {
      return null;
    }
  }

  async _readTermuxMaxVolume() {
    const stream = await this._readTermuxStream();
    return stream?.max_volume ?? null;
  }

  async probe() {
    const tools = await whichAll(['pulseaudio', 'paplay', 'pactl', 'termux-volume']);

    if (!tools.pulseaudio || !tools.paplay) {
      return {
        available: false,
        tools,
        detail:
          'PulseAudio is required on Termux. Install it with: pkg install pulseaudio ' +
          '(paplay and pactl are inside that package; there is no pulseaudio-utils on Termux)',
      };
    }

    try {
      const { code } = await runCommand('pulseaudio', ['--check']);
      if (code !== 0) {
        return {
          available: false,
          tools,
          detail:
            'pulseaudio is installed but not running. The receiver starts it automatically; ' +
            'if that failed, run it by hand:\n' +
            `  pulseaudio --start --exit-idle-time=-1 --load="${SINK_MODULE} sink_name=OpenSLES_SINK"`,
        };
      }
    } catch {
      return { available: false, tools, detail: 'could not check the pulseaudio daemon' };
    }

    const base = await super.probe();
    return { ...base, tools, detail: `Termux + PulseAudio: ${base.detail}` };
  }
}
