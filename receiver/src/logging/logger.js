/**
 * Structured logger with an in-memory ring buffer.
 *
 * Two consumers:
 *   - stdout, as JSON lines, so systemd/journald and Termux both capture it
 *     with no extra configuration;
 *   - GET /api/logs, which reads the ring buffer so the controller can tail
 *     a headless receiver without SSH.
 *
 * Deliberately dependency-free: one fewer thing to install on a Pi Zero.
 */

import { appendFile } from 'node:fs/promises';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

/** Circular buffer of the most recent records. */
class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    this.capacity = capacity;
    /** @type {any[]} */
    this.items = [];
    this.nextId = 1;
  }

  push(record) {
    record.id = this.nextId++;
    this.items.push(record);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
    return record;
  }

  /**
   * @param {{limit?: number, level?: string, since?: number}} [options]
   */
  read({ limit = 100, level, since } = {}) {
    const threshold = level ? LEVELS[level] ?? 0 : 0;
    let out = this.items;
    if (threshold) out = out.filter((r) => LEVELS[r.level] >= threshold);
    if (since) out = out.filter((r) => r.id > since);
    return out.slice(-limit);
  }

  clear() {
    this.items = [];
  }
}

export class Logger {
  /**
   * @param {object} options
   * @param {import('../config/types.js').LoggingConfig} options.config
   * @param {string} [options.scope]
   * @param {RingBuffer} [options.buffer]
   */
  constructor({ config, scope = 'app', buffer }) {
    this.config = config;
    this.scope = scope;
    this.threshold = LEVELS[config.level] ?? LEVELS.info;
    this.buffer = buffer ?? new RingBuffer(config.bufferSize);
    /** Set true when file logging has already failed, to avoid error storms. */
    this.fileWriteBroken = false;
  }

  /**
   * Derive a logger that tags every record with a sub-scope but shares the
   * same ring buffer, so /api/logs sees the whole application.
   * @param {string} scope
   */
  child(scope) {
    return new Logger({
      config: this.config,
      scope: `${this.scope}:${scope}`,
      buffer: this.buffer,
    });
  }

  /**
   * @param {keyof typeof LEVELS} level
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  log(level, message, fields) {
    if (LEVELS[level] < this.threshold) return;

    const record = this.buffer.push({
      time: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(fields && Object.keys(fields).length ? { fields: serialisable(fields) } : {}),
    });

    const line = JSON.stringify(record);
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);

    if (this.config.file && !this.fileWriteBroken) {
      appendFile(this.config.file, `${line}\n`).catch((err) => {
        this.fileWriteBroken = true;
        process.stderr.write(
          `{"level":"error","scope":"logger","message":"log file write failed, continuing to stdout only","fields":{"error":"${err.message}"}}\n`
        );
      });
    }
  }

  trace(message, fields) { this.log('trace', message, fields); }
  debug(message, fields) { this.log('debug', message, fields); }
  info(message, fields) { this.log('info', message, fields); }
  warn(message, fields) { this.log('warn', message, fields); }
  error(message, fields) { this.log('error', message, fields); }

  /** Records available to GET /api/logs. */
  read(options) {
    return this.buffer.read(options);
  }

  clear() {
    this.buffer.clear();
  }
}

/** Make Errors and other exotic values survive JSON.stringify. */
function serialisable(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack };
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {import('../config/types.js').LoggingConfig} config
 * @returns {Logger}
 */
export function createLogger(config) {
  return new Logger({ config, scope: 'receiver' });
}
