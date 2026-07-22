/**
 * doctor - report what this machine can and cannot do, without starting the
 * receiver.
 *
 * The first thing to run after cloning onto a new Termux install or a fresh
 * Raspberry Pi. It answers "will audio work here, and if not, what do I
 * install?" before anything else is configured.
 *
 *   node tools/doctor.js
 */

import os from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectPlatform } from '../receiver/src/platform/detect.js';
import { createAudioService } from '../receiver/src/audio/index.js';
import { readHardwareSensors } from '../receiver/src/diagnostics/hardware.js';
import { ROOT_DIR } from '../receiver/src/config/index.js';

/** A logger that stays quiet - doctor prints its own report. */
const quietLogger = {
  child: () => quietLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};

function line(label, value) {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

function heading(text) {
  process.stdout.write(`\n${text}\n${'-'.repeat(text.length)}\n`);
}

const platform = detectPlatform();

process.stdout.write('\nvoice-intercom doctor\n=====================\n');

heading('Platform');
line('Detected', platform.id);
line('Description', platform.label);
line('OS / arch', `${platform.os} / ${platform.arch}`);
line('Kernel', platform.kernel);
line('Hostname', os.hostname());
line('Node', process.version);
line('Memory', `${Math.round(os.totalmem() / 1024 / 1024)} MB total`);
if (platform.model) line('Board model', platform.model);

heading('Configuration');
const envPath = resolve(ROOT_DIR, '.env');
if (existsSync(envPath)) {
  line('.env', 'found');
} else {
  line('.env', 'MISSING - copy .env.example to .env and set AUTH_TOKEN');
}

heading('Audio');
const audioConfig = {
  backend: process.env.AUDIO_BACKEND ?? 'auto',
  device: process.env.AUDIO_DEVICE || null,
  sampleRate: Number(process.env.AUDIO_SAMPLE_RATE ?? 16000),
  channels: Number(process.env.AUDIO_CHANNELS ?? 1),
  bitDepth: 16,
  idleTimeoutMs: 1500,
  maxQueueFrames: 32,
};

const audio = await createAudioService({ config: audioConfig, logger: quietLogger });
const probe = await audio.probe();

line('Backend selected', audio.name);
line('Reason', audio.selectionReason ?? 'n/a');
line('Usable', probe.available ? 'yes' : 'NO');
line('Detail', probe.detail);

if (probe.tools) {
  process.stdout.write('\n  Required tools:\n');
  for (const [tool, present] of Object.entries(probe.tools)) {
    process.stdout.write(`    ${present ? '[ok]     ' : '[missing]'} ${tool}\n`);
  }
}
if (probe.devices?.length) {
  process.stdout.write('\n  Playback devices:\n');
  for (const device of probe.devices) process.stdout.write(`    ${device}\n`);
}
if (probe.sinks?.length) {
  process.stdout.write('\n  PulseAudio sinks:\n');
  for (const sink of probe.sinks) process.stdout.write(`    ${sink}\n`);
}

const sensors = await readHardwareSensors();
if (Object.keys(sensors).length) {
  heading('Sensors');
  if (sensors.temperatureC != null) line('Temperature', `${sensors.temperatureC} C`);
  if (sensors.piThrottling) {
    const t = /** @type {any} */ (sensors.piThrottling);
    line('Pi throttling', t.raw);
    if (t.underVoltage) {
      process.stdout.write(
        '\n  WARNING: under-voltage detected. A weak power supply causes audio\n' +
          '  dropouts that look like network problems. Use a 5V 2.5A+ supply.\n'
      );
    }
  }
}

heading('Network');
for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.internal || address.family !== 'IPv4') continue;
    const isTailscale =
      name.startsWith('tailscale') ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address);
    line(name, `${address.address}${isTailscale ? '   <- Tailscale' : ''}`);
  }
}

heading('Verdict');
if (probe.available && audio.name !== 'null') {
  process.stdout.write('  Audio is ready. Start the receiver with: npm start\n\n');
} else if (audio.name === 'null') {
  // The null backend is correct on a desktop OS and a bug anywhere else, so
  // say which case this is rather than reassuring the user either way.
  const expected = ['windows', 'macos'].includes(platform.id);
  if (expected) {
    process.stdout.write(
      '  Running with the null audio backend - every feature except sound will\n' +
        '  work. This is expected on Windows/macOS and fine for development.\n\n'
    );
  } else if (audioConfig.backend === 'null') {
    process.stdout.write(
      '  The null backend was forced by AUDIO_BACKEND=null in .env.\n' +
        '  Remove that line (or set AUDIO_BACKEND=auto) to enable sound.\n\n'
    );
  } else {
    process.stdout.write(
      `  PROBLEM: this is ${platform.id === 'unknown' ? 'an unrecognised platform' : platform.label},\n` +
        '  which should support real audio, but the null backend was selected -\n' +
        '  so nothing will ever come out of the speaker.\n\n' +
        '  Most likely the audio tools are missing. Install them:\n' +
        '    Termux            pkg install pulseaudio\n' +
        '    Debian/Ubuntu/Pi  sudo apt install alsa-utils\n\n' +
        '  If they are already installed, please report this output as a bug.\n\n'
    );
  }
} else {
  process.stdout.write('  Audio is NOT ready. See the detail above.\n\n');
}

await audio.shutdown();
