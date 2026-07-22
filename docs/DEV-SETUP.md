# Development workflow

> **Setting up for the first time? Use [SETUP.md](SETUP.md).** That is the
> single, complete, step-by-step guide. This document is only about the
> day-to-day loop once things are installed — it deliberately does not repeat
> setup instructions, so the two cannot drift apart.

---

## The development environment

Phase 1 is built entirely without a Raspberry Pi:

```
Phone A / desktop            Phone B (Termux)
  controller        ──▶        Node.js receiver  ──▶ speaker
                Tailscale
```

Everything except hardware-specific speaker tuning can be developed here:
authentication, discovery, streaming, push-to-talk, logging, diagnostics, the
receiver APIs, health monitoring, reconnect logic and configuration.

## You do not need a phone either

The receiver runs on your development machine. On Windows and macOS it selects
`NullAudioService` automatically — audio is accepted and discarded, and every
other feature behaves identically. This is the intended way to build protocol
and UI features.

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# paste that into .env as AUTH_TOKEN, then:
npm run dev
```

Open `http://localhost:8080`. `localhost` counts as a secure context, so the
microphone works with no certificate.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Receiver with auto-restart on file changes |
| `npm start` | Receiver, no watcher |
| `npm test` | Full suite — 80 tests, no hardware needed |
| `npm run doctor` | Platform, audio backend, missing tools, network |
| `npm run icons` | Regenerate the PWA PNG icons |
| `node tools/ptt-cli.js --token <t>` | Transmit a tone without a browser |
| `cd controller-desktop && npm start` | The desktop app |

## Testing without a microphone

`tools/ptt-cli.js` is a complete controller in ~150 lines. It needs no browser,
no certificate and no microphone, so it works on headless machines and in CI:

```bash
node tools/ptt-cli.js --token <TOKEN> --seconds 2 --frequency 880
node tools/ptt-cli.js --token <TOKEN> --file speech.raw
```

Produce a raw file with:

```bash
ffmpeg -i input.mp3 -f s16le -ar 16000 -ac 1 speech.raw
```

## Forcing a specific audio backend

The factory picks a backend from the detected platform, but you can override it
to exercise any code path anywhere:

```bash
AUDIO_BACKEND=null  npm start     # no sound, works everywhere
AUDIO_BACKEND=alsa  npm start     # force ALSA
AUDIO_BACKEND=linux npm start     # force PulseAudio
```

The same override drives the audio contract tests against real hardware:

```bash
TEST_AUDIO_BACKEND=alsa npm test
```

## Debugging the desktop app

```bash
cd controller-desktop
npm start -- --remote-debugging-port=9222
```

Then open `http://127.0.0.1:9222` in Chrome to attach DevTools to the running
Electron renderer.

## Where things live

| I want to change… | Look in |
| --- | --- |
| How audio is played on a platform | `receiver/src/audio/*AudioService.js` |
| Which backend gets chosen | `receiver/src/audio/index.js` |
| The push-to-talk protocol | `receiver/src/ws/PttServer.js` |
| REST endpoints | `receiver/src/http/routes/` |
| Controller UI (both hosts) | `controller/` |
| Desktop-only behaviour | `controller-desktop/main.js` |
| A new config option | `receiver/src/config/index.js` + `.env.example` |

## Rules that keep the architecture honest

1. Business logic talks to `AudioService`, never to a concrete backend.
2. Only `platform/detect.js` and `audio/index.js` may ask what hardware this is.
3. Hardware sensors go in `diagnostics/hardware.js` and return `null` when absent.
4. New configuration goes in `.env` with a default in `loadConfig()`.
5. Tests target the interface, so they run on every platform.
6. No test may require a Raspberry Pi to pass.

Further reading: [ARCHITECTURE.md](ARCHITECTURE.md) · [TESTING.md](TESTING.md)
