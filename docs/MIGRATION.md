# Raspberry Pi migration (Phase 4)

Replace Phone B with a Raspberry Pi Zero 2 W. Nothing else changes.

**No application code may be modified during this migration.** If you find
yourself editing anything under `receiver/` or `controller/` to make the Pi
work, that is a bug in the architecture — see [§ If you had to change
code](#if-you-had-to-change-code).

What legitimately changes:

| Changes | Stays identical |
| --- | --- |
| The hardware | All of `receiver/` |
| `.env` values | All of `controller/` |
| Process supervision (systemd instead of `run.sh`) | The protocol |
| Which `AudioService` the factory picks — automatically | The tests |

---

## 1. Raspberry Pi OS

Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In the
imager's advanced options, set the hostname, enable SSH and configure Wi-Fi
before writing — that saves needing a keyboard and monitor.

64-bit matters: it gets you current Node.js builds and better performance on the
Zero 2 W's Cortex-A53.

```bash
ssh pi@raspberrypi.local
sudo apt update && sudo apt full-upgrade -y
```

> **Power supply.** A Pi Zero 2 W on a weak supply throttles silently, and the
> first symptom is stuttering audio that looks exactly like a network problem.
> Use a 5V 2.5A+ supply. `node tools/doctor.js` reads the throttling flags and
> warns you.

---

## 2. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the printed URL to authorise. The Pi joins the same tailnet the phones
are already on.

Optional but recommended — the Pi is now a permanent device:

```bash
sudo tailscale up --ssh --advertise-tags=tag:intercom
```

---

## 3. Deploy

```bash
git clone <your-repo-url>
cd voice-intercom
bash deploy/install.sh
```

`deploy/install.sh` installs `alsa-utils` and Node.js 22, adds you to the
`audio` group, runs `npm install --omit=dev`, and generates `.env` with a fresh
token. It prints that token at the end.

Log out and back in so the `audio` group takes effect — otherwise opening the
ALSA device fails with a permission error that reads like a missing sound card.

---

## 4. Connect the speaker

The Zero 2 W has no analogue audio output. Pick one:

| Option | Notes |
| --- | --- |
| **USB sound card** | Simplest. Appears as a new ALSA card. |
| **I2S DAC HAT** (MAX98357A, PCM5102) | Best quality. Needs a `dtoverlay` line in `/boot/firmware/config.txt`. |
| **HDMI audio** | Works if something is plugged into HDMI. |
| **Bluetooth speaker** | Needs PulseAudio; set `AUDIO_BACKEND=linux`. |

Confirm the card is visible:

```bash
aplay -l
```

If more than one card is listed, or the default is wrong, set the device
explicitly in `.env`:

```ini
AUDIO_DEVICE=plughw:1,0
```

---

## 5. Verify before installing the service

```bash
node tools/doctor.js
```

Expected:

```
  Detected               raspberrypi
  Description            Raspberry Pi Zero 2 W Rev 1.0 (arm64)
  Backend selected       alsa
  Usable                 yes

  Required tools:
    [ok]      aplay
    [ok]      amixer
```

`Detected: raspberrypi` and `Backend selected: alsa` confirm the abstraction did
its job — that switch happened with no code change, purely from
`/proc/device-tree/model`.

Then run the same suite the phone ran:

```bash
npm test
TEST_AUDIO_BACKEND=alsa npm test    # re-runs the audio contract on real hardware
```

---

## 6. TLS

Same as development:

```bash
sudo tailscale cert intercom.tailnet-name.ts.net
```

Point `.env` at the files, or use `tailscale serve --bg --https=443
http://127.0.0.1:8080` and leave the TLS variables blank.

---

## 7. systemd

```bash
sudo cp deploy/systemd/voice-intercom.service /etc/systemd/system/
sudo systemctl edit --full voice-intercom     # adjust User= and paths if not `pi`
sudo systemctl daemon-reload
sudo systemctl enable --now voice-intercom

systemctl status voice-intercom
journalctl -u voice-intercom -f
```

The unit is hardened (`ProtectSystem=strict`, `NoNewPrivileges`, a 256 MB memory
cap for the 512 MB board) and grants access to `/dev/snd` and nothing else in
`/dev`.

---

## 8. Point the controller at the Pi

On Phone A, open the app, tap **⚙**, and change the address to the Pi's
Tailscale name plus the new token. Or tap **Forget this receiver** and set it up
fresh.

The PWA is served by the Pi now, so simply visiting
`https://intercom.tailnet-name.ts.net:8080` gets you the same app.

---

## Production validation

| # | Check | How |
| --- | --- | --- |
| 1 | Platform detected | `node tools/doctor.js` → `raspberrypi` / `alsa` |
| 2 | Tests pass on hardware | `TEST_AUDIO_BACKEND=alsa npm test` |
| 3 | Speaker works | **Test speaker** in the app |
| 4 | Push-to-talk works | Hold and talk from Phone A |
| 5 | No dropped frames | Diagnostics → `audio.stats.framesDropped` is 0 |
| 6 | Not throttling | Diagnostics → `sensors.piThrottling.underVoltage` is false |
| 7 | Survives restart | `sudo systemctl restart voice-intercom` |
| 8 | Survives reboot | `sudo reboot`, then transmit again |
| 9 | Reconnects | Turn Phone A's Wi-Fi off and on; the dot goes green by itself |
| 10 | Temperature sane | Diagnostics → `sensors.temperatureC` under ~70 °C |
| 11 | **Zero code changes** | `git status` is clean apart from `.env` |

Check 11 is the one that matters. If it passes, the architecture held.

---

## Troubleshooting

**`aplay: main:831: audio open error: No such file or directory`** — no sound
card. `aplay -l` to list; check the USB card or the `dtoverlay` for an I2S HAT.

**Permission denied on the audio device** — the user is not in the `audio`
group. `sudo usermod -aG audio pi`, then log out and back in. Under systemd,
`SupplementaryGroups=audio` in the unit covers it.

**Choppy audio** — check `underVoltage` first; it is the usual culprit. Then
`framesDropped`. Raising `AUDIO_MAX_QUEUE_FRAMES` trades latency for tolerance.

**Volume control does nothing** — `amixer scontrols` to see which controls
exist. The service tries `Master`, `PCM`, `Speaker`, `Headphone`, `Digital` in
that order and falls back to the first available. USB cards often expose only
`PCM`.

**Service will not start** — `journalctl -u voice-intercom -n 50`. Exit code 78
means a configuration error; the message names the offending variable.

---

## If you had to change code

That is a design failure, and it is worth fixing properly rather than patching.
Work out which rule was broken:

- **Platform-specific logic leaked upward.** It belongs behind `AudioService`
  or in `platform/detect.js`.
- **A backend was missing a capability.** Add it to the interface with a
  default implementation in the base class, and override where it differs.
- **Configuration was hardcoded.** It belongs in `.env` with a default in
  `loadConfig()`.
- **A hardware sensor was assumed to exist.** It belongs in
  `diagnostics/hardware.js`, returning `null` when absent.

Then add a test to `tests/audio.test.js` — written against the interface, so it
runs on every platform — and the same gap cannot reopen.
