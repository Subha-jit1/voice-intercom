/**
 * Audio routes.
 *
 * Every handler talks to the AudioService interface only - which is why the
 * same routes work unchanged whether the sound is coming out of a phone, a
 * Raspberry Pi, or nowhere at all.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

/**
 * @param {object} deps
 * @param {import('../../audio/AudioService.js').AudioService} deps.audio
 * @param {import('../../auth/index.js').Authenticator} deps.authenticator
 * @param {import('../../logging/logger.js').Logger} deps.logger
 */
export function audioRoutes({ audio, authenticator, logger }) {
  const router = Router();
  const auth = requireAuth(authenticator);
  const log = logger.child('http:audio');

  router.get('/', auth, async (_req, res) => {
    res.json({ ...audio.describe(), currentVolume: await audio.getVolume() });
  });

  router.post('/test', auth, async (req, res) => {
    const frequency = clamp(req.body?.frequency, 100, 4000, 440);
    const durationMs = clamp(req.body?.durationMs, 100, 5000, 900);

    log.info('speaker test requested', { frequency, durationMs });
    try {
      res.json({ ok: true, ...(await audio.testSpeaker({ frequency, durationMs })) });
    } catch (err) {
      log.error('speaker test failed', { error: err });
      res.status(503).json({ ok: false, error: err.message, backend: audio.name });
    }
  });

  router.post('/volume', auth, async (req, res) => {
    const percent = Number(req.body?.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      res.status(400).json({ error: 'percent must be a number between 0 and 100' });
      return;
    }

    try {
      res.json({ ok: true, volume: await audio.setVolume(percent) });
    } catch (err) {
      // A backend without a mixer is a limitation, not a server fault.
      res.status(501).json({ ok: false, error: err.message, backend: audio.name });
    }
  });

  router.post('/stop', auth, async (_req, res) => {
    await audio.stop();
    res.json({ ok: true });
  });

  return router;
}

/** @returns {number} */
function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
