/**
 * End-to-end receiver tests.
 *
 * Starts the real receiver process and drives it exactly as the controller
 * does - REST over HTTP, push-to-talk over a WebSocket. These are the tests
 * referred to in docs/TESTING.md: they must pass unchanged on Android
 * (Termux), Linux and Raspberry Pi OS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { startReceiver } from './helpers/receiver.js';

/**
 * Open an authenticated WebSocket and wait for the welcome message.
 * @param {{wsUrl: string, token: string}} receiver
 */
async function connect(receiver, token = receiver.token) {
  const socket = new WebSocket(receiver.wsUrl, ['voice-intercom.v1', `bearer.${token}`]);
  socket.binaryType = 'arraybuffer';

  /** @type {any[]} */
  const inbox = [];
  socket.on('message', (data, isBinary) => {
    if (!isBinary) inbox.push(JSON.parse(data.toString()));
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, res) =>
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }))
    );
  });

  /**
   * Wait for a message of a given type, failing fast rather than hanging.
   *
   * `where` narrows the match. State is broadcast on every connect, hello and
   * floor change, so a test that cares about one particular broadcast has to
   * say which - otherwise it races an earlier, unrelated one.
   *
   * @param {string} type
   * @param {{timeoutMs?: number, where?: (message: any) => boolean}} [options]
   */
  const waitFor = async (type, { timeoutMs = 4000, where = () => true } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex((m) => m.type === type && where(m));
      if (index !== -1) return inbox.splice(index, 1)[0];
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for "${type}"; saw: ${inbox.map((m) => m.type)}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const welcome = await waitFor('welcome');
  return {
    socket,
    welcome,
    waitFor,
    inbox,
    send: (payload) => socket.send(JSON.stringify(payload)),
    close: () => new Promise((r) => { socket.once('close', r); socket.close(); }),
  };
}

// --- REST -------------------------------------------------------------------

