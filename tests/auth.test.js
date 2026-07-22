/**
 * Authentication tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Authenticator, extractToken, normaliseAddress } from '../receiver/src/auth/index.js';

const silentLogger = {
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

const config = { token: 'correct-horse-battery-staple', maxFailures: 3, lockoutMs: 50 };

const makeAuth = (overrides = {}) =>
  new Authenticator({ config: { ...config, ...overrides }, logger: silentLogger });

test('extractToken', async (t) => {
  await t.test('reads an Authorization bearer header', () => {
    assert.equal(extractToken({ headers: { authorization: 'Bearer abc123' }, url: '/' }), 'abc123');
  });

  await t.test('is case-insensitive about the scheme', () => {
    assert.equal(extractToken({ headers: { authorization: 'bearer abc123' }, url: '/' }), 'abc123');
  });

  await t.test('reads the WebSocket subprotocol, which browsers can set', () => {
    const req = {
      headers: { 'sec-websocket-protocol': 'voice-intercom.v1, bearer.xyz789' },
      url: '/ws',
    };
    assert.equal(extractToken(req), 'xyz789');
  });

  await t.test('reads a query parameter as a last resort', () => {
    assert.equal(extractToken({ headers: {}, url: '/ws?token=qs-token' }), 'qs-token');
  });

  await t.test('returns null when there is no token', () => {
    assert.equal(extractToken({ headers: {}, url: '/ws' }), null);
  });

  await t.test('survives a malformed URL', () => {
    assert.equal(extractToken({ headers: {}, url: '://%%%' }), null);
  });
});

test('normaliseAddress folds IPv4-mapped IPv6 onto IPv4', () => {
  assert.equal(normaliseAddress('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(normaliseAddress('10.0.0.1'), '10.0.0.1');
  assert.equal(normaliseAddress(undefined), 'unknown');
});

test('Authenticator', async (t) => {
  await t.test('accepts the configured token', () => {
    assert.deepEqual(makeAuth().check(config.token, '1.2.3.4'), { ok: true });
  });

  await t.test('rejects a wrong token', () => {
    const result = makeAuth().check('wrong', '1.2.3.4');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  await t.test('rejects a missing token', () => {
    const result = makeAuth().check(null, '1.2.3.4');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.reason, 'missing token');
  });

  await t.test('rejects a token that is a prefix of the real one', () => {
    assert.equal(makeAuth().check(config.token.slice(0, -1), '1.2.3.4').ok, false);
  });

  await t.test('locks out an address after repeated failures', () => {
    const auth = makeAuth();
    for (let i = 0; i < 3; i += 1) auth.check('wrong', '9.9.9.9');

    const result = auth.check(config.token, '9.9.9.9');
    assert.equal(result.ok, false);
    assert.equal(result.status, 429, 'even the correct token is refused while locked out');
    assert.ok(result.retryAfterMs > 0);
  });

  await t.test('locks out only the offending address', () => {
    const auth = makeAuth();
    for (let i = 0; i < 3; i += 1) auth.check('wrong', '9.9.9.9');
    assert.deepEqual(auth.check(config.token, '8.8.8.8'), { ok: true });
  });

  await t.test('releases the lockout once it expires', async () => {
    const auth = makeAuth({ lockoutMs: 40 });
    for (let i = 0; i < 3; i += 1) auth.check('wrong', '7.7.7.7');
    assert.equal(auth.check(config.token, '7.7.7.7').status, 429);

    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(auth.check(config.token, '7.7.7.7'), { ok: true });
  });

  await t.test('a success clears the failure count', () => {
    const auth = makeAuth();
    auth.check('wrong', '5.5.5.5');
    auth.check('wrong', '5.5.5.5');
    auth.check(config.token, '5.5.5.5');
    // Two more failures must not trip the limit, because the counter reset.
    auth.check('wrong', '5.5.5.5');
    auth.check('wrong', '5.5.5.5');
    assert.deepEqual(auth.check(config.token, '5.5.5.5'), { ok: true });
  });

  await t.test('treats IPv4-mapped and plain IPv4 as one address', () => {
    const auth = makeAuth();
    for (let i = 0; i < 3; i += 1) auth.check('wrong', '::ffff:4.4.4.4');
    assert.equal(auth.check(config.token, '4.4.4.4').status, 429);
  });

  await t.test('reports counters for diagnostics', () => {
    const auth = makeAuth();
    auth.check(config.token, '1.1.1.1');
    auth.check('wrong', '2.2.2.2');
    const stats = auth.describe();
    assert.equal(stats.granted, 1);
    assert.equal(stats.denied, 1);
  });
});
