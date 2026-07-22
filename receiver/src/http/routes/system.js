/**
 * System routes: health, identity, info, diagnostics, config, logs.
 */

import { Router } from 'express';
import { redactConfig } from '../../config/index.js';
import { requireAuth } from '../middleware/auth.js';

/**
 * @param {object} deps
 * @param {import('../../config/types.js').Config} deps.config
 * @param {import('../../diagnostics/index.js').Diagnostics} deps.diagnostics
 * @param {import('../../auth/index.js').Authenticator} deps.authenticator
 * @param {import('../../logging/logger.js').Logger} deps.logger
 */
export function systemRoutes({ config, diagnostics, authenticator, logger }) {
  const router = Router();
  const auth = requireAuth(authenticator);

  // --- Public ---------------------------------------------------------------

  // Deliberately unauthenticated so systemd, uptime monitors and container
  // health checks work without holding the shared secret.
  router.get('/health', (_req, res) => {
    res.json(diagnostics.health());
  });

  // Discovery. Reveals only what a controller needs to recognise a receiver it
  // has found on the tailnet - no secrets, no system detail.
  router.get('/identity', (_req, res) => {
    res.json(diagnostics.identity());
  });

  // Lets the controller validate a token before storing it, so a typo surfaces
  // on the settings screen rather than as a mysterious dead PTT button.
  router.post('/auth/verify', auth, (_req, res) => {
    res.json({ ok: true, receiver: diagnostics.identity() });
  });

  // --- Authenticated --------------------------------------------------------

  router.get('/diagnostics', auth, async (_req, res) => {
    res.json(await diagnostics.full());
  });

  router.get('/config', auth, (_req, res) => {
    res.json(redactConfig(config));
  });

  router.get('/logs', auth, (req, res) => {
    const limit = Math.min(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1000);
    const level = typeof req.query.level === 'string' ? req.query.level : undefined;
    const since = Number.parseInt(String(req.query.since ?? ''), 10) || undefined;

    res.json({ records: logger.read({ limit, level, since }) });
  });

  return router;
}
