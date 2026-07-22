/**
 * AudioService - the platform abstraction boundary.
 *
 * Business logic (WebSocket handling, push-to-talk floor control, the REST
 * API) talks ONLY to this interface. It never learns whether the sound is
 * coming out of an Android speaker, an ALSA device on a Raspberry Pi, or
 * nothing at all on a developer's Windows laptop.
 *
 * The contract, per the project specification:
 *
 *   play(buffer)    - play one complete PCM buffer
 *   stop()          - stop immediately and release the device
 *   setVolume(pct)  - 0..100
 *   testSpeaker()   - emit a known test tone
 *
 * Push-to-talk is inherently a stream rather than a finished buffer, so the
 * contract is extended with beginStream/write/endStream. play() is then
 * implemented once, here, in terms of those - subclasses never reimplement it.
 *
 * Subclasses implement only the platform-specific parts:
 *   _openSink(format) / _writeToSink(chunk) / _closeSink()
 *   _applyVolume(percent) / _readVolume()
 *   probe()
 */

/**
 * @typedef {import('../config/types.js').AudioFormat} AudioFormat
 */

/**
 * @typedef {object} AudioStats
 * @property {number} framesReceived  Chunks handed to the service.
 * @property {number} bytesReceived
 * @property {number} framesDropped   Dropped because the sink fell behind.
 * @property {number} sinkRestarts
 * @property {number|null} lastPlaybackAt Epoch ms of the last byte written.
 */

export class AudioServiceError extends Error {}

export class AudioService {
  /**
   * @param {object} options
   * @param {import('../config/types.js').AudioConfig} options.config
   * @param {import('../logging/logger.js').Logger} options.logger
   */
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;

    /** Backend identifier surfaced in diagnostics. Subclasses must override. */
    this.name = 'abstract';

    /** @type {boolean} */
    this.streaming = false;
    /** @type {AudioFormat | null} */
    this.format = null;
    /** @type {number} */
    this.volume = 100;

    /** @type {AudioStats} */
    this.stats = {
      framesReceived: 0,
      bytesReceived: 0,
      framesDropped: 0,
      sinkRestarts: 0,
      lastPlaybackAt: null,
    };

