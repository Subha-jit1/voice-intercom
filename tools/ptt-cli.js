/**
 * ptt-cli - transmit to a receiver from a terminal.
 *
 * The controller PWA needs a browser, a microphone and (because of
 * getUserMedia) a TLS certificate. This tool needs none of those, so it can
 * verify the full push-to-talk path on any platform - including headless
 * servers and CI.
 *
 * It is the reference implementation of the client side of the protocol.
 *
 *   node tools/ptt-cli.js --url ws://localhost:8080/ws --token <token>
 *   node tools/ptt-cli.js --url ... --token ... --seconds 3 --frequency 880
 *   node tools/ptt-cli.js --url ... --token ... --file speech.raw
 *
 * --file expects headerless signed 16-bit little-endian PCM at the receiver's
 * sample rate. Produce one with:
 *   ffmpeg -i input.mp3 -f s16le -ar 16000 -ac 1 speech.raw
 */

import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { generateTone } from '../receiver/src/audio/AudioService.js';

/** Audio is sent in 20 ms chunks, matching what the browser controller does. */
const CHUNK_MS = 20;

function parseArgs(argv) {
  const args = { url: 'ws://localhost:8080/ws', seconds: 2, frequency: 440 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    switch (key) {
      case 'url': args.url = value; i += 1; break;
      case 'token': args.token = value; i += 1; break;
      case 'seconds': args.seconds = Number(value); i += 1; break;
      case 'frequency': args.frequency = Number(value); i += 1; break;
      case 'file': args.file = value; i += 1; break;
      case 'help': args.help = true; break;
      default: break;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.token) {
  process.stdout.write(
    'Usage: node tools/ptt-cli.js --token <token> [options]\n\n' +
      '  --url <url>          WebSocket URL      (default ws://localhost:8080/ws)\n' +
      '  --token <token>      AUTH_TOKEN         (required)\n' +
      '  --seconds <n>        Tone length        (default 2)\n' +
      '  --frequency <hz>     Tone pitch         (default 440)\n' +
      '  --file <path>        Send raw S16LE PCM instead of a tone\n\n'
  );
  process.exit(args.help ? 0 : 2);
}

const socket = new WebSocket(args.url, ['voice-intercom.v1', `bearer.${args.token}`]);

socket.on('unexpected-response', (_req, res) => {
  process.stderr.write(`Connection refused: HTTP ${res.statusCode}\n`);
  if (res.statusCode === 401) process.stderr.write('The token was rejected.\n');
  process.exit(1);
});

socket.on('error', (err) => {
  process.stderr.write(`WebSocket error: ${err.message}\n`);
  process.exit(1);
});

socket.on('message', async (data) => {
  const message = JSON.parse(data.toString());

  switch (message.type) {
    case 'welcome':
      process.stdout.write(
        `Connected to "${message.receiver.name}" v${message.receiver.version}\n` +
          `Format: ${message.format.sampleRate} Hz, ${message.format.channels} ch, ` +
          `${message.format.bitDepth}-bit ${message.format.encoding}\n`
      );
      socket.send(JSON.stringify({ type: 'hello', name: 'ptt-cli' }));
      socket.send(JSON.stringify({ type: 'ptt.start', format: message.format }));
      break;

    case 'ptt.granted':
      process.stdout.write(`Floor granted (session ${message.session}). Transmitting...\n`);
      await transmit(message.format);
      socket.send(JSON.stringify({ type: 'ptt.stop' }));
      break;

    case 'ptt.denied':
      process.stderr.write(
        `Floor denied: ${message.reason}${message.detail ? ` - ${message.detail}` : ''}\n`
      );
      socket.close();
      process.exitCode = 1;
      break;

    case 'ptt.ended':
      process.stdout.write('Transmission complete.\n');
      socket.close();
      break;

    default:
      break;
  }
});

/**
 * Send PCM at wall-clock speed. Pacing matters: blasting the whole buffer at
 * once would overrun the receiver's queue and get most of it dropped, exactly
 * as the backpressure policy intends.
 *
 * @param {{sampleRate: number, channels: number, bitDepth: number}} format
 */
async function transmit(format) {
  const pcm = args.file
    ? readFileSync(args.file)
    : generateTone({ ...format, durationMs: args.seconds * 1000, frequency: args.frequency });

  const bytesPerChunk =
    Math.floor((format.sampleRate * CHUNK_MS) / 1000) * format.channels * (format.bitDepth / 8);

  const startedAt = Date.now();
  let sent = 0;

  for (let offset = 0; offset < pcm.length; offset += bytesPerChunk) {
    socket.send(pcm.subarray(offset, offset + bytesPerChunk));
    sent += 1;

    // Sleep until this chunk's playback time has actually elapsed, so drift
    // cannot accumulate over a long transmission.
    const dueAt = startedAt + sent * CHUNK_MS;
    const wait = dueAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  process.stdout.write(`Sent ${sent} chunks (${pcm.length} bytes).\n`);
}
