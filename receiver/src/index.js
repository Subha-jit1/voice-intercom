/**
 * Receiver entry point.
 *
 * Composition root: this is the only file that wires concrete implementations
 * together. Everything below it receives its dependencies as arguments, which
 * is what makes the platform swap a configuration concern rather than a code
 * change.
 *
 *   node receiver/src/index.js
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { loadConfig, ConfigError } from './config/index.js';
import { createLogger } from './logging/logger.js';
import { detectPlatform } from './platform/detect.js';
import { createAudioService } from './audio/index.js';
import { Authenticator } from './auth/index.js';
import { Diagnostics } from './diagnostics/index.js';
import { createApp } from './http/app.js';
import { PttServer } from './ws/PttServer.js';

async function main() {
  // --- Configuration ------------------------------------------------------
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\nConfiguration error: ${err.message}\n\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const logger = createLogger(config.logging);
  const platform = detectPlatform();

  logger.info('starting voice-intercom receiver', {
    name: config.receiverName,
    version: config.version,
    platform: platform.label,
    node: process.version,
  });

  // --- Services -----------------------------------------------------------
  const audio = await createAudioService({ config: config.audio, logger });
  const authenticator = new Authenticator({ config: config.auth, logger });
  const diagnostics = new Diagnostics({ config, audio, authenticator, logger });

  const app = createApp({ config, audio, authenticator, diagnostics, logger });

  const server = config.http.tls
    ? createHttpsServer(
        {
          cert: readFileSync(config.http.tls.certPath),
          key: readFileSync(config.http.tls.keyPath),
        },
        app
      )
    : createHttpServer(app);

  const ptt = new PttServer({ config, audio, authenticator, logger });
  diagnostics.attachPttServer(ptt);

  // Only /ws is a WebSocket endpoint; anything else asking to upgrade is a
  // misconfigured client and gets a clean refusal.
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://placeholder');
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    ptt.handleUpgrade(req, socket, head);
  });

  // --- Listen -------------------------------------------------------------
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => {
      server.removeListener('error', reject);
      resolve(undefined);
    });
  });

  const scheme = config.http.tls ? 'https' : 'http';
  logger.info('receiver listening', {
    url: `${scheme}://${config.http.host}:${config.http.port}`,
    hostname: os.hostname(),
    websocket: `${config.http.tls ? 'wss' : 'ws'}://…:${config.http.port}/ws`,
  });

  if (!config.http.tls) {
    // Worth shouting about: everything will look fine until the first attempt
    // to transmit, which will fail inside the browser rather than here.
    logger.warn(
      'running without TLS - browsers block microphone access on remote http:// origins, ' +
        'so the Android/browser controller will not be able to transmit. Either use the ' +
        'desktop controller, which needs no certificate, or run ' +
        '`tailscale serve --bg --https=443 http://127.0.0.1:8080`. See docs/SETUP.md part 3.'
    );
  }

  // --- Shutdown -----------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    const forceExit = setTimeout(() => {
      logger.warn('shutdown timed out, forcing exit');
      process.exit(1);
    }, 5000);
    forceExit.unref();

    try {
      await ptt.close();
      await audio.shutdown();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('error during shutdown', { error: err });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { error: err });
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  process.stderr.write(`Fatal startup error: ${err?.stack ?? err}\n`);
  process.exit(1);
});
