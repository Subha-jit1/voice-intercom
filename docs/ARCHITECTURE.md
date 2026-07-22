# Architecture

## The governing constraint

The Raspberry Pi is a deployment target, not a project. Everything else follows
from that.

Concretely, this means the codebase obeys four rules:

1. **No Raspberry Pi is required to develop any feature.** Phase 1 runs entirely
   on two Android phones.
2. **Hardware knowledge is confined to two modules.** `platform/detect.js`
   decides what machine this is; `audio/index.js` decides which implementation
   to construct. Nothing else asks.
3. **Business logic depends on interfaces, never implementations.** The
   WebSocket server hands PCM to an `AudioService`. It cannot tell — and has no
   way to find out — whether that ends up in ALSA, PulseAudio or `/dev/null`.
4. **The migration to production changes zero lines of application code.** It
   changes `.env` and adds a systemd unit.

Rule 4 is checkable, and [MIGRATION.md](MIGRATION.md) contains the checklist
that checks it.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ controller/            Browser PWA. Captures mic, sends PCM. │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS + WSS over Tailscale
┌───────────────────────────────▼──────────────────────────────┐
│ Transport      http/app.js · ws/PttServer.js                 │
│                REST + WebSocket. Speaks the protocol.        │
├──────────────────────────────────────────────────────────────┤
│ Domain         auth/ · diagnostics/ · logging/ · config/     │
│                Platform-independent. No process spawning,    │
│                no /proc, no /dev.                            │
├──────────────────────────────────────────────────────────────┤
│ Abstraction    audio/AudioService.js                         │
│                ◀── everything above stops here ──▶           │
├──────────────────────────────────────────────────────────────┤
│ Platform       audio/{Android,Alsa,Linux,Null}AudioService   │
│                platform/detect.js · diagnostics/hardware.js  │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. `receiver/src/index.js` is the composition
root: the single place where concrete classes are instantiated and injected.
Every other module receives what it needs as constructor arguments, which is
what makes the whole thing testable without hardware.

## The audio abstraction

### The interface

```js
class AudioService {
  // The contract from the specification
  play(buffer)          // play one complete PCM buffer
  stop()                // stop now, release the device
  setVolume(percent)    // 0-100
  testSpeaker()         // emit a known tone

  // Extension: push-to-talk is a stream, not a finished buffer
  beginStream(format)
  write(chunk)          // returns false if dropped (see backpressure)
  endStream()

  // Operational
  init()                // one-time setup (Termux starts PulseAudio here)
  probe()               // "can I actually work right now?" — for diagnostics
  describe()            // state + counters
  shutdown()
}
```

`play()` is implemented **once**, in the base class, in terms of
`beginStream`/`write`/`endStream`. So is `testSpeaker()`, which synthesises its
tone in JavaScript rather than shelling out to `speaker-test` — that tool does
not exist on Termux and behaves differently across distributions, and
generating the PCM ourselves means the speaker test exercises exactly the same
code path as real speech. No subclass reimplements either.

### The implementations

| Class | Platform | Playback | Volume |
| --- | --- | --- | --- |
| `AndroidAudioService` | Android / Termux | `paplay` | `termux-volume`, falls back to `pactl` |
| `AlsaAudioService` | Raspberry Pi, Debian, Ubuntu | `aplay` | `amixer` |
| `LinuxAudioService` | Linux desktop (PulseAudio/PipeWire) | `paplay` | `pactl` |
| `NullAudioService` | Windows, macOS, CI, headless | discards | in-memory |

All three real backends pipe raw PCM into a child process' stdin, so the
spawning, backpressure, `EPIPE` handling and drain-on-close logic lives once in
`ProcessAudioService`. A concrete backend supplies a command and a volume
strategy — usually under 100 lines.

`AndroidAudioService extends LinuxAudioService`, because once PulseAudio is
running on Termux, playback *is* the Linux path. Android contributes only a
bootstrap step (`pulseaudio --start --load=module-sles-sink`) and a preference
for Android's own media volume.

### `NullAudioService` is load-bearing

It is not a stub. It is how the project keeps its platform-independence claim
honest: authentication, discovery, the WebSocket protocol, floor control,
diagnostics, logging and reconnect can all be developed and tested on a laptop
with no sound card, through the identical code path that will later drive a
speaker. The CI suite runs against it, and every test in `tests/audio.test.js`
is written against the interface so it can be re-run against real hardware with
`TEST_AUDIO_BACKEND=alsa npm test`.