test('REST API', async (t) => {
  const receiver = await startReceiver();
  t.after(() => receiver.stop());

  await t.test('GET /api/health is public', async () => {
    const response = await fetch(`${receiver.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSeconds, 'number');
  });

  await t.test('GET /api/identity is public and leaks nothing sensitive', async () => {
    const response = await fetch(`${receiver.baseUrl}/api/identity`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.capabilities));
    assert.ok(!JSON.stringify(body).includes(receiver.token));
  });

  await t.test('protected endpoints refuse an anonymous request', async () => {
    for (const path of ['/api/diagnostics', '/api/logs', '/api/config', '/api/audio']) {
      const response = await fetch(`${receiver.baseUrl}${path}`);
      assert.equal(response.status, 401, `${path} should require auth`);
    }
  });

  await t.test('protected endpoints refuse a wrong token', async () => {
    const response = await fetch(`${receiver.baseUrl}/api/diagnostics`, {
      headers: { Authorization: 'Bearer not-the-token' },
    });
    assert.equal(response.status, 401);
  });

  await t.test('POST /api/auth/verify accepts the real token', async () => {
    const { status, body } = await receiver.api('/api/auth/verify', { method: 'POST' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  await t.test('GET /api/diagnostics reports platform and audio state', async () => {
    const { status, body } = await receiver.api('/api/diagnostics');
    assert.equal(status, 200);
    assert.equal(body.audio.backend, 'null');
    assert.equal(typeof body.platform.id, 'string');
    assert.equal(typeof body.resources.processRssMB, 'number');
    assert.ok(Array.isArray(body.network));
  });

  await t.test('GET /api/config never returns the token', async () => {
    const { status, body } = await receiver.api('/api/config');
    assert.equal(status, 200);
    assert.ok(!JSON.stringify(body).includes(receiver.token));
  });

  await t.test('GET /api/logs returns structured records', async () => {
    const { status, body } = await receiver.api('/api/logs?limit=10');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.records));
  });

  await t.test('POST /api/audio/test plays a tone', async () => {
    const { status, body } = await receiver.api('/api/audio/test', {
      method: 'POST',
      body: JSON.stringify({ frequency: 440, durationMs: 200 }),
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.bytes, 6400);
  });

  await t.test('POST /api/audio/volume validates its input', async () => {
    const bad = await receiver.api('/api/audio/volume', {
      method: 'POST',
      body: JSON.stringify({ percent: 500 }),
    });
    assert.equal(bad.status, 400);

    const good = await receiver.api('/api/audio/volume', {
      method: 'POST',
      body: JSON.stringify({ percent: 42 }),
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.volume, 42);
  });

  await t.test('unknown API endpoints return JSON 404, not the PWA', async () => {
    const response = await fetch(`${receiver.baseUrl}/api/nope`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /json/);
  });

  await t.test('serves the controller PWA', async () => {
    const page = await fetch(`${receiver.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Voice Intercom/);

    for (const asset of ['app.js', 'ptt-processor.js', 'manifest.webmanifest', 'sw.js']) {
      const response = await fetch(`${receiver.baseUrl}/${asset}`);
      assert.equal(response.status, 200, `${asset} should be served`);
    }
  });
});

// --- CORS -------------------------------------------------------------------

test('CORS', async (t) => {
  const receiver = await startReceiver();
  t.after(() => receiver.stop());

  // The desktop controller loads its UI from a local app:// scheme, so every
  // call it makes to a receiver is cross-origin. Without these headers the
  // desktop app cannot talk to any receiver at all.

  await t.test('answers preflight without requiring auth', async () => {
    // Browsers never attach Authorization to an OPTIONS request, so a
    // preflight that 401s would break every cross-origin call.
    const response = await fetch(`${receiver.baseUrl}/api/auth/verify`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'app://ui',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization',
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/i);
  });

  await t.test('sets the origin header on real API responses', async () => {
    const response = await fetch(`${receiver.baseUrl}/api/health`, {
      headers: { Origin: 'app://ui' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  });

  await t.test('exposes Retry-After so a controller can read its own backoff', async () => {
    const response = await fetch(`${receiver.baseUrl}/api/diagnostics`, {
      headers: { Origin: 'app://ui' },
    });
    assert.match(response.headers.get('access-control-expose-headers') ?? '', /Retry-After/i);
  });

  await t.test('still authenticates cross-origin requests', async () => {
    // CORS must widen who may *ask*, never who may *succeed*.
    const response = await fetch(`${receiver.baseUrl}/api/diagnostics`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 401);
  });

  await t.test('does not apply CORS to the static PWA', async () => {
    const response = await fetch(`${receiver.baseUrl}/`, { headers: { Origin: 'app://ui' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

// --- WebSocket / push-to-talk ------------------------------------------------

test('WebSocket authentication', async (t) => {
  const receiver = await startReceiver();
  t.after(() => receiver.stop());

  await t.test('rejects the upgrade without a token', async () => {
    const socket = new WebSocket(receiver.wsUrl, ['voice-intercom.v1']);
    const status = await new Promise((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      socket.on('error', () => resolve(0));
    });
    assert.equal(status, 401);
  });

  await t.test('rejects the upgrade with a wrong token', async () => {
    await assert.rejects(() => connect(receiver, 'wrong-token'), /401/);
  });

  await t.test('refuses to upgrade a path other than /ws', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${receiver.port}/nope`, [
      'voice-intercom.v1',
      `bearer.${receiver.token}`,
    ]);
    const status = await new Promise((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      socket.on('error', () => resolve(0));
    });
    assert.equal(status, 404);
  });
});

test('push-to-talk', async (t) => {
  const receiver = await startReceiver();
  t.after(() => receiver.stop());

  await t.test('welcomes a client with the receiver audio format', async () => {
    const client = await connect(receiver);
    assert.equal(client.welcome.format.sampleRate, 16000);
    assert.equal(client.welcome.format.channels, 1);
    assert.equal(client.welcome.format.bitDepth, 16);
    assert.equal(client.welcome.format.encoding, 'pcm_s16le');
    assert.equal(typeof client.welcome.clientId, 'string');
    await client.close();
  });

  await t.test('answers ping with pong', async () => {
    const client = await connect(receiver);
    client.send({ type: 'ping', t: 1234 });
    const pong = await client.waitFor('pong');
    assert.equal(pong.t, 1234);
    await client.close();
  });

  await t.test('grants the floor and relays audio', async () => {
    const client = await connect(receiver);
    client.send({ type: 'hello', name: 'test-controller' });
    client.send({ type: 'ptt.start', format: client.welcome.format });

    const granted = await client.waitFor('ptt.granted');
    assert.equal(granted.session, 1);

    // 10 chunks of 20 ms.
    for (let i = 0; i < 10; i += 1) client.socket.send(Buffer.alloc(640));

    client.send({ type: 'ptt.stop' });
    await client.waitFor('ptt.ended');

    const { body } = await receiver.api('/api/diagnostics');
    assert.equal(body.ptt.transmissions, 1);
    assert.equal(body.ptt.audioFramesRelayed, 10);
    assert.equal(body.ptt.audioBytesRelayed, 6400);
    assert.equal(body.audio.stats.framesDropped, 0);

    await client.close();
  });

  await t.test('allows only one talker at a time', async () => {
    const first = await connect(receiver);
    const second = await connect(receiver);

    first.send({ type: 'hello', name: 'first' });
    first.send({ type: 'ptt.start' });
    await first.waitFor('ptt.granted');

    second.send({ type: 'ptt.start' });
    const denied = await second.waitFor('ptt.denied');
    assert.equal(denied.reason, 'busy');
    assert.equal(denied.holder.name, 'first');

    // The floor must become available again once the holder releases it.
    first.send({ type: 'ptt.stop' });
    await first.waitFor('ptt.ended');

    second.send({ type: 'ptt.start' });
    await second.waitFor('ptt.granted');
    second.send({ type: 'ptt.stop' });
    await second.waitFor('ptt.ended');

    await first.close();
    await second.close();
  });

  await t.test('ignores audio from a client that does not hold the floor', async () => {
    const holder = await connect(receiver);
    const other = await connect(receiver);

    holder.send({ type: 'ptt.start' });
    await holder.waitFor('ptt.granted');

    const before = (await receiver.api('/api/diagnostics')).body.ptt.audioFramesRelayed;
    for (let i = 0; i < 5; i += 1) other.socket.send(Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 200));

    const after = (await receiver.api('/api/diagnostics')).body.ptt;
    assert.equal(after.audioFramesRelayed, before, 'no audio should have been relayed');
    assert.ok(after.framesFromNonSpeaker >= 5);

    holder.send({ type: 'ptt.stop' });
    await holder.waitFor('ptt.ended');
    await holder.close();
    await other.close();
  });

  await t.test('releases the floor when the talker disconnects', async () => {
    const abandoner = await connect(receiver);
    abandoner.send({ type: 'hello', name: 'abandoner' });
    abandoner.send({ type: 'ptt.start' });
    await abandoner.waitFor('ptt.granted');

    // Terminate without sending ptt.stop, as a crashed phone would.
    abandoner.socket.terminate();
    await new Promise((r) => setTimeout(r, 300));

    const { body } = await receiver.api('/api/diagnostics');
    assert.equal(body.ptt.speaker, null, 'the floor must not stay held');

    const next = await connect(receiver);
    next.send({ type: 'ptt.start' });
    await next.waitFor('ptt.granted');
    next.send({ type: 'ptt.stop' });
    await next.waitFor('ptt.ended');
    await next.close();
  });

  await t.test('broadcasts state so every controller sees the talker', async () => {
    const watcher = await connect(receiver);
    const talker = await connect(receiver);

    talker.send({ type: 'hello', name: 'talker' });
    talker.send({ type: 'ptt.start' });
    await talker.waitFor('ptt.granted');

    const state = await watcher.waitFor('state', { where: (m) => m.speaker !== null });
    assert.equal(state.speaker.name, 'talker');

    talker.send({ type: 'ptt.stop' });
    await talker.waitFor('ptt.ended');
    await talker.close();
    await watcher.close();
  });

  await t.test('reports an error for an unknown message type', async () => {
    const client = await connect(receiver);
    client.send({ type: 'launch-missiles' });
    const error = await client.waitFor('error');
    assert.match(error.message, /unknown message type/);
    await client.close();
  });

  await t.test('survives malformed JSON', async () => {
    const client = await connect(receiver);
    client.socket.send('{not json');
    const error = await client.waitFor('error');
    assert.match(error.message, /malformed JSON/);

    // The connection must still be usable.
    client.send({ type: 'ping', t: 7 });
    assert.equal((await client.waitFor('pong')).t, 7);
    await client.close();
  });
});
