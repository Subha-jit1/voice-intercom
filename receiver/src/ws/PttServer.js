/**
 * PttServer - the WebSocket endpoint and push-to-talk floor control.
 *
 * Protocol
 * --------
 * Text frames carry JSON control messages; binary frames carry raw PCM at the
 * format agreed in `ptt.start`. Splitting them this way means audio arrives
 * with zero parsing overhead, which matters on a Pi Zero 2 W.
 *
 *   client -> server            server -> client
 *   ----------------            ----------------
 *   hello                       welcome
 *   ptt.start                   ptt.granted | ptt.denied
 *   <binary PCM frames>         state          (broadcast)
 *   ptt.stop                    ptt.ended
 *   ping                        pong
 *
 * Only one client may hold the floor at a time - this is an intercom, not a
 * conference. The holder is released on stop, on disconnect, or when it goes
 * quiet for too long, so a controller that dies mid-transmission cannot wedge
 * the receiver.
 *
 * Nothing here knows what platform it is on: it hands PCM to an AudioService
 * and that is the end of its involvement with sound.
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { extractToken, normaliseAddress } from '../auth/index.js';

/** Ping every client on this interval; drop those that miss two in a row. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Release the floor if the holder sends no audio for this long. */
const SPEAKER_SILENCE_TIMEOUT_MS = 5_000;

/** Largest acceptable frame. 64 KB is ~2 s of 16 kHz mono audio - generous. */
const MAX_PAYLOAD_BYTES = 64 * 1024;

