/**
 * Diagnostics aggregation.
 *
 * The controller is often the only interface to a headless receiver, so this
 * has to answer "why is there no sound?" without an SSH session. It gathers
 * platform facts, the audio backend's own self-check, connection state and
 * whatever hardware sensors happen to exist.
 */

import os from 'node:os';
import { detectPlatform } from '../platform/detect.js';
import { readHardwareSensors } from './hardware.js';

export class Diagnostics {
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
    this.log = logger.child('diagnostics');
    /** @type {{describe: () => unknown} | null} Set once the WS server exists. */
    this.pttServer = null;
    this.startedAt = Date.now();
  }

  /** @param {{describe: () => unknown}} server */
  attachPttServer(server) {
    this.pttServer = server;
  }

  /** Minimal, cheap, unauthenticated - suitable for systemd and uptime checks. */
  health() {
    return {
      status: 'ok',
      name: this.config.receiverName,
      version: this.config.version,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  /** Identity only. Lets a controller confirm what it has found on a tailnet. */
  identity() {
    const platform = detectPlatform();
    return {
      name: this.config.receiverName,
      version: this.config.version,
      platform: platform.id,
      capabilities: ['ptt', 'diagnostics', 'logs', 'volume', 'speaker-test'],
      audio: {
        sampleRate: this.config.audio.sampleRate,
        channels: this.config.audio.channels,
        bitDepth: this.config.audio.bitDepth,
      },
    };
  }

  /** The full picture. Authenticated. */
  async full() {
    const platform = detectPlatform();
    const memory = process.memoryUsage();

    const [audioProbe, sensors, volume] = await Promise.all([
      this.audio.probe().catch((err) => ({ available: false, detail: `probe failed: ${err.message}` })),
      readHardwareSensors(),
      this.audio.getVolume(),
    ]);

    return {
      receiver: {
        name: this.config.receiverName,
        version: this.config.version,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        startedAt: new Date(this.startedAt).toISOString(),
      },

      platform: {
        ...platform,
        hostname: os.hostname(),
        nodeVersion: process.version,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
      },

      resources: {
        loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
        totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
        processRssMB: Math.round(memory.rss / 1024 / 1024),
        processHeapMB: Math.round(memory.heapUsed / 1024 / 1024),
        systemUptimeSeconds: Math.round(os.uptime()),
      },

      audio: {
        ...this.audio.describe(),
        selectionReason: this.audio.selectionReason ?? null,
        configuredBackend: this.config.audio.backend,
        device: this.config.audio.device,
        currentVolume: volume,
        probe: audioProbe,
      },

      ptt: this.pttServer ? this.pttServer.describe() : { status: 'not started' },

      auth: this.authenticator.describe(),

      network: this.#networkInterfaces(),

      security: {
        tls: Boolean(this.config.http.tls),
        // The single most common setup failure: without TLS the browser will
        // not grant microphone access to a remote origin.
        microphoneCapable: Boolean(this.config.http.tls),
        note: this.config.http.tls
          ? 'TLS enabled - browsers will grant microphone access'
          : 'No TLS. Browsers block getUserMedia on remote http:// origins, so ' +
            'push-to-talk will fail. See docs/DEV-SETUP.md (tailscale cert).',
      },

      ...(Object.keys(sensors).length ? { sensors } : {}),
    };
  }

  #networkInterfaces() {
    const out = [];
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.internal) continue;
        out.push({
          interface: name,
          address: address.address,
          family: address.family,
          // Tailscale hands out 100.64.0.0/10 addresses; flagging it makes the
          // "which address do I point the controller at?" question answerable.
          tailscale: name.startsWith('tailscale') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address),
        });
      }
    }
    return out;
  }
}
