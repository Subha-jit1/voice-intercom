/**
 * Receiver store.
 *
 * Holds the list of known receivers, persists it, and polls each one so the UI
 * can show which are reachable. Shared by the browser PWA and the desktop app -
 * it touches no DOM and no Electron API, so both load it unchanged.
 *
 * Status comes from GET /api/identity, which is deliberately unauthenticated:
 * a receiver can be shown as online, named and typed before any token is
 * entered, which is what makes "add a receiver" a discoverable flow rather
 * than a guess.
 */

const STORAGE_KEY = 'voice-intercom.receivers';

/** How often to re-check every receiver. */
const POLL_INTERVAL_MS = 6000;

/** A receiver that does not answer this fast is treated as offline. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * @typedef {object} Receiver
 * @property {string} id
 * @property {string} name          User-facing label; overwritten by the receiver's own name once known.
 * @property {string} baseUrl
 * @property {string} token
 * @property {'unknown'|'online'|'offline'|'unauthorised'} status
 * @property {any|null} identity    Payload from GET /api/identity.
 * @property {number|null} latencyMs
 * @property {number|null} lastSeen
 * @property {string|null} error
 */

export class ReceiverStore {
  constructor() {
    /** @type {Receiver[]} */
    this.receivers = [];
    /** @type {string|null} */
    this.selectedId = null;
    /** @type {Set<() => void>} */
    this.listeners = new Set();
    /** @type {number|undefined} */
    this.pollTimer = undefined;

    this.#load();
  }

  // --- Persistence ---------------------------------------------------------

  #load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      this.receivers = (stored.receivers ?? []).map((r) => ({
        // Runtime state is never persisted - a receiver that was online last
        // week tells us nothing about now.
        status: 'unknown',
        identity: null,
        latencyMs: null,
        lastSeen: null,
        error: null,
        ...r,
      }));
      this.selectedId = stored.selectedId ?? this.receivers[0]?.id ?? null;
    } catch {
      this.receivers = [];
      this.selectedId = null;
    }
  }

  #save() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        selectedId: this.selectedId,
        receivers: this.receivers.map(({ id, name, baseUrl, token }) => ({
          id, name, baseUrl, token,
        })),
      })
    );
  }

  // --- Subscription --------------------------------------------------------

  /** @param {() => void} listener @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.listeners) listener();
  }

  // --- Queries -------------------------------------------------------------

  /** @returns {Receiver | null} */
  get selected() {
    return this.receivers.find((r) => r.id === this.selectedId) ?? null;
  }

  /** @param {string} id @returns {Receiver | undefined} */
  find(id) {
    return this.receivers.find((r) => r.id === id);
  }

  // --- Mutations -----------------------------------------------------------

  /**
   * Validate a receiver and add it.
   *
   * The token is checked against the live receiver before anything is stored,
   * so a typo is reported here rather than surfacing later as a talk button
   * that quietly does nothing.
   *
   * @param {{baseUrl: string, token: string, name?: string}} input
   * @returns {Promise<Receiver>}
   */
  async add({ baseUrl, token, name }) {
    const normalised = normaliseBaseUrl(baseUrl);

    if (this.receivers.some((r) => r.baseUrl === normalised)) {
      throw new Error('That receiver has already been added.');
    }

    const verified = await verify(normalised, token);

    /** @type {Receiver} */
    const receiver = {
      id: crypto.randomUUID(),
      name: name?.trim() || verified.name || hostOf(normalised),
      baseUrl: normalised,
      token,
      status: 'online',
      identity: verified,
      latencyMs: null,
      lastSeen: Date.now(),
      error: null,
    };

    this.receivers.push(receiver);
    this.selectedId ??= receiver.id;
    this.#save();
    this.#emit();
    return receiver;
  }

  /** @param {string} id */
  remove(id) {
    this.receivers = this.receivers.filter((r) => r.id !== id);
    if (this.selectedId === id) this.selectedId = this.receivers[0]?.id ?? null;
    this.#save();
    this.#emit();
  }

  /** @param {string} id */
  select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.#save();
    this.#emit();
  }

  /** @param {string} id @param {Partial<Receiver>} patch */
  update(id, patch) {
    const receiver = this.find(id);
    if (!receiver) return;
    Object.assign(receiver, patch);
    if ('name' in patch || 'baseUrl' in patch || 'token' in patch) this.#save();
    this.#emit();
  }

  // --- Polling -------------------------------------------------------------

  startPolling() {
    this.stopPolling();
    this.refreshAll();
    this.pollTimer = setInterval(() => this.refreshAll(), POLL_INTERVAL_MS);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Probe every receiver in parallel; one slow host must not delay the rest. */
  async refreshAll() {
    if (this.receivers.length === 0) return;
    await Promise.all(this.receivers.map((r) => this.#probe(r)));
    this.#emit();
  }

  /** @param {Receiver} receiver */
  async #probe(receiver) {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${receiver.baseUrl}/api/identity`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const identity = await response.json();
      receiver.status = 'online';
      receiver.identity = identity;
      receiver.latencyMs = Math.round(performance.now() - startedAt);
      receiver.lastSeen = Date.now();
      receiver.error = null;
      // Adopt the receiver's own name so renaming it on the device shows up here.
      if (identity.name) receiver.name = identity.name;
    } catch (err) {
      receiver.status = 'offline';
      receiver.latencyMs = null;
      receiver.error = err.name === 'TimeoutError' ? 'No response' : err.message;
    }
  }
}

// --- Helpers ----------------------------------------------------------------

/**
 * Accept what a human would type. "receiver:8080" and "receiver.ts.net" both
 * become valid absolute URLs; a bare host defaults to https, because that is
 * what a Tailscale receiver with a certificate uses.
 * @param {string} input
 */
export function normaliseBaseUrl(input) {
  let value = input.trim().replace(/\/+$/, '');
  if (!value) throw new Error('An address is required.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${input}" is not a valid address.`);
  }
  return `${url.protocol}//${url.host}`;
}

/** @param {string} baseUrl */
function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * Confirm a receiver is reachable and the token is accepted.
 * @param {string} baseUrl
 * @param {string} token
 */
async function verify(baseUrl, token) {
  let response;
  try {
    response = await fetch(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
    });
  } catch (err) {
    throw new Error(
      err.name === 'TimeoutError'
        ? `No response from ${hostOf(baseUrl)}. Is the receiver running and on the tailnet?`
        : `Could not reach ${hostOf(baseUrl)}: ${err.message}`
    );
  }

  if (response.status === 401) throw new Error('That token was rejected by the receiver.');
  if (response.status === 429) throw new Error('Too many failed attempts. Wait a minute and retry.');
  if (!response.ok) throw new Error(`Receiver returned HTTP ${response.status}.`);

  const body = await response.json();
  return body.receiver;
}

/**
 * Authenticated fetch against a specific receiver.
 * @param {Receiver} receiver
 * @param {string} path
 * @param {RequestInit} [options]
 */
export async function receiverApi(receiver, path, options = {}) {
  const response = await fetch(`${receiver.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${receiver.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * The WebSocket URL for a receiver, derived from its HTTP address.
 * @param {Receiver} receiver
 */
export function websocketUrl(receiver) {
  const url = new URL(receiver.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}
