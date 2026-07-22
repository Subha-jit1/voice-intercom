/**
 * CORS for the API.
 *
 * The browser PWA is served by the receiver itself and so is same-origin - it
 * never needs this. The desktop controller is a different matter: it loads its
 * UI from a local `app://` scheme, which makes every call to a receiver
 * cross-origin. Without these headers the desktop app cannot talk to any
 * receiver at all.
 *
 * Allowing any origin is safe *here* specifically because authentication is a
 * bearer token that the client must supply explicitly:
 *
 *   - No cookies and no session are used, so `credentials` is never set and a
 *     hostile page cannot ride along on ambient authority. This is the property
 *     that makes `*` acceptable; it would not be if auth were cookie-based.
 *   - Every endpoint that exposes anything sensitive already requires the
 *     token, which a hostile page has no way to obtain.
 *   - What remains readable cross-origin is /api/health and /api/identity,
 *     which deliberately expose only a name, a version and a capability list.
 *
 * WebSockets are not subject to CORS, so /ws needs nothing here.
 */

/** Methods the API actually implements. */
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/** Headers a controller legitimately sends. */
const ALLOWED_HEADERS = 'Authorization, Content-Type';

export function cors() {
  return function corsMiddleware(req, res, next) {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      // Cache the preflight for a day; the policy never changes at runtime.
      'Access-Control-Max-Age': '86400',
      // Let a controller read its own rate-limit backoff.
      'Access-Control-Expose-Headers': 'Retry-After',
    });

    // Preflight is answered here and never reaches a route - in particular it
    // must not hit the auth middleware, because browsers never attach the
    // Authorization header to an OPTIONS request.
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
