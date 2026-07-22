/**
 * Express middleware wrapping the shared Authenticator.
 */

import { extractToken } from '../../auth/index.js';

/**
 * @param {import('../../auth/index.js').Authenticator} authenticator
 */
export function requireAuth(authenticator) {
  return function authMiddleware(req, res, next) {
    const result = authenticator.check(extractToken(req), req.ip);

    if (result.ok) {
      next();
      return;
    }

    if (result.retryAfterMs) {
      res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    }
    res.status(result.status).json({ error: result.reason });
  };
}
