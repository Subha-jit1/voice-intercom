/**
 * Test helper: start a real receiver process and wait until it is listening.
 *
 * The integration tests drive the actual entry point rather than importing
 * internals, so what they verify is what actually ships - including config
 * loading, signal handling and the WebSocket upgrade path.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Ask the OS for a free port rather than guessing one. */
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  await new Promise((r) => server.close(r));
  return port;
}

/**
 * @param {Record<string, string>} [env] Extra environment for the receiver.
 */
export async function startReceiver(env = {}) {
  const port = await freePort();
  const token = randomBytes(32).toString('hex');

  const child = spawn(process.execPath, ['receiver/src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      // A blank DOTENV path is not possible, so override every value the
      // developer's own .env might set.
      AUTH_TOKEN: token,
      PORT: String(port),
      HOST: '127.0.0.1',
      AUDIO_BACKEND: 'null',
      LOG_LEVEL: 'warn',
      LOG_FILE: '',
      TLS_CERT_PATH: '',
      TLS_KEY_PATH: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;

  // Poll rather than parse logs: the health endpoint answering is the only
  // definition of "ready" that matters.
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`receiver exited early (${child.exitCode}):\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`receiver did not start within 15s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    port,
    token,
    baseUrl,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    get output() { return output; },

    /** Authenticated fetch against this receiver. */
    async api(path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },

    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 4000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