export class PttServer {
  /**
   * @param {object} deps
   * @param {import('../config/types.js').Config} deps.config
   * @param {import('../audio/AudioService.js').AudioService} deps.audio
   * @param {import('../auth/index.js').Authenticator} deps.authenticator
   * @param {import('../logging/logger.js').Logger} deps.logger
   */
  constructor({ config, audio, authenticator, logger }) {
    this.config = config;
    this.audio = audio;
    this.authenticator = authenticator;
    this.log = logger.child('ptt');

    /** @type {Map<import('ws').WebSocket, ClientState>} */
    this.clients = new Map();
    /** @type {import('ws').WebSocket | null} */
    this.speaker = null;
    this.sessionCounter = 0;

    this.stats = {
      connectionsAccepted: 0,
      connectionsRejected: 0,
      transmissions: 0,
      audioFramesRelayed: 0,
      audioBytesRelayed: 0,
      framesFromNonSpeaker: 0,
    };

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD_BYTES,
      // The client offers ['voice-intercom.v1', 'bearer.<token>']; selecting
      // the version protocol keeps the token out of URLs and access logs.
      handleProtocols: (protocols) =>
        protocols.has('voice-intercom.v1') ? 'voice-intercom.v1' : false,
    });

    this.wss.on('connection', (socket, req) => this.#onConnection(socket, req));

    this.heartbeat = setInterval(() => this.#sweep(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  /**
   * Authenticate and complete a WebSocket upgrade.
   *
   * Authentication happens before the handshake finishes so an unauthorised
   * client never gets an open socket.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  handleUpgrade(req, socket, head) {
    const address = normaliseAddress(req.socket.remoteAddress);
    const result = this.authenticator.check(extractToken(req), address);

    if (!result.ok) {
      this.stats.connectionsRejected += 1;
      const status = result.status === 429 ? '429 Too Many Requests' : '401 Unauthorized';
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      this.log.warn('websocket upgrade rejected', { address, reason: result.reason });
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {import('node:http').IncomingMessage} req
   */
  #onConnection(socket, req) {
    const state = /** @type {ClientState} */ ({
      id: randomUUID(),
      address: normaliseAddress(req.socket.remoteAddress),
      name: 'unknown',
      connectedAt: Date.now(),
      alive: true,
      lastAudioAt: null,
      framesSent: 0,
      bytesSent: 0,
    });

    this.clients.set(socket, state);
    this.stats.connectionsAccepted += 1;
    this.log.info('controller connected', { clientId: state.id, address: state.address });

    socket.on('pong', () => { state.alive = true; });
    socket.on('message', (data, isBinary) => this.#onMessage(socket, state, data, isBinary));
    socket.on('close', (code) => this.#onClose(socket, state, code));
    socket.on('error', (err) => {
      this.log.warn('websocket error', { clientId: state.id, error: err });
    });

    this.#send(socket, {
      type: 'welcome',
      clientId: state.id,
      receiver: {
        name: this.config.receiverName,
        version: this.config.version,
      },
      format: {
        sampleRate: this.config.audio.sampleRate,
        channels: this.config.audio.channels,
        bitDepth: this.config.audio.bitDepth,
        encoding: 'pcm_s16le',
      },
      state: this.#stateSnapshot(),
    });

    this.#broadcastState();
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {ClientState} state
   * @param {Buffer} data
   * @param {boolean} isBinary
   */
  #onMessage(socket, state, data, isBinary) {
    if (isBinary) {
      this.#onAudio(socket, state, data);
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.#send(socket, { type: 'error', message: 'malformed JSON' });
      return;
    }

    switch (message.type) {
      case 'hello':
        state.name = String(message.name ?? 'controller').slice(0, 64);
        this.log.info('controller identified', { clientId: state.id, name: state.name });
        this.#broadcastState();
        break;

      case 'ptt.start':
        this.#startTransmission(socket, state, message);
        break;

      case 'ptt.stop':
        this.#endTransmission(socket, state, 'released');
        break;

      case 'ping':
        this.#send(socket, { type: 'pong', t: message.t ?? null, serverTime: Date.now() });
        break;

      default:
        this.#send(socket, { type: 'error', message: `unknown message type "${message.type}"` });
    }
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {ClientState} state
   * @param {any} message
   */
  async #startTransmission(socket, state, message) {
    if (this.speaker && this.speaker !== socket) {
      const holder = this.clients.get(this.speaker);
      this.#send(socket, {
        type: 'ptt.denied',
        reason: 'busy',
        holder: holder ? { id: holder.id, name: holder.name } : null,
      });
      return;
    }

    const format = this.#negotiateFormat(message.format);

    try {
      await this.audio.beginStream(format);
    } catch (err) {
      this.log.error('failed to open audio device for transmission', {
        clientId: state.id,
        error: err,
      });
      this.#send(socket, {
        type: 'ptt.denied',
        reason: 'audio-unavailable',
        detail: err.message,
      });
      return;
    }

    this.speaker = socket;
    this.sessionCounter += 1;
    state.lastAudioAt = Date.now();
    this.stats.transmissions += 1;

    this.log.info('transmission started', {
      clientId: state.id,
      name: state.name,
      session: this.sessionCounter,
      format,
    });

    this.#send(socket, { type: 'ptt.granted', session: this.sessionCounter, format });
    this.#broadcastState();
  }

  /**
   * The controller proposes a format; the receiver decides. Anything that does
   * not match what the audio device is configured for is rejected rather than
   * silently resampled, because resampling on a Pi Zero is not free.
   * @param {any} proposed
   */
  #negotiateFormat(proposed) {
    const target = {
      sampleRate: this.config.audio.sampleRate,
      channels: this.config.audio.channels,
      bitDepth: this.config.audio.bitDepth,
    };
    if (!proposed) return target;

    const matches =
      Number(proposed.sampleRate) === target.sampleRate &&
      Number(proposed.channels) === target.channels &&
      Number(proposed.bitDepth) === target.bitDepth;

    if (!matches) {
      this.log.warn('controller proposed a non-matching audio format; using receiver format', {
        proposed,
        using: target,
      });
    }
    return target;
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {ClientState} state
   * @param {Buffer} chunk
   */
  #onAudio(socket, state, chunk) {
    if (this.speaker !== socket) {
      this.stats.framesFromNonSpeaker += 1;
      return;
    }

    state.lastAudioAt = Date.now();
    state.framesSent += 1;
    state.bytesSent += chunk.length;
    this.stats.audioFramesRelayed += 1;
    this.stats.audioBytesRelayed += chunk.length;

    try {
      this.audio.write(chunk);
    } catch (err) {
      this.log.error('audio write failed, ending transmission', { clientId: state.id, error: err });
      this.#endTransmission(socket, state, 'audio-error');
    }
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {ClientState} state
   * @param {string} reason
   */
  #endTransmission(socket, state, reason) {
    if (this.speaker !== socket) return;

    this.speaker = null;
    this.audio.endStream().catch((err) => {
      this.log.warn('failed to close audio stream cleanly', { error: err });
    });

    this.log.info('transmission ended', {
      clientId: state.id,
      reason,
      frames: state.framesSent,
      bytes: state.bytesSent,
    });

    state.framesSent = 0;
    state.bytesSent = 0;
    state.lastAudioAt = null;

    if (socket.readyState === socket.OPEN) {
      this.#send(socket, { type: 'ptt.ended', reason });
    }
    this.#broadcastState();
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {ClientState} state
   * @param {number} code
   */
  #onClose(socket, state, code) {
    if (this.speaker === socket) this.#endTransmission(socket, state, 'disconnected');
    this.clients.delete(socket);
    this.log.info('controller disconnected', { clientId: state.id, code });
    this.#broadcastState();
  }

  /**
   * Heartbeat plus stuck-floor recovery.
   */
  #sweep() {
    const now = Date.now();

    // A client that holds the floor but stopped sending audio has almost
    // certainly been backgrounded or killed. Take the floor back.
    if (this.speaker) {
      const state = this.clients.get(this.speaker);
      if (state?.lastAudioAt && now - state.lastAudioAt > SPEAKER_SILENCE_TIMEOUT_MS) {
        this.log.warn('reclaiming floor from a silent speaker', {
          clientId: state.id,
          silentMs: now - state.lastAudioAt,
        });
        this.#endTransmission(this.speaker, state, 'timeout');
      }
    }

    for (const [socket, state] of this.clients) {
      if (!state.alive) {
        this.log.warn('terminating unresponsive controller', { clientId: state.id });
        socket.terminate();
        continue;
      }
      state.alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }

    this.authenticator.sweep();
  }

  #stateSnapshot() {
    const holder = this.speaker ? this.clients.get(this.speaker) : null;
    return {
      speaker: holder ? { id: holder.id, name: holder.name } : null,
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        name: c.name,
        connectedAt: new Date(c.connectedAt).toISOString(),
      })),
    };
  }

  #broadcastState() {
    const payload = { type: 'state', ...this.#stateSnapshot() };
    for (const socket of this.clients.keys()) this.#send(socket, payload);
  }

  /**
   * @param {import('ws').WebSocket} socket
   * @param {Record<string, unknown>} payload
   */
  #send(socket, payload) {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload), (err) => {
      if (err) this.log.debug('send failed', { error: err });
    });
  }

  /** For GET /api/diagnostics. */
  describe() {
    return {
      ...this.stats,
      connectedClients: this.clients.size,
      ...this.#stateSnapshot(),
    };
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const socket of this.clients.keys()) {
      socket.close(1001, 'receiver shutting down');
    }
    this.clients.clear();
    this.speaker = null;
    await new Promise((resolve) => this.wss.close(() => resolve(undefined)));
  }
}

/**
 * @typedef {object} ClientState
 * @property {string} id
 * @property {string} address
 * @property {string} name
 * @property {number} connectedAt
 * @property {boolean} alive
 * @property {number | null} lastAudioAt
 * @property {number} framesSent
 * @property {number} bytesSent
 */
