/**
 * Platform detection tests.
 *
 * These exist because of a real bug: Node builds shipped by Termux report
 * `process.platform === 'android'`, not 'linux'. Detection only tested for
 * 'linux', so every phone fell through to 'unknown', selected the null audio
 * backend, and played nothing — while reporting itself as healthy.
 *
 * Detection is the hinge the whole platform abstraction turns on, so it is
 * tested against every value process.platform can realistically take, on any
 * machine, without needing that hardware.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectPlatform, resetPlatformCache } from '../receiver/src/platform/detect.js';

/** Detect with an explicit platform/env, bypassing the cache. */
const detect = (platform, env = {}) => detectPlatform({ platform, arch: 'arm64', env });

test('platform detection', async (t) => {
  await t.test('recognises Android when Node reports platform "android"', () => {
    // The regression case. Termux's current Node build reports 'android'.
    const info = detect('android', {});
    assert.equal(info.id, 'android');
    assert.equal(info.isTermux, true);
    assert.equal(info.isRaspberryPi, false);
    assert.match(info.label, /Termux/);
  });

  await t.test('recognises Termux on older Node builds that report "linux"', () => {
    // Older Termux Node builds report 'linux', so the env markers still matter.
    assert.equal(detect('linux', { TERMUX_VERSION: '0.118.0' }).id, 'android');
    assert.equal(detect('linux', { PREFIX: '/data/data/com.termux/files/usr' }).id, 'android');
  });

  await t.test('does not mistake ordinary Linux for Android', () => {
    const info = detect('linux', { PREFIX: '/usr' });
    // A real Raspberry Pi running these tests legitimately reports raspberrypi;
    // both answers prove the point, which is that it is not android.
    assert.ok(['linux', 'raspberrypi'].includes(info.id), `unexpected id ${info.id}`);
    assert.equal(info.isTermux, false);
  });

  await t.test('maps desktop platforms', () => {
    assert.equal(detect('win32').id, 'windows');
    assert.equal(detect('darwin').id, 'macos');
  });

  await t.test('falls back to unknown, keeping the real platform name visible', () => {
    const info = detect('freebsd');
    assert.equal(info.id, 'unknown');
    // The label must name the actual platform, or a bug report says nothing.
    assert.match(info.label, /freebsd/);
    assert.equal(info.os, 'freebsd');
  });

  await t.test('always reports the fields callers depend on', () => {
    for (const platform of ['android', 'linux', 'win32', 'darwin', 'freebsd']) {
      const info = detect(platform);
      assert.equal(typeof info.id, 'string');
      assert.equal(typeof info.label, 'string');
      assert.equal(info.os, platform);
      assert.equal(info.arch, 'arm64');
      assert.equal(typeof info.isTermux, 'boolean');
      assert.equal(typeof info.isRaspberryPi, 'boolean');
    }
  });

  await t.test('overrides never poison the cached real detection', () => {
    resetPlatformCache();
    const real = detectPlatform();
    detect('freebsd');
    detect('android');
    assert.deepEqual(detectPlatform(), real, 'cache was corrupted by a test override');
  });

  await t.test('caches the real result', () => {
    resetPlatformCache();
    assert.equal(detectPlatform(), detectPlatform(), 'expected the same cached object');
  });
});