### Backend selection

```
AUDIO_BACKEND=auto (default)
  ├─ Termux detected        → android
  ├─ Raspberry Pi detected  → alsa if aplay exists, else linux, else null
  ├─ Other Linux            → linux if paplay exists, else alsa, else null
  └─ Windows / macOS        → null
```

Selection is driven by what is *installed*, not by assumptions about the
distribution — a Debian box without `alsa-utils` gets a working PulseAudio
backend rather than a crash. When nothing is available, the receiver starts
anyway with the null backend and says so loudly in the startup log and in
`GET /api/diagnostics`; every non-audio feature still works.

## Audio pipeline

Phase 1 transports **raw PCM: 16 kHz, mono, signed 16-bit little-endian**.

```
Microphone
  → getUserMedia (echo cancellation, noise suppression, AGC)
  → AudioContext({ sampleRate: 16000 })      browser resamples in native code
  → AudioWorklet (ptt-processor.js)          Float32 → Int16, 20 ms chunks
  → WebSocket binary frame                   640 bytes per chunk, 50/second
  ───────────────────────────── Tailscale ─────────────────────────────
  → PttServer                                floor check, counters
  → AudioService.write(chunk)
  → child process stdin                      aplay / paplay
  → speaker
```

**Why raw PCM.** It needs no codec on any platform, which means Phase 1 has no
audio dependency beyond a playback command that already exists on every target.
It costs ~256 kbps, which is nothing over a tailnet and acceptable on cellular
for short transmissions. Opus would cut that tenfold but makes `ffmpeg` a hard
install requirement on Termux *and* the Pi, and adds container framing and
latency. The transport is deliberately the narrowest part of the design — a
codec can be introduced in Phase 2 behind the same `AudioService` interface
without touching floor control or the API.

**Why 16 kHz.** Wideband speech. It is the standard rate for voice, halves the
bandwidth of 32 kHz, and a Pi Zero 2 W plays it without measurable CPU cost.

**Why a worklet.** `ScriptProcessorNode` runs on the main thread, where a UI
repaint or a GC pause becomes an audible dropout. The worklet runs on the audio
thread.

### Backpressure: drop, never queue

If the playback device falls behind, chunks are **dropped**, not buffered —
both in the browser (`bufferedAmount > 64 KB`) and in the receiver
(`stdin.writableLength > AUDIO_MAX_QUEUE_FRAMES` worth of bytes). Queueing
realtime speech converts a momentary glitch into permanently growing latency,
which is worse. Drops are counted and reported in `GET /api/diagnostics` as
`audio.stats.framesDropped`.

## Push-to-talk protocol

Text frames carry JSON control messages; binary frames carry PCM. Splitting
them means audio arrives with zero parsing overhead.

```
client                                  server
  │                                       │
  ├─ upgrade /ws ────────────────────────▶│  authenticated BEFORE the handshake
  │◀──────────────────────────── welcome ─┤  completes; no socket for strangers
  ├─ hello {name} ───────────────────────▶│
  ├─ ptt.start {format} ─────────────────▶│
  │◀───────── ptt.granted | ptt.denied ───┤  one talker at a time
  ├─ <binary PCM> × N ───────────────────▶│
  ├─ ptt.stop ───────────────────────────▶│
  │◀──────────────────────────ptt.ended ──┤
  │◀─────────────────────────── state ────┤  broadcast to every controller
```

**Floor control.** This is an intercom, not a conference: exactly one client may
transmit. The floor is released on `ptt.stop`, on disconnect, and — critically —
after 5 seconds of silence from the holder. Without that last rule, a phone
that gets backgrounded or killed mid-transmission would wedge the receiver
permanently.

**Authentication happens during the upgrade**, before the WebSocket is
established, so an unauthorised client never gets an open socket. The token
travels as a subprotocol (`bearer.<token>`) rather than a query parameter,
because browsers cannot set headers on a WebSocket handshake and query strings
end up in proxy logs.

Full message reference: [API.md](API.md).

## Two controller hosts, one UI

The same `controller/` directory is loaded by two different hosts:

```
controller/                      receivers.js  connection.js  mic.js  app.js
   │
   ├── served by the receiver  →  browser PWA        (phone, any desktop browser)
   └── read from disk          →  Electron shell     (Ubuntu .deb/AppImage, Windows .exe)
```

