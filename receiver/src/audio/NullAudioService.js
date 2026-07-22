/**
 * NullAudioService - accepts audio and plays nothing.
 *
 * Not a stub: it is how the receiver stays honest about being platform
 * independent. Every non-audio feature - auth, WebSocket, push-to-talk floor
 * control, diagnostics, logging - can be developed and tested on a Windows or
 * macOS laptop, in CI, or on a headless server with no sound card, using the
 * exact same code paths that will later drive a real speaker.
 *
 * Selected automatically when no audio backend is available, or explicitly
 * with AUDIO_BACKEND=null.
 */

import { AudioService } from './AudioService.js';

export class NullAudioService extends AudioService {
  constructor(options) {
    super(options);
    this.name = 'null';
    /** Reason this backend was chosen, surfaced in diagnostics. */
    this.reason = options.reason ?? 'explicitly configured';
  }

  async _openSink(format) {
    this.log.info('null audio sink opened (no sound will be produced)', { format });
  }

  /** @param {Buffer} chunk */
  _writeToSink(chunk) {
    // Counted by the base class; discarded here.
    this.log.trace('null sink discarded audio', { bytes: chunk.length });
    return true;
  }

  async _closeSink() {
    this.log.debug('null audio sink closed');
  }

  /** @param {number} percent */
  async _applyVolume(percent) {
    this.log.debug('null sink volume noted', { percent });
  }

  async _readVolume() {
    return this.volume;
  }

  async probe() {
    return {
      available: true,
      detail: `null backend active (${this.reason}) - audio is accepted and discarded`,
      silent: true,
    };
  }
}
