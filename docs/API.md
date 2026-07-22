# API reference

Base URL is the receiver's address, e.g. `https://intercom.tailnet-name.ts.net:8080`.

## Authentication

A single shared token, `AUTH_TOKEN` from the receiver's `.env`.

```http
Authorization: Bearer <token>
```

WebSocket clients cannot set headers, so the upgrade accepts the token as a
subprotocol instead — `bearer.<token>` — which also keeps it out of proxy access
logs. A `?token=` query parameter is accepted as a last resort.

After `AUTH_MAX_FAILURES` (default 10) failures, an address is locked out for
`AUTH_LOCKOUT_MS` (default 60 s) and receives `429` with a `Retry-After` header,
even for the correct token.

---

## REST

### Public

#### `GET /api/health`

Unauthenticated so uptime monitors and `systemd` health checks work without the
secret.

```json
{ "status": "ok", "name": "living-room", "version": "0.1.0", "uptimeSeconds": 3412 }
```

#### `GET /api/identity`

Discovery. Enough for a controller to recognise a receiver it has found on the
tailnet; nothing more.

```json
{
  "name": "living-room",
  "version": "0.1.0",
  "platform": "raspberrypi",
  "capabilities": ["ptt", "diagnostics", "logs", "volume", "speaker-test"],
  "audio": { "sampleRate": 16000, "channels": 1, "bitDepth": 16 }
}
```

#### `POST /api/auth/verify`

Requires a valid token; returns `401` otherwise. Lets the controller validate a
token at setup time so a typo shows up on the settings screen rather than as a
dead talk button.

```json
{ "ok": true, "receiver": { "...": "identity payload" } }
```

### Authenticated

#### `GET /api/diagnostics`

The full picture — the endpoint to reach for when something is wrong.

```json
{
  "receiver":  { "name": "living-room", "version": "0.1.0", "uptimeSeconds": 3412 },
  "platform":  { "id": "raspberrypi", "label": "Raspberry Pi Zero 2 W Rev 1.0 (arm64)",
                 "isTermux": false, "isRaspberryPi": true, "nodeVersion": "v22.11.0" },
  "resources": { "loadAverage": [0.1, 0.08, 0.05], "freeMemoryMB": 310,
                 "processRssMB": 48 },
  "audio":     { "backend": "alsa", "streaming": false, "currentVolume": 80,
                 "selectionReason": "auto-detected on Raspberry Pi Zero 2 W",
                 "stats": { "framesReceived": 15230, "framesDropped": 0,
                            "sinkRestarts": 0 },
                 "probe": { "available": true, "devices": ["card 1: Device [USB Audio]"] } },
  "ptt":       { "connectedClients": 1, "transmissions": 42, "speaker": null },
  "auth":      { "granted": 12, "denied": 0, "lockouts": 0 },
  "network":   [ { "interface": "tailscale0", "address": "100.94.3.17",
                   "tailscale": true } ],
  "security":  { "tls": true, "microphoneCapable": true },
  "sensors":   { "temperatureC": 44.6,
                 "piThrottling": { "underVoltage": false, "throttled": false } }
}
```

`sensors` is present only where the readings exist. `audio.stats.framesDropped`
and `sensors.piThrottling.underVoltage` are the two fields worth checking first
when audio is choppy.

#### `GET /api/config`

Effective configuration with secrets redacted — `auth.token` reads
`"set (64 chars)"`.

#### `GET /api/logs`

| Query | Default | Meaning |
| --- | --- | --- |
| `limit` | 100 | Max records (capped at 1000) |
| `level` | – | Minimum level: `trace`…`error` |
| `since` | – | Only records with `id` greater than this — for tailing |

```json
{ "records": [
  { "id": 412, "time": "2026-07-21T18:09:09.592Z", "level": "info",
    "scope": "receiver:ptt", "message": "transmission started",
    "fields": { "clientId": "…", "session": 7 } }
] }
```