`controller-desktop/` contains no intercom logic — no protocol, no floor
handling, no capture. It supplies only what a browser cannot: a global hotkey,
a tray icon, autostart, and microphone permission. Everything else it inherits
by loading the shared UI. A fix to push-to-talk lands in both hosts at once.

The UI detects its host through `window.desktop`, which the Electron preload
exposes and a browser does not. Every use of it is progressive enhancement, so
the browser build cannot break.

**Electron has its own `package.json`.** `npm install` at the repository root
still installs three packages. The receiver's dependency budget is a hard
constraint set by the Pi Zero; the controller's is not, and the two must never
share a lockfile.

### What the desktop host buys

**No TLS certificate.** The shell serves the UI over a custom `app://` scheme
registered as *secure*, so the renderer is a secure context and `getUserMedia`
works immediately. This removes the single most common setup failure. `file://`
would not do — Chromium does not treat it as secure, and it is rejected exactly
the way remote `http://` is.

**A global hotkey — as a toggle, not a hold.** Electron's `globalShortcut`
reports key presses only; there is no global key-up without a native input
hook. Binding hold-to-talk to it would start a transmission that never ends, so
the global key toggles and hold-to-talk stays inside the window where real
`keyup` events exist. The receiver's five-second silence timeout catches the
case where a toggled transmission is abandoned.

### The cost: CORS

The PWA is same-origin with its receiver and needs nothing. The desktop app
loads from `app://`, so every API call is cross-origin — without CORS headers
it cannot reach a receiver at all.

`Access-Control-Allow-Origin: *` on `/api` is safe *here specifically* because
authentication is a bearer token and never a cookie: no ambient authority
exists for a hostile page to ride on, and everything sensitive already requires
the token. Had auth been cookie-based, this would be a vulnerability rather
than a configuration. Preflight is answered before the auth middleware, because
browsers never attach `Authorization` to an `OPTIONS` request.

## Security model

Tailscale provides device identity, mutual authentication and encryption at the
network layer. The application layer defends against the threat that remains:
another device already on the same tailnet.

- **Shared token**, compared with `timingSafeEqual`. One `Authenticator`
  instance serves both REST and WebSocket, so the two paths cannot drift.
- **Per-address lockout** after repeated failures. IPv4-mapped IPv6 addresses
  are folded onto their IPv4 form so they cannot be used to double the
  allowance.
- **`trust proxy` is `loopback` only.** Trusting arbitrary `X-Forwarded-For`
  would let a client spoof its address and walk straight past the rate limiter.
  Loopback covers `tailscale serve` and nothing else.
- **Secrets never leave the process.** `GET /api/config` runs through
  `redactConfig()`, and a test asserts the token appears in no response body.
- **`/api/health` and `/api/identity` are deliberately public** so uptime checks
  and receiver discovery work without distributing the secret. Neither reveals
  anything beyond a name, a version and a capability list.

## Design decisions

**Plain JavaScript, ESM, no build step.** A Pi Zero 2 W has 512 MB of RAM and a
slow SD card. `git clone && npm install && node receiver/src/index.js` is the
whole deployment; there is no `tsc` to run and no `dist/` that can drift from
source. Types are expressed in JSDoc and checked by `jsconfig.json`, so editors
and `tsc --noEmit` still catch mistakes.

**Three runtime dependencies** (`express`, `ws`, `dotenv`). Logging, config
validation, process helpers and the ring buffer are a few hundred lines each and
are written here rather than installed. Every dependency is one more thing that
must build on ARM under Termux.

**The receiver serves the controller.** One address, one certificate, one
install. The PWA is same-origin with its API, so there is no CORS to
misconfigure on a phone.

**Configuration through `.env` only.** No config file formats, no CLI flags, no
per-platform branches. The set of knobs is identical everywhere, and
`loadConfig()` validates all of them at startup — a bad port fails immediately
with a readable message rather than at 3am on the first transmission.

## Roadmap

Phase 1 (complete) delivered the architecture, receiver APIs, authentication,
WebSocket push-to-talk, the audio abstraction, diagnostics, logging,
configuration, the controller PWA and deployment for Termux and systemd.

- **Phase 2** — Opus behind the existing interface, a receiver dashboard,
  remote configuration, health monitoring and alerting, broader test coverage.
- **Phase 3** — audio tuning per platform, multi-receiver zones, hardened
  recovery and reconnect, optional per-device tokens.
- **Phase 4** — Raspberry Pi migration. Deployment only; see
  [MIGRATION.md](MIGRATION.md).
