/**
 * Configuration loading and validation.
 *
 * Everything the receiver can be told is funnelled through here so that the
 * rest of the code never touches process.env directly. That keeps the app
 * testable and makes the "same code, different deployment" promise real:
 * moving from Termux to a Raspberry Pi changes .env, never source.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/** Repository root, derived from this file's location (works from any cwd). */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONTROLLER_DIR = resolve(ROOT_DIR, 'controller');

/** Package version, read once at startup. */
function readVersion() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

class ConfigError extends Error {}

function requireString(env, key, { allowEmpty = false } = {}) {
  const raw = (env[key] ?? '').trim();
  if (!raw && !allowEmpty) {
    throw new ConfigError(
      `${key} is required but not set. Copy .env.example to .env and fill it in.`
    );
  }
  return raw;
}

function readInt(env, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = (env[key] ?? '').trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new ConfigError(`${key} must be an integer, got "${raw}".`);
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

function readEnum(env, key, allowed, fallback) {
  const raw = (env[key] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (!allowed.includes(raw)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(' | ')}, got "${raw}".`);
  }
  return raw;
}

/**
 * Load and validate configuration.
 *
 * @param {NodeJS.ProcessEnv} [env] Defaults to process.env after .env is merged.
 * @returns {import('./types.js').Config}
 */
export function loadConfig(env) {
  if (!env) {
    dotenv.config({ path: resolve(ROOT_DIR, '.env'), quiet: true });
    env = process.env;
  }

  const tlsCert = (env.TLS_CERT_PATH ?? '').trim();
  const tlsKey = (env.TLS_KEY_PATH ?? '').trim();
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must both be set, or both be empty.');
  }
  for (const [key, path] of [['TLS_CERT_PATH', tlsCert], ['TLS_KEY_PATH', tlsKey]]) {
    if (path && !existsSync(path)) throw new ConfigError(`${key} points at a missing file: ${path}`);
  }

  const authToken = requireString(env, 'AUTH_TOKEN');
  if (authToken.length < 16) {
    throw new ConfigError(
      'AUTH_TOKEN must be at least 16 characters. Generate one with:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  return Object.freeze({
    version: readVersion(),
    receiverName: (env.RECEIVER_NAME ?? '').trim() || 'voice-intercom',

    http: Object.freeze({
      host: (env.HOST ?? '').trim() || '0.0.0.0',
      port: readInt(env, 'PORT', 8080, { min: 1, max: 65535 }),
      tls: tlsCert ? Object.freeze({ certPath: tlsCert, keyPath: tlsKey }) : null,
    }),

    auth: Object.freeze({
      token: authToken,
      /** Consecutive failures from one address before it is temporarily blocked. */
      maxFailures: readInt(env, 'AUTH_MAX_FAILURES', 10, { min: 1, max: 1000 }),
      lockoutMs: readInt(env, 'AUTH_LOCKOUT_MS', 60_000, { min: 1000 }),
    }),

    audio: Object.freeze({
      backend: readEnum(env, 'AUDIO_BACKEND', ['auto', 'android', 'alsa', 'linux', 'null'], 'auto'),
      device: (env.AUDIO_DEVICE ?? '').trim() || null,
      sampleRate: readInt(env, 'AUDIO_SAMPLE_RATE', 16000, { min: 8000, max: 48000 }),
      channels: readInt(env, 'AUDIO_CHANNELS', 1, { min: 1, max: 2 }),
      /** Phase 1 is fixed at signed 16-bit little endian; see docs/ARCHITECTURE.md. */
      bitDepth: 16,
      idleTimeoutMs: readInt(env, 'AUDIO_IDLE_TIMEOUT_MS', 1500),
      maxQueueFrames: readInt(env, 'AUDIO_MAX_QUEUE_FRAMES', 32, { min: 1, max: 1000 }),
    }),

    logging: Object.freeze({
      level: readEnum(env, 'LOG_LEVEL', ['trace', 'debug', 'info', 'warn', 'error'], 'info'),
      bufferSize: readInt(env, 'LOG_BUFFER_SIZE', 500, { min: 10, max: 100_000 }),
      file: (env.LOG_FILE ?? '').trim() || null,
    }),
  });
}

/**
 * Config with every secret removed, safe to serve over the API or log.
 * @param {import('./types.js').Config} config
 */
export function redactConfig(config) {
  return {
    ...config,
    auth: {
      ...config.auth,
      token: `set (${config.auth.token.length} chars)`,
    },
  };
}

export { ConfigError };
