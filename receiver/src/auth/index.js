/**
 * Authentication.
 *
 * Phase 1 uses a single shared token. That is a deliberate choice rather than
 * a shortcut: the receiver is only ever reachable over Tailscale, which
 * already provides device identity, mutual authentication and encryption at
 * the network layer. The token defends against another device on the same
 * tailnet, which is exactly the threat that remains.
 *
 * Both the REST API and the WebSocket upgrade go through this one class, so
 * there is no second code path that could drift out of sync.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * Compare two strings without leaking length or content through timing.
 * @param {string} a
 * @param {string} b
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a leak,
  // so compare against a same-length buffer and fold the length into the result.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Pull a token out of a request, accepting every form a client can send.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the query string
 * and the subprotocol are supported too.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
export function extractToken(req) {
  const header = req.headers.authorization;
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    const entries = String(proto).split(',').map((s) => s.trim());
    const bearer = entries.find((e) => e.startsWith('bearer.'));
    if (bearer) return bearer.slice('bearer.'.length);
  }

  try {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
  } catch {
    /* malformed URL - treat as no token */
  }

  return null;
}

/**
 * Normalise an address for rate-limit bookkeeping, folding IPv4-mapped IPv6
 * addresses onto their IPv4 form so the two cannot be used to double the
 * allowance.
 * @param {string | undefined} address
 */
export function normaliseAddress(address) {
  if (!address) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

export class Authenticator {
  /**
   * @param {object} options
   * @param {import('../config/types.js').AuthConfig} options.config
   * @param {import('../logging/logger.js').Logger} options.logger
   */
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger.child('auth');
    /** @type {Map<string, {failures: number, lockedUntil: number}>} */
    this.attempts = new Map();
    this.stats = { granted: 0, denied: 0, lockouts: 0 };
  }

  /**
   * Validate a token and apply per-address throttling.
   *
   * @param {string | null} token
   * @param {string} address
   * @returns {{ok: true} | {ok: false, status: number, reason: string, retryAfterMs?: number}}
   */
  check(token, address) {
    const key = normaliseAddress(address);
    const record = this.attempts.get(key);
    const now = Date.now();

    if (record && record.lockedUntil > now) {
      return {
        ok: false,
        status: 429,
        reason: 'too many failed attempts',
        retryAfterMs: record.lockedUntil - now,
      };
    }

    if (!token) {
      this.#fail(key, 'missing token');
      return { ok: false, status: 401, reason: 'missing token' };
    }

    if (!safeEqual(token, this.config.token)) {
      this.#fail(key, 'invalid token');
      return { ok: false, status: 401, reason: 'invalid token' };
    }

    this.attempts.delete(key);
    this.stats.granted += 1;
    return { ok: true };
  }

  /** @param {string} key @param {string} why */
  #fail(key, why) {
    this.stats.denied += 1;
    const record = this.attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
    record.failures += 1;

    if (record.failures >= this.config.maxFailures) {
      record.lockedUntil = Date.now() + this.config.lockoutMs;
      record.failures = 0;
      this.stats.lockouts += 1;
      this.log.warn('address locked out after repeated auth failures', {
        address: key,
        lockoutMs: this.config.lockoutMs,
      });
    } else {
      this.log.warn('authentication failed', { address: key, why, failures: record.failures });
    }

    this.attempts.set(key, record);
  }

  /** Drop expired lockouts so the map cannot grow without bound. */
  sweep() {
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (record.lockedUntil !== 0 && record.lockedUntil < now && record.failures === 0) {
        this.attempts.delete(key);
      }
    }
  }

  describe() {
    return { ...this.stats, trackedAddresses: this.attempts.size };
  }
}
