# Testing

One suite. It runs unchanged on every platform, and the same assertions must
pass on all of them.

```bash
npm test
```

## The ladder

Features are verified in this order, each rung adding one layer of reality:

```
1. Development machine   Windows / macOS / Linux    NullAudioService, no hardware
2. Android (Termux)      Phone B                    real speaker, real Tailscale
3. Linux                 any Debian or Ubuntu box   ALSA or PulseAudio
4. Raspberry Pi          Pi Zero 2 W                the production target
```

Rung 1 catches almost everything, because the only thing it cannot exercise is
sound actually leaving a speaker. Rungs 2–4 are about hardware, not logic.

## Running against real audio hardware

By default the audio contract runs against `NullAudioService`, which works
everywhere. To run the *same* assertions against a real backend — the acceptance
test when bringing up a new platform:

```bash
TEST_AUDIO_BACKEND=android npm test    # on Termux
TEST_AUDIO_BACKEND=alsa    npm test    # on a Raspberry Pi or Debian box
TEST_AUDIO_BACKEND=linux   npm test    # on a PulseAudio/PipeWire desktop
```

This is deliberate: `tests/audio.test.js` is written against the `AudioService`
interface and never mentions a concrete class, so pointing it at different
hardware needs no new test code. Expect a few short tones from the speaker.

## What is covered

| File | Covers |
| --- | --- |
| `tests/audio.test.js` | The `AudioService` contract, on any backend. Streaming, byte accounting, `play()`, `testSpeaker()`, volume clamping, tone synthesis. |
| `tests/auth.test.js` | Token extraction from all three transports, constant-time comparison, per-address lockout and expiry, IPv4-mapped folding. |
| `tests/config.test.js` | Defaults, required values, range checks, TLS pairing, and that `redactConfig` never leaks the token. |
| `tests/receiver.test.js` | End-to-end. Starts a real receiver process and drives it over HTTP and WebSocket exactly as the controller does. |

`tests/receiver.test.js` spawns `receiver/src/index.js` rather than importing
internals, so it exercises config loading, the WebSocket upgrade path and signal
handling — the parts that only break in a real process.

## Notable cases

Worth knowing about, because they encode requirements that are easy to
regress:

- **The floor is released when a talker disconnects without saying so.** The
  test terminates the socket mid-transmission, as a crashed phone would, and
  asserts the next client can still take the floor.
- **Audio from a non-holder is discarded**, and counted separately.
- **`GET /api/config` never contains the token** — asserted against the raw
  response body, not the parsed object.
- **Unknown `/api/*` paths return JSON 404**, never the PWA's `index.html`.
  Regressing this turns every controller bug into a confusing HTML parse error.
- **Malformed JSON does not kill the connection.** The client gets an `error`
  message and the socket stays usable.

## Manual checks

Some things need a human. Per platform:

| Check | How |
| --- | --- |
| Sound actually comes out | **Test speaker** in the app, or `POST /api/audio/test` |
| Microphone capture | Hold the button; the level meter should move |
| End-to-end latency | Speak and listen — under ~300 ms feels immediate |
| Reconnect | Turn the controller's Wi-Fi off and on; the dot returns to green unaided |
| Backgrounding | Lock the controller phone mid-transmission; the floor must release |
| PWA install | Add to Home screen; it should open standalone |

## Adding tests

Test through the interface, not the implementation. A test that mentions
`AlsaAudioService` by name can only ever run on one platform; a test written
against `AudioService` runs on all four. If a bug was platform-specific, the
regression test still belongs in `tests/audio.test.js` — with
`TEST_AUDIO_BACKEND` it will run where it matters.

No test may require a Raspberry Pi to pass.