    /** @type {NodeJS.Timeout | null} */
    this.idleTimer = null;
  }

  /** Default wire format from configuration. */
  get defaultFormat() {
    return {
      sampleRate: this.config.sampleRate,
      channels: this.config.channels,
      bitDepth: this.config.bitDepth,
    };
  }

  /**
   * One-time setup. Backends that need a daemon running (Termux + PulseAudio)
   * do that work here so the first push-to-talk is not delayed by it.
   */
  async init() {}

  // --- Streaming API -------------------------------------------------------

  /**
   * Open the playback device and get ready to receive PCM.
   * @param {Partial<AudioFormat>} [format]
   */
  async beginStream(format = {}) {
    const target = { ...this.defaultFormat, ...format };

    if (this.streaming && this.format && sameFormat(this.format, target)) {
      this._cancelIdleTimer();
      return this.format;
    }
    if (this.streaming) await this.endStream();

    this.format = target;
    await this._openSink(target);
    this.streaming = true;
    this._cancelIdleTimer();

    this.log.debug('audio stream opened', { backend: this.name, format: target });
    return target;
  }

  /**
   * Push PCM at the current stream format.
   * Returns false when the chunk was dropped because the sink is behind -
   * for realtime audio, dropping beats queueing.
   * @param {Buffer} chunk
   */
  write(chunk) {
    if (!this.streaming) {
      throw new AudioServiceError('write() called before beginStream()');
    }
    this.stats.framesReceived += 1;
    this.stats.bytesReceived += chunk.length;
    this.stats.lastPlaybackAt = Date.now();

    const accepted = this._writeToSink(chunk);
    if (!accepted) this.stats.framesDropped += 1;
    return accepted;
  }

  /**
   * Finish the current stream. The device is held open for idleTimeoutMs so
   * that rapid push-to-talk presses do not pay device-open latency each time.
   */
  async endStream() {
    if (!this.streaming) return;

    if (this.config.idleTimeoutMs > 0) {
      this._cancelIdleTimer();
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this._closeSink()
          .then(() => {
            this.streaming = false;
            this.log.debug('audio sink released after idle timeout', { backend: this.name });
          })
          .catch((err) => this.log.warn('idle sink close failed', { error: err }));
      }, this.config.idleTimeoutMs);
      // Do not keep the event loop alive just to close an idle speaker.
      this.idleTimer.unref?.();
      return;
    }

    await this._closeSink();
    this.streaming = false;
  }

  // --- Specification API ---------------------------------------------------

  /**
   * Play one complete PCM buffer. Implemented once in terms of the streaming
   * primitives so no subclass duplicates it.
   * @param {Buffer} buffer
   * @param {Partial<AudioFormat>} [format]
   */
  async play(buffer, format = {}) {
    await this.beginStream(format);
    this.write(buffer);
    await this.endStream();
  }

  /** Stop playback immediately and release the device. */
  async stop() {
    this._cancelIdleTimer();
    if (this.streaming) {
      await this._closeSink();
      this.streaming = false;
    }
    this.log.info('audio stopped', { backend: this.name });
  }

  /**
   * @param {number} percent 0..100
   */
  async setVolume(percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(percent))));
    if (!Number.isFinite(clamped)) {
      throw new AudioServiceError(`volume must be a number 0-100, got ${percent}`);
    }
    await this._applyVolume(clamped);
    this.volume = clamped;
    this.log.info('volume set', { backend: this.name, percent: clamped });
    return clamped;
  }

  /** @returns {Promise<number|null>} null when the backend cannot report volume. */
  async getVolume() {
    try {
      const value = await this._readVolume();
      if (value != null) this.volume = value;
      return value;
    } catch (err) {
      this.log.debug('volume read failed', { error: err });
      return null;
    }
  }

  /**
   * Emit a test tone.
   *
   * Synthesised in JavaScript rather than shelling out to `speaker-test`,
   * because that tool does not exist on Termux and behaves differently across
   * distributions. Generating the PCM ourselves means the test exercises
   * exactly the same code path as real push-to-talk audio, on every platform.
   *
   * @param {{durationMs?: number, frequency?: number}} [options]
   */
  async testSpeaker({ durationMs = 900, frequency = 440 } = {}) {
    const format = this.defaultFormat;
    const tone = generateTone({ ...format, durationMs, frequency });

    const startedAt = Date.now();
    await this.play(tone, format);

    return {
      backend: this.name,
      format,
      frequency,
      durationMs,
      bytes: tone.length,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * Report whether this backend can actually work right now - used by
   * diagnostics so a silent speaker is debuggable without SSH.
   * @returns {Promise<{available: boolean, detail: string, tools?: Record<string, boolean>}>}
   */
  async probe() {
    return { available: true, detail: 'no probe implemented for this backend' };
  }

  /** Release everything. Called on shutdown. */
  async shutdown() {
    this._cancelIdleTimer();
    if (this.streaming) {
      await this._closeSink().catch(() => {});
      this.streaming = false;
    }
  }

  /** Snapshot for the diagnostics endpoint. */
  describe() {
    return {
      backend: this.name,
      streaming: this.streaming,
      format: this.format ?? this.defaultFormat,
      volume: this.volume,
      stats: { ...this.stats },
    };
  }

  // --- Subclass hooks ------------------------------------------------------

  /** @param {AudioFormat} _format */
  async _openSink(_format) {
    throw new AudioServiceError(`${this.constructor.name} must implement _openSink()`);
  }

  /** @param {Buffer} _chunk @returns {boolean} accepted */
  _writeToSink(_chunk) {
    throw new AudioServiceError(`${this.constructor.name} must implement _writeToSink()`);
  }

  async _closeSink() {
    throw new AudioServiceError(`${this.constructor.name} must implement _closeSink()`);
  }

  /** @param {number} _percent */
  async _applyVolume(_percent) {
    throw new AudioServiceError(`${this.constructor.name} does not support volume control`);
  }

  /** @returns {Promise<number|null>} */
  async _readVolume() {
    return null;
  }

  _cancelIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/** @param {AudioFormat} a @param {AudioFormat} b */
function sameFormat(a, b) {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.bitDepth === b.bitDepth;
}

/**
 * Synthesise a signed 16-bit little-endian sine tone with short fades, so the
 * test tone does not start or end with an audible click.
 *
 * @param {AudioFormat & {durationMs: number, frequency: number}} spec
 * @returns {Buffer}
 */
export function generateTone({ sampleRate, channels, bitDepth, durationMs, frequency }) {
  if (bitDepth !== 16) {
    throw new AudioServiceError(`tone generation supports 16-bit PCM only, got ${bitDepth}`);
  }
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(frames * channels * 2);
  const fadeFrames = Math.min(Math.floor(sampleRate * 0.02), Math.floor(frames / 2));
  const amplitude = 0.28 * 0x7fff;

  for (let frame = 0; frame < frames; frame += 1) {
    let gain = 1;
    if (frame < fadeFrames) gain = frame / fadeFrames;
    else if (frame > frames - fadeFrames) gain = (frames - frame) / fadeFrames;

    const sample = Math.round(
      Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * amplitude * gain
    );
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }
  return buffer;
}
