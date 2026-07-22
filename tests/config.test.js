/**
 * Configuration validation tests.
 *
 * Bad configuration should fail loudly at startup, not silently at 3am when
 * someone presses the talk button.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, redactConfig, ConfigError } from '../receiver/src/config/index.js';

const validEnv = { AUTH_TOKEN: 'a'.repeat(32) };

test('loadConfig', async (t) => {
  await t.test('applies documented defaults', () => {
    const config = loadConfig({ ...validEnv });
    assert.equal(config.http.port, 8080);
    assert.equal(config.http.host, '0.0.0.0');
    assert.equal(config.http.tls, null);
    assert.equal(config.audio.backend, 'auto');
    assert.equal(config.audio.sampleRate, 16000);
    assert.equal(config.audio.channels, 1);
    assert.equal(config.audio.bitDepth, 16);
    assert.equal(config.logging.level, 'info');
  });

  await t.test('requires AUTH_TOKEN', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    assert.throws(() => loadConfig({}), /AUTH_TOKEN is required/);
  });

  await t.test('rejects a short AUTH_TOKEN', () => {
    assert.throws(() => loadConfig({ AUTH_TOKEN: 'short' }), /at least 16 characters/);
  });

  await t.test('rejects a non-numeric PORT', () => {
    assert.throws(() => loadConfig({ ...validEnv, PORT: 'eight-thousand' }), /must be an integer/);
  });

  await t.test('rejects an out-of-range PORT', () => {
    assert.throws(() => loadConfig({ ...validEnv, PORT: '99999' }), /between 1 and 65535/);
  });

  await t.test('rejects an unknown audio backend', () => {
    assert.throws(
      () => loadConfig({ ...validEnv, AUDIO_BACKEND: 'coreaudio' }),
      /AUDIO_BACKEND must be one of/
    );
  });

  await t.test('accepts every documented audio backend', () => {
    for (const backend of ['auto', 'android', 'alsa', 'linux', 'null']) {
      assert.equal(loadConfig({ ...validEnv, AUDIO_BACKEND: backend }).audio.backend, backend);
    }
  });

  await t.test('rejects a half-configured TLS pair', () => {
    assert.throws(
      () => loadConfig({ ...validEnv, TLS_CERT_PATH: '/tmp/cert.pem' }),
      /must both be set/
    );
    assert.throws(
      () => loadConfig({ ...validEnv, TLS_KEY_PATH: '/tmp/key.pem' }),
      /must both be set/
    );
  });

  await t.test('rejects TLS paths that do not exist', () => {
    assert.throws(
      () => loadConfig({
        ...validEnv,
        TLS_CERT_PATH: '/definitely/missing/cert.pem',
        TLS_KEY_PATH: '/definitely/missing/key.pem',
      }),
      /missing file/
    );
  });

  await t.test('rejects an unknown log level', () => {
    assert.throws(() => loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be one of/);
  });

  await t.test('produces a frozen config', () => {
    const config = loadConfig({ ...validEnv });
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.audio));
  });
});

test('redactConfig never leaks the token', () => {
  const token = 'b'.repeat(40);
  const redacted = redactConfig(loadConfig({ AUTH_TOKEN: token }));
  assert.ok(!JSON.stringify(redacted).includes(token));
  assert.match(redacted.auth.token, /^set \(40 chars\)$/);
});