Served from an in-memory ring buffer (`LOG_BUFFER_SIZE`, default 500), so a
headless receiver is debuggable without SSH.

#### `GET /api/audio`

Current backend, format, volume and counters.

#### `POST /api/audio/test`

```json
{ "frequency": 440, "durationMs": 900 }
```

Both optional; clamped to 100–4000 Hz and 100–5000 ms. Returns `503` if the
device cannot be opened.

```json
{ "ok": true, "backend": "alsa", "bytes": 28800, "elapsedMs": 912 }
```

The tone is synthesised in JavaScript and played through the same path as real
speech, so a successful test means the whole playback chain works.

#### `POST /api/audio/volume`

```json
{ "percent": 75 }
```

`400` if out of range; **`501`** if the backend has no mixer — a limitation, not
a failure.

#### `POST /api/audio/stop`

Stops playback and releases the device.

### Errors

```json
{ "error": "invalid token" }
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid parameters |
| `401` | Missing or wrong token |
| `404` | Unknown endpoint (JSON, never the PWA) |
| `429` | Locked out; see `Retry-After` |
| `500` | Unhandled error |
| `501` | Backend does not support this |
| `503` | Audio device unavailable |

---

## WebSocket

```
wss://<receiver>/ws
Sec-WebSocket-Protocol: voice-intercom.v1, bearer.<token>
```

Authentication happens **during the upgrade**. A bad token gets `401` and no
socket is ever opened.

- **Text frames** — JSON control messages.
- **Binary frames** — raw PCM, signed 16-bit little endian, at the format from
  `welcome`. 20 ms per frame (640 bytes at 16 kHz mono) is the expected chunking.

### Client → server

| Message | Payload | Notes |
| --- | --- | --- |
| `hello` | `{ name }` | Display name, ≤64 chars |
| `ptt.start` | `{ format? }` | Requests the floor |
| `ptt.stop` | – | Releases the floor |
| `ping` | `{ t }` | `t` is echoed back for round-trip timing |

A proposed `format` that does not match the receiver's is logged and ignored —
the receiver's format wins. Resampling is not done on the receiver, because it
is not free on a Pi Zero.

### Server → client

| Message | Payload |
| --- | --- |
| `welcome` | `{ clientId, receiver: {name, version}, format, state }` |
| `ptt.granted` | `{ session, format }` |
| `ptt.denied` | `{ reason: "busy" \| "audio-unavailable", holder?, detail? }` |
| `ptt.ended` | `{ reason: "released" \| "disconnected" \| "timeout" \| "audio-error" }` |
| `state` | `{ speaker, clients }` — broadcast on every change |
| `pong` | `{ t, serverTime }` |
| `error` | `{ message }` |

`format` is `{ sampleRate: 16000, channels: 1, bitDepth: 16, encoding: "pcm_s16le" }`.

### Floor control

One talker at a time. The floor is released when the holder sends `ptt.stop`,
disconnects, or **goes silent for 5 seconds** — that last rule is what stops a
backgrounded or crashed phone from wedging the receiver.

Audio from a client that does not hold the floor is discarded and counted as
`ptt.framesFromNonSpeaker`.

### Keepalive

The server pings every 15 s and terminates clients that miss two in a row. The
reference controller also sends an application-level `ping` every 5 s to
measure latency.

### Example

```js
const ws = new WebSocket('wss://receiver:8080/ws',
  ['voice-intercom.v1', `bearer.${token}`]);

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'welcome') {
    ws.send(JSON.stringify({ type: 'hello', name: 'my-controller' }));
    ws.send(JSON.stringify({ type: 'ptt.start', format: message.format }));
  }

  if (message.type === 'ptt.granted') {
    ws.send(pcmChunk);                                  // 640-byte Int16 frames
    ws.send(JSON.stringify({ type: 'ptt.stop' }));
  }
};
```

A complete, working client is `tools/ptt-cli.js` — under 150 lines, and it runs
on every platform the receiver does.
