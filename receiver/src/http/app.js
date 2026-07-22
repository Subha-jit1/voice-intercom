/**
 * Express application.
 *
 * Serves both the REST API and the controller PWA. Bundling them means one
 * Tailscale address, one TLS certificate and one `npm install` - and, more
 * importantly, the PWA is same-origin with its API, so there is no CORS
 * configuration to get wrong on a phone.
 */

import express from 'express';
import { CONTROLLER_DIR } from '../config/index.js';
import { systemRoutes } from './routes/system.js';
import { audioRoutes } from './routes/audio.js';
import { cors } from './middleware/cors.js';

/**
 * @param {object} deps
 * @param {import('../config/types.js').Config} deps.config
 * @param {import('../audio/AudioService.js').AudioService} deps.audio
 * @param {import('../auth/index.js').Authenticator} deps.authenticator
 * @param {import('../diagnostics/index.js').Diagnostics} deps.diagnostics
 * @param {import('../logging/logger.js').Logger} deps.logger
 */
export function createApp(deps) {
  const { logger } = deps;
  const log = logger.child('http');
  const app = express();

  app.disable('x-powered-by');

  // Only loopback proxies are trusted, which covers `tailscale serve` sitting
  // in front of us. Trusting anything further would let a client spoof its own
  // address and slip the auth rate limiter.
  app.set('trust proxy', 'loopback');

  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  // Request logging at debug level - the health endpoint is polled often
  // enough that logging it at info would drown everything else.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log.debug('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      });
    });
    next();
  });

  // Only the API is cross-origin reachable; the static PWA is same-origin by
  // definition and gains nothing from CORS headers.
  app.use('/api', cors());

  app.use('/api', systemRoutes(deps));
  app.use('/api/audio', audioRoutes(deps));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'unknown endpoint' });
  });

  // The controller PWA. The service worker must never be cached or a stale
  // one will keep serving an old app forever.
  app.use(
    express.static(CONTROLLER_DIR, {
      index: 'index.html',
      etag: true,
      setHeaders: (res, path) => {
        if (path.endsWith('sw.js') || path.endsWith('index.html')) {
          res.set('Cache-Control', 'no-cache');
        }
      },
    })
  );

  // eslint-disable-next-line no-unused-vars -- Express identifies error
  // handlers by arity; the `next` parameter must stay.
  app.use((err, req, res, next) => {
    log.error('unhandled request error', { method: req.method, path: req.path, error: err });
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
