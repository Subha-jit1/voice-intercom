/**
 * ProcessAudioService - shared implementation for every backend that plays
 * audio by piping raw PCM into a child process' stdin.
 *
 * That covers all three real targets:
 *   Android/Termux -> paplay      (PulseAudio with the Android SLES sink)
 *   Raspberry Pi   -> aplay       (ALSA)
 *   Linux desktop  -> paplay      (PulseAudio / PipeWire)
 *
 * All the fiddly parts - spawning, backpressure, EPIPE, unexpected exits,
 * draining on close - live here exactly once. A concrete backend only has to
 * say which command to run and how to set the volume.
 */

import { spawn } from 'node:child_process';
import { AudioService, AudioServiceError } from './AudioService.js';

export class ProcessAudioService extends AudioService {
  constructor(options) {
    super(options);

    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.child = null;
    /** Bytes allowed to sit in the child's stdin buffer before we drop audio. */
    this.maxBufferedBytes = 0;
    /** Set while the sink is being closed, so exit handlers stay quiet. */
    this.closing = false;
  }

  /**
   * Describe the playback command for a given format.
   * @param {import('../config/types.js').AudioFormat} _format
   * @returns {{command: string, args: string[], env?: Record<string,string>}}
   * @abstract
   */
  _playbackCommand(_format) {
    throw new AudioServiceError(`${this.constructor.name} must implement _playbackCommand()`);
  }

  /** @param {import('../config/types.js').AudioFormat} format */
  async _openSink(format) {
    const { command, args, env } = this._playbackCommand(format);

    // ~20 ms of audio is one network chunk; budget the queue in those units so
    // AUDIO_MAX_QUEUE_FRAMES means the same thing at any sample rate.
    const bytesPerChunk = Math.max(
      1,
      Math.floor((format.sampleRate * format.channels * (format.bitDepth / 8)) / 50)
    );
    this.maxBufferedBytes = bytesPerChunk * this.config.maxQueueFrames;

    this.log.debug('spawning audio sink', { command, args });

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
      });
    } catch (err) {
      throw new AudioServiceError(
        `failed to start audio sink "${command}": ${err.message}. ` +
          `Install it, or set AUDIO_BACKEND=null to run without sound.`
      );
    }

    this.closing = false;
    this.child = child;

    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) this.log.debug('audio sink stderr', { backend: this.name, text });
    });

    // EPIPE is expected when the sink is killed mid-write; never let it crash
    // the process.
    child.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') {
        this.log.debug('audio sink stdin closed early', { backend: this.name });
        return;
      }
      this.log.warn('audio sink stdin error', { backend: this.name, error: err });
    });

    child.on('error', (err) => {
      this.log.error('audio sink process error', { backend: this.name, error: err });
      if (this.child === child) {
        this.child = null;
        this.streaming = false;
      }
    });

    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.closing) return;

      // The sink died while we still expected it to play. Mark the stream
      // closed so the next write re-opens it, and record it for diagnostics.
      this.streaming = false;
      this.stats.sinkRestarts += 1;
      this.log.warn('audio sink exited unexpectedly', {
        backend: this.name,
        code,
        signal,
        command,
      });
    });

    // Give a failing command a moment to exit so beginStream() reports the
    // problem instead of silently succeeding and dropping every frame.
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (!this.child) {
      throw new AudioServiceError(
        `audio sink "${command}" exited immediately. Check that it is installed and ` +
          `that a sound device is available (see GET /api/diagnostics).`
      );
    }
  }

  /**
   * @param {Buffer} chunk
   * @returns {boolean} false when dropped
   */
  _writeToSink(chunk) {
    const child = this.child;
    if (!child || !child.stdin.writable) return false;

    // Realtime audio: if the device has fallen behind, drop the chunk rather
    // than queue it. Queued audio only turns a glitch into growing latency.
    if (child.stdin.writableLength > this.maxBufferedBytes) return false;

    child.stdin.write(chunk);
    return true;
  }

  async _closeSink() {
    const child = this.child;
    if (!child) return;

    this.closing = true;
    this.child = null;

    await new Promise((resolve) => {
      // Force-kill if the sink will not exit after its stdin closes.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
      }, 1500);
      timer.unref?.();

      child.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });

      if (child.stdin.writable) child.stdin.end();
      else child.kill('SIGTERM');
    });
  }
}
