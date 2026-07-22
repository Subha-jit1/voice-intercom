/**
 * WebSocket client for the receiver.
 *
 * Owns connection state, reconnection and the control protocol. It knows
 * nothing about the DOM, so the UI layer stays a thin translation of these
 * callbacks into pixels.
 */

/** Reconnect backoff bounds. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

/** Round-trip probe interval. */
const PING_INTERVAL_MS = 5000;

export class Connection {
  /**
   * @param {object} handlers
   * @param {(status: string, detail?: string) => void} handlers.onStatus
   * @param {(welcome: any) => void} handlers.onWelcome
   * @param {(state: any) => void} handlers.onState
   * @param {(session: any) => void} handlers.onGranted
   * @param {(info: any) => void} handlers.onDenied
   * @param {(info: any) => void} handlers.onEnded
   * @param {(ms: number) => void} handlers.onLatency
   * @param {(reason: string) => void} handlers.onAuthFailure
   */
  constructor(handlers) {
    this.handlers = handlers;
    /** @type {WebSocket | null} */
    this.socket = null;
    this.url = '';
    this.token = '';
    this.shouldReconnect = false;
    this.attempt = 0;
    /** @type {number | undefined} */
    this.reconnectTimer = undefined;
    /** @type {number | undefined} */
    this.pingTimer = undefined;
    this.latencyMs = null;

    // Reconnect the moment the phone regains connectivity or the user brings
    // the app back to the foreground, rather than waiting out the backoff.
    addEventListener('online', () => this.#retryNow());
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.#retryNow();
    });
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * @param {string} wsUrl
   * @param {string} token
   */
  connect(wsUrl, token) {
    this.url = wsUrl;
    this.token = token;
    this.shouldReconnect = true;
    this.#open();
  }

  disconnect() {
    this.shouldReconnect = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.socket?.close(1000, 'client disconnected');
    this.socket = null;
    this.handlers.onStatus('offline');
  }

  #open() {
    clearTimeout(this.reconnectTimer);
    this.handlers.onStatus('connecting');

    let socket;
    try {
      // The token travels as a subprotocol rather than a query parameter so it
      // never lands in a proxy access log or browser history entry.
      socket = new WebSocket(this.url, ['voice-intercom.v1', `bearer.${this.token}`]);
    } catch (err) {
      this.#scheduleReconnect();
      return;
    }

    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onStatus('online');
      this.send({ type: 'hello', name: navigator.userAgent.includes('Android') ? 'phone' : 'controller' });
      this.#startPinging();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.#dispatch(message);
    };

    socket.onclose = (event) => {
      clearInterval(this.pingTimer);
      this.socket = null;

      // 1008/1011 and a close immediately after opening usually mean the
      // handshake was rejected - retrying with the same bad token is futile.
      if (event.code === 1008) {
        this.shouldReconnect = false;
        this.handlers.onAuthFailure('The receiver rejected the token.');
        return;
      }

      this.handlers.onStatus('offline', describeClose(event));
      this.#scheduleReconnect();
    };

    socket.onerror = () => {
      // onerror carries no useful detail in browsers; onclose follows and
      // handles the state transition.
    };
  }

  #dispatch(message) {
    switch (message.type) {
      case 'welcome':   this.handlers.onWelcome(message); break;
      case 'state':     this.handlers.onState(message); break;
      case 'ptt.granted': this.handlers.onGranted(message); break;
      case 'ptt.denied':  this.handlers.onDenied(message); break;
      case 'ptt.ended':   this.handlers.onEnded(message); break;
      case 'pong':
        if (typeof message.t === 'number') {
          this.latencyMs = Math.round(performance.now() - message.t);
          this.handlers.onLatency(this.latencyMs);
        }
        break;
      default: break;
    }
  }

  #startPinging() {
    clearInterval(this.pingTimer);
    const ping = () => this.send({ type: 'ping', t: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  #scheduleReconnect() {
    if (!this.shouldReconnect) return;

    this.attempt += 1;
    const base = Math.min(BACKOFF_MIN_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
    // Jitter stops several controllers from reconnecting in lockstep after a
    // receiver restart.
    const delay = base * (0.7 + Math.random() * 0.6);

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  /** Collapse the backoff and try immediately. */
  #retryNow() {
    if (!this.shouldReconnect || this.isOpen || !navigator.onLine) return;
    this.attempt = 0;
    clearTimeout(this.reconnectTimer);
    this.#open();
  }

  /** @param {Record<string, unknown>} payload */
  send(payload) {
    if (!this.isOpen) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  /** @param {ArrayBuffer} buffer */
  sendAudio(buffer) {
    if (!this.isOpen) return false;
    // Never let audio pile up in the socket: if the network stalls, dropping
    // is correct for realtime speech.
    if (this.socket.bufferedAmount > 64 * 1024) return false;
    this.socket.send(buffer);
    return true;
  }

  requestFloor(format) {
    return this.send({ type: 'ptt.start', format });
  }

  releaseFloor() {
    return this.send({ type: 'ptt.stop' });
  }
}

/** @param {CloseEvent} event */
function describeClose(event) {
  if (event.code === 1000) return 'Disconnected';
  if (event.code === 1001) return 'Receiver is shutting down';
  if (event.code === 1006) return 'Connection lost';
  return `Disconnected (${event.code})`;
}
