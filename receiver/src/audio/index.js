/**
 * Audio backend selection.
 *
 * This factory is the single place where "which platform am I on?" turns into
 * "which implementation do I construct?". Nothing downstream of here knows the
 * difference - the WebSocket server and the REST API only ever see an
 * AudioService.
 *
 * Moving from a phone in Termux to a Raspberry Pi changes which branch is
 * taken here. It changes no other line of code in the project.
 */

import { detectPlatform } from '../platform/detect.js';
import { AudioService } from './AudioService.js';
import { AndroidAudioService } from './AndroidAudioService.js';
import { AlsaAudioService } from './AlsaAudioService.js';
import { LinuxAudioService } from './LinuxAudioService.js';
import { NullAudioService } from './NullAudioService.js';
import { commandExists } from './exec.js';

/** @type {Record<string, typeof AudioService>} */
const BACKENDS = {
  android: AndroidAudioService,
  alsa: AlsaAudioService,
  linux: LinuxAudioService,
  null: NullAudioService,
};

/**
 * Decide which backend a Linux-family system should use, based on what is
 * actually installed rather than on assumptions about the distribution.
 *
 * @param {import('../platform/detect.js').PlatformInfo} platform
 * @returns {Promise<{backend: keyof BACKENDS, reason: string}>}
 */
async function chooseLinuxBackend(platform) {
  const [hasAplay, hasPaplay] = await Promise.all([
    commandExists('aplay'),
    commandExists('paplay'),
  ]);

  // On a Raspberry Pi the speaker is usually wired straight to ALSA, and going
  // through PulseAudio only adds latency - so ALSA wins when both exist.
  // On a desktop PulseAudio/PipeWire owns the device, so it wins there.
  const order = platform.isRaspberryPi
    ? [['alsa', hasAplay], ['linux', hasPaplay]]
    : [['linux', hasPaplay], ['alsa', hasAplay]];

  for (const [backend, present] of order) {
    if (present) {
      return {
        backend: /** @type {keyof BACKENDS} */ (backend),
        reason: `auto-detected on ${platform.label}`,
      };
    }
  }

  return {
    backend: 'null',
    reason:
      `no audio tools found on ${platform.label}. ` +
      `Install alsa-utils (aplay) or pulseaudio-utils (paplay) to enable sound.`,
  };
}

/**
 * @param {import('../platform/detect.js').PlatformInfo} platform
 * @returns {Promise<{backend: keyof BACKENDS, reason: string}>}
 */
async function selectBackend(platform) {
  switch (platform.id) {
    case 'android':
      return { backend: 'android', reason: 'auto-detected Termux on Android' };

    case 'raspberrypi':
    case 'linux':
      return chooseLinuxBackend(platform);

    case 'windows':
    case 'macos':
      return {
        backend: 'null',
        reason:
          `${platform.id} is not a supported playback target yet; ` +
          `every other feature works normally`,
      };

    default:
      return { backend: 'null', reason: `unrecognised platform (${platform.os})` };
  }
}

/**
 * Build the AudioService for this machine and initialise it.
 *
 * @param {object} options
 * @param {import('../config/types.js').AudioConfig} options.config
 * @param {import('../logging/logger.js').Logger} options.logger
 * @returns {Promise<AudioService>}
 */
export async function createAudioService({ config, logger }) {
  const log = logger.child('audio');
  const platform = detectPlatform();

  const forced = config.backend !== 'auto';
  const { backend, reason } = forced
    ? { backend: config.backend, reason: `forced by AUDIO_BACKEND=${config.backend}` }
    : await selectBackend(platform);

  const Backend = BACKENDS[backend];
  const service = new Backend({ config, logger: log, reason });

  log.info('audio backend selected', {
    backend: service.name,
    platform: platform.id,
    platformLabel: platform.label,
    reason,
  });

  await service.init();

  // Report capability up front. A speaker that will never work should be
  // visible in the startup log, not discovered on the first transmission.
  const probe = await service.probe().catch((err) => ({
    available: false,
    detail: `probe failed: ${err.message}`,
  }));

  if (!probe.available) {
    log.warn('audio backend is not ready', { backend: service.name, detail: probe.detail });
  } else {
    log.info('audio backend ready', { backend: service.name, detail: probe.detail });
  }

  service.selectionReason = reason;
  return service;
}

export { AudioService, AndroidAudioService, AlsaAudioService, LinuxAudioService, NullAudioService };
