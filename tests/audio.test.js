/**
 * AudioService contract tests.
 *
 * These are the tests that make the platform-independence claim checkable.
 * The suite is written against the AudioService interface, never against a
 * concrete backend, so the identical assertions run on Android, Debian and a
 * Raspberry Pi.
 *
 * By default it runs against the null backend, which works everywhere. To run
 * it against real hardware - which is the acceptance test when bringing up a
 * new platform - set the backend explicitly:
 *
 *   TEST_AUDIO_BACKEND=android node --test tests/     # on Termux
 *   TEST_AUDIO_BACKEND=alsa    node --test tests/     # on a Raspberry Pi
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioService } from '../receiver/src/audio/index.js';
import { generateTone } from '../receiver/src/audio/AudioService.js';

const silentLogger = {
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

const baseConfig = {
  backend: 'null',
  device: null,
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  idleTimeoutMs: 0,
  maxQueueFrames: 32,
};

/** Backends to run the contract against. */
const backends = ['null', ...(process.env.TEST_AUDIO_BACKEND ? [process.env.TEST_AUDIO_BACKEND] : [])];

for (const backend of backends) {
  test(`AudioService contract [${backend}]`, async (t) => {
    const config = { ...baseConfig, backend };
    const audio = await createAudioService({ config, logger: silentLogger });
    t.after(() => audio.shutdown());

    await t.test('reports its identity and default format', () => {
      assert.equal(typeof audio.name, 'string');
      assert.deepEqual(audio.defaultFormat, {
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
      });
    });

    await t.test('probe() answers whether it can work', async () => {
      const probe = await audio.probe();
      assert.equal(typeof probe.available, 'boolean');
      assert.equal(typeof probe.detail, 'string');
    });

    await t.test('streams PCM and accounts for every byte', async () => {
      const before = { ...audio.stats };
      const chunk = Buffer.alloc(640); // 20 ms at 16 kHz mono 16-bit

      await audio.beginStream();
      assert.equal(audio.streaming, true);

      for (let i = 0; i < 10; i += 1) audio.write(chunk);
      await audio.endStream();

      assert.equal(audio.stats.framesReceived - before.framesReceived, 10);
      assert.equal(audio.stats.bytesReceived - before.bytesReceived, 6400);
    });

    await t.test('rejects writes outside a stream', () => {
      assert.throws(() => audio.write(Buffer.alloc(64)), /beginStream/);
    });

    await t.test('play() handles a complete buffer', async () => {
      await audio.play(Buffer.alloc(3200));
      assert.equal(audio.streaming, false, 'play() must release the stream it opened');
    });

    await t.test('testSpeaker() produces correctly sized audio', async () => {
      const result = await audio.testSpeaker({ durationMs: 200, frequency: 440 });
      assert.equal(result.backend, audio.name);
      // 200 ms * 16000 Hz * 1 channel * 2 bytes
      assert.equal(result.bytes, 6400);
    });

    await t.test('stop() is safe to call at any time', async () => {
      await audio.stop();
      await audio.stop();
      assert.equal(audio.streaming, false);
    });

    await t.test('setVolume() clamps to 0-100', async () => {
      // Backends without a mixer legitimately refuse; that is not a failure.
      try {
        assert.equal(await audio.setVolume(150), 100);
        assert.equal(await audio.setVolume(-20), 0);
        assert.equal(await audio.setVolume(55), 55);
      } catch (err) {
        assert.match(err.message, /volume|mixer|pactl|amixer/i);
      }
    });

    await t.test('describe() exposes diagnostics', () => {
      const described = audio.describe();
      assert.equal(described.backend, audio.name);
      assert.equal(typeof described.stats.framesReceived, 'number');
      assert.equal(typeof described.volume, 'number');
    });
  });
}

test('generateTone produces valid PCM', async (t) => {
  await t.test('sizes the buffer from the format', () => {
    const tone = generateTone({
      sampleRate: 16000, channels: 1, bitDepth: 16, durationMs: 1000, frequency: 440,
    });
    assert.equal(tone.length, 32000);
  });

  await t.test('scales with channel count', () => {
    const tone = generateTone({
      sampleRate: 8000, channels: 2, bitDepth: 16, durationMs: 500, frequency: 440,
    });
    assert.equal(tone.length, 8000 * 0.5 * 2 * 2);
  });

  await t.test('fades in, so playback does not start with a click', () => {
    const tone = generateTone({
      sampleRate: 16000, channels: 1, bitDepth: 16, durationMs: 500, frequency: 440,
    });
    assert.equal(tone.readInt16LE(0), 0);

    // Mid-tone must be well away from silence.
    let peak = 0;
    for (let i = 4000; i < 5000; i += 2) peak = Math.max(peak, Math.abs(tone.readInt16LE(i)));
    assert.ok(peak > 1000, `expected audible signal mid-tone, peak was ${peak}`);
  });

  await t.test('refuses formats it cannot synthesise', () => {
    assert.throws(
      () => generateTone({
        sampleRate: 16000, channels: 1, bitDepth: 24, durationMs: 100, frequency: 440,
      }),
      /16-bit/
    );
  });
});
