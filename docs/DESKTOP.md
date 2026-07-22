# Desktop controller

A packaged push-to-talk app for Ubuntu and Windows. It shows every receiver you
have added, which are reachable, and lets you hold a button — or press a global
hotkey from any window — to talk to one.

```
controller/            the UI. Shared, unchanged, by both hosts.
   ├── served by the receiver  →  browser PWA on a phone
   └── loaded from disk        →  Electron desktop app
controller-desktop/    the Electron shell. Capabilities only, no intercom logic.
```

That split is the point. The desktop app adds a hotkey, a tray icon and mic
permission; it contains no protocol or push-to-talk code of its own. A fix to
the talk flow lands in the phone app and the desktop app simultaneously.

## Run from source

```bash
cd controller-desktop
npm install          # Electron, ~150 MB — see the note below
npm start
```

> **This install never touches the receiver.** `controller-desktop/` has its own
> `package.json`, so `npm install` at the repository root still installs exactly
> three packages. Electron must never end up on a Pi Zero, and it cannot.

Add a receiver with the **+** button: its Tailscale address and the `AUTH_TOKEN`
from its `.env`. A bare hostname is assumed to be `https`.

## Build installers

```bash
cd controller-desktop
npm run dist:linux    # → dist/*.deb and dist/*.AppImage
npm run dist:win      # → dist/*.exe (NSIS installer)
```

The icon is generated, not committed — `tools/make-icon.js` draws it and encodes
the PNG with `node:zlib`, so there is no binary blob in the repository and no
image library in the dependency tree. The `dist` scripts run it automatically.

Cross-building from Windows to Linux is unreliable for `.deb`; build the Linux
targets on Linux, or in a container.

## Two things worth knowing

### It does not need a TLS certificate

The single most annoying part of the browser setup — running `tailscale cert`
so `getUserMedia` will work — does not apply here. The shell serves the UI over
a custom `app://` scheme registered as **secure**, so the renderer is a secure
context and the microphone is available immediately. Permission is granted
programmatically for `media` and refused for everything else.

`file://` would not work: Chromium does not treat it as a secure context, and
it would be rejected exactly the way remote `http://` is.

### The global hotkey toggles, it does not hold

`F8` (override with `VOICE_INTERCOM_HOTKEY`) starts transmitting, and pressing
it again stops.

It cannot be true hold-to-talk. Electron's `globalShortcut` reports key
*presses* only — there is no global key-up event without a native input hook —
so binding hold-to-talk to it would start a transmission that never ends.
Rather than ship that, the global key toggles.

**Hold-to-talk still works inside the window**, with the button or the space
bar, because real `keyup` events exist there. If the floor is held and the app
is closed or crashes, the receiver reclaims it after five seconds of silence
anyway.

Adding true global hold-to-talk means a native module such as `uiohook-napi`,
which brings per-platform prebuilt binaries — a real cost against the project's
"clone and run" rule. It is deliberately left out.

## Behaviour

| | |
| --- | --- |
| **Closing the window** | Hides to the tray. An intercom you must relaunch to hear is not an intercom. Quit from the tray menu. |
| **Tray icon** | Click toggles the window. Right-click gives transmit, show/hide and quit. The tooltip shows when you are live. |
| **Second launch** | Focuses the running instance rather than starting a rival that fights for the hotkey. |
| **Start at login** | Checkbox in the Desktop panel. |
| **Losing focus** | Does *not* stop transmission — the whole point of the hotkey is talking while another window has focus. The browser build still stops on blur. |

## Why the receiver needed CORS

The PWA is served *by* the receiver, so it is same-origin and never needed it.
The desktop app loads its UI from `app://`, which makes every API call
cross-origin — so without CORS headers the desktop app cannot reach any
receiver at all.

`receiver/src/http/middleware/cors.js` allows any origin on `/api`. That is safe
here specifically because authentication is a **bearer token, never a cookie**:
no ambient authority exists for a hostile page to ride on, and everything
sensitive already requires the token. What stays readable cross-origin is
`/api/health` and `/api/identity`, which expose only a name, a version and a
capability list. Five tests in `tests/receiver.test.js` pin this down, including
that preflight must not require auth — browsers never send `Authorization` on
an `OPTIONS` request.

## Troubleshooting

**`Cannot read properties of undefined (reading 'app')` on startup** —
`ELECTRON_RUN_AS_NODE` is set in your environment, which makes Electron start as
a plain Node runtime so `require('electron')` returns a path string. Some
editors, terminals and CI images set it and every child process inherits it.
`npm start` goes through `dev.js`, which clears it; if you are launching the
binary directly, unset it first.

**The hotkey does nothing** — another application already owns `F8`. The shell
logs a warning at startup when registration fails. Pick another:

```bash
VOICE_INTERCOM_HOTKEY=F9 npm start
```

**A receiver shows as offline** — check both machines are up in the Tailscale
app, and that the address includes the port (`:8080`) unless you are fronting
it with `tailscale serve`.

**"That token was rejected"** — compare with `grep AUTH_TOKEN .env` on the
receiver. After 10 wrong attempts an address is locked out for 60 seconds and
even the correct token is refused.

**No microphone** — the shell grants permission automatically, so this is
almost always the OS level: check the system privacy settings for microphone
access, and that a capture device exists.
