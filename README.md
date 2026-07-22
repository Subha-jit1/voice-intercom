# voice-intercom

A push-to-talk intercom: a controller you hold a button on, a Node.js receiver
attached to a speaker somewhere else, and Tailscale between them.

The receiver is **platform independent by construction**. The same code runs on
Android under Termux, on Debian, on Ubuntu and on Raspberry Pi OS. Moving from
a phone on your desk to a Raspberry Pi Zero 2 W in the hallway is a deployment,
not a port — no application source changes, ever.

```
  Controllers                              Receivers
┌────────────────────┐                   ┌──────────────────────┐
│ Desktop app        │                   │ Termux on a phone    │
│ Ubuntu / Windows   │──┐             ┌─▶│  └ Node.js receiver  │──▶ speaker
│ tray + global key  │  │             │  └──────────────────────┘
└────────────────────┘  ├─Tailscale───┤        (development)
┌────────────────────┐  │             │  ┌──────────────────────┐
│ Phone PWA          │──┘             └─▶│ Raspberry Pi Zero 2 W│──▶ speaker
│ hold to talk       │                   │  └ Node.js receiver  │
└────────────────────┘                   └──────────────────────┘
        ▲                                       (production)
        └── both hosts load the same controller/ UI
```

## Setting it up

**→ [docs/SETUP.md](docs/SETUP.md) is the complete step-by-step guide.** Start
there. It covers Tailscale, both receiver types, both controller types, making
the receiver always-on, and verification — with nothing left implicit.

The short version. On the machine that will be the receiver:

```bash
git clone <your-repo-url> && cd voice-intercom

bash deploy/termux/install.sh     # Android (Termux)
bash deploy/install.sh            # Ubuntu / Debian / Raspberry Pi

node tools/doctor.js              # confirms the platform and speaker
```

Both installers print an access token. Then, on the machine you want to talk
from:

```bash
cd controller-desktop && npm install && npm start
```

Click **+**, enter the receiver's Tailscale address and that token, hold the
button.

> **Choose your combination before you start — it decides whether you need
> HTTPS, which is the one thing people get stuck on.**
>
> The **desktop app needs no certificate**. It is not a browser, so it grants
> its own microphone permission and talks to a plain-HTTP receiver directly —
> verified, including the WebSocket audio stream.
>
> The **Android app does** need one, because browsers refuse microphone access
> to a remote `http://` origin. Certificates come from Tailscale's CLI, which
> does not exist on Android — so an Android controller means the receiver has
> to be a Linux box.
>
> [The decision table](docs/SETUP.md#step-0--choose-your-combination).

## Project layout

```
receiver/src/
  index.js            composition root — the only file that wires things together
  config/             .env loading and validation
  platform/detect.js  the only module that asks "what hardware is this?"
  audio/              the platform abstraction (see below)
  auth/               shared-token authentication, used by REST and WebSocket
  http/               Express app, REST routes, middleware
  ws/PttServer.js     WebSocket protocol and push-to-talk floor control
  diagnostics/        health, self-check, optional hardware sensors
  logging/            structured logger with a ring buffer for GET /api/logs

controller/           the UI. Shared by BOTH controllers, unchanged:
                        receivers.js  receiver list, status polling, per-host API
                        connection.js WebSocket client + reconnect
                        mic.js        capture, AudioWorklet → 16-bit PCM
                        app.js        the only file that touches the DOM

controller-desktop/   Electron shell: tray, global hotkey, mic permission.
                      Its OWN package.json — Electron never reaches the Pi.

deploy/               systemd unit, Termux scripts, install scripts
tools/                doctor (platform self-check), ptt-cli (browserless
                      client), make-icon (dependency-free PNG generator)
tests/                one suite, run unchanged on every platform
docs/                 architecture, setup, migration, API, desktop, testing
```

## The audio abstraction

Everything platform-specific lives behind one interface. Business logic — the
WebSocket server, the REST API, floor control — only ever sees `AudioService`.

```
                    AudioService            play() stop() setVolume() testSpeaker()
                         │                  + beginStream()/write()/endStream()
              ┌──────────┴──────────┐
     ProcessAudioService      NullAudioService     accepts audio, plays nothing
     (spawn + pipe PCM)                            (Windows, macOS, CI, headless)
              │
   ┌──────────┼───────────────┐
AlsaAudioService  LinuxAudioService ── AndroidAudioService
  aplay/amixer     paplay/pactl          + Termux PulseAudio bootstrap
  Raspberry Pi     Linux desktop         Android
```

`receiver/src/audio/index.js` picks one at startup based on the detected
platform *and* what is actually installed. That factory is the only branch in
the entire codebase that depends on the host. Override it with
`AUDIO_BACKEND=alsa|android|linux|null` to test any backend anywhere.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Run the receiver |
| `npm run dev` | Run with auto-restart on file changes |
| `npm run doctor` | Report platform, audio backend, missing tools, network |
| `npm test` | Full suite — same tests on every platform |
| `node tools/ptt-cli.js --token <t>` | Transmit a tone without a browser |

## Documentation

- **[SETUP.md](docs/SETUP.md)** — **start here.** The complete install: Tailscale, receiver, controller, always-on, verification, troubleshooting
- **[ARCHITECTURE.md](docs/ARCHITECTURE.md)** — layering, the abstraction boundary, protocol design
- **[DESKTOP.md](docs/DESKTOP.md)** — the Ubuntu/Windows app: building, hotkey, tray, CORS
- **[DEV-SETUP.md](docs/DEV-SETUP.md)** — the development loop, once installed
- **[MIGRATION.md](docs/MIGRATION.md)** — moving the receiver to a Raspberry Pi, with a no-code-changes checklist
- **[API.md](docs/API.md)** — REST endpoints and the WebSocket protocol
- **[TESTING.md](docs/TESTING.md)** — the per-platform test ladder

## Status

Phase 1 is complete: architecture, receiver APIs, authentication, WebSocket
push-to-talk, audio abstraction, diagnostics, logging, configuration, the
controller UI, the Electron desktop app, and deployment for both Termux and
systemd. 80 tests pass.

See [ARCHITECTURE.md § Roadmap](docs/ARCHITECTURE.md#roadmap) for what Phases
2–4 add.
