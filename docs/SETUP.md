# Complete setup guide

From nothing to a working intercom. Every command is here — follow it top to
bottom and do not skip a part.

Notation: replace anything in `ANGLE BRACKETS` with your own value. Lines
starting with `$` are commands you type; everything else is output.

---

## What you are building

Two roles, connected by Tailscale:

- **Receiver** — the box with the speaker. Runs a small Node.js server, always
  on, no screen needed. Today it can be a spare Android phone; later a
  Raspberry Pi or any Ubuntu machine. **The software is identical on all of
  them** — swapping the hardware is a redeploy, not a rewrite.
- **Controller** — what you hold the talk button on. Either a **desktop app**
  (Ubuntu/Windows) or an **Android app**.

You can have several controllers and several receivers. One person talks at a
time, per receiver.

---

## Step 0 — Choose your combination

**Do this first. It decides whether you need HTTPS, which is the single thing
people get stuck on.**

| Receiver | Controller | HTTPS needed? | Difficulty |
| --- | --- | --- | --- |
| Android phone (Termux) | **Desktop app** | **No** | Easiest — start here |
| Ubuntu / Debian / Pi | **Desktop app** | **No** | Easy |
| Ubuntu / Debian / Pi | **Android app** | **Yes** | Medium |
| Android phone (Termux) | Android app | Yes — **but not practical** | Avoid |

Why: web browsers refuse microphone access to a remote `http://` page, so the
Android controller needs a real certificate on the receiver. The desktop app is
not a browser — it grants its own microphone permission — so it works over
plain HTTP and needs no certificate anywhere.

Certificates come from `tailscale cert` / `tailscale serve`, which are part of
the Tailscale **command line**. The Tailscale **Android app has no command
line**, so a phone acting as receiver cannot easily obtain one. That is the
whole reason the last row is impractical.

> **Recommended path if you are unsure:** phone receiver + desktop controller
> now (Parts 1, 2A, 4A, 5A, 6). Move the receiver to a Pi later with Part 2B —
> the controller does not change.

---

## Part 1 — Tailscale on both devices

Tailscale is the private network that lets the controller reach the receiver
from anywhere, with no port forwarding and no public exposure.

### 1.1 Create an account

Sign up at [tailscale.com](https://tailscale.com) — the free tier is more than
enough.

### 1.2 Install on the receiver device

**Android phone:** install **Tailscale** from the Play Store, open it, sign in,
and toggle it **on**.

**Ubuntu / Debian / Raspberry Pi:**

```bash
$ curl -fsSL https://tailscale.com/install.sh | sh
$ sudo tailscale up
```

`tailscale up` prints a URL. Open it in any browser and approve the machine.
This is a **one-time** action — the login persists across reboots, and
`tailscaled` reconnects on its own after a network outage.

### 1.3 Install on the controller device

Same thing: Play Store app for Android, or the install script for Ubuntu. On
Windows, download the installer from
[tailscale.com/download](https://tailscale.com/download).

### 1.4 Turn on MagicDNS

In the [admin console → DNS](https://login.tailscale.com/admin/dns), enable
**MagicDNS**. This gives every machine a stable name instead of an IP that can
change.

### 1.5 Write down the receiver's name

In the Tailscale admin console, find the receiver machine. Its name looks like:

```
my-receiver.tailnet-name.ts.net
```

**Write this down. You will need it several times.** Referred to below as
`RECEIVER-NAME`.

### 1.6 Check they can see each other

From the controller device:

```bash
$ tailscale status
```

Both machines should be listed. On Android, both appear in the app's device
list.

---

## Part 2 — Install the receiver

Do **2A** or **2B**, not both.

### Option 2A — Android phone (Termux)

Use a phone you can leave plugged in. It will be your receiver.

#### 2A.1 Install Termux — from GitHub

You need three apps. **Do not use the Play Store version** — the Termux project
abandoned it years ago because Android's policy changes broke it, and its
packages are too old to work.

Two official sources exist. Pick one and use it for **all three** apps:

| Source | Signed by | Notes |
| --- | --- | --- |
| **GitHub Releases** | the Termux developers | Straight from the project. Recommended. |
| F-Droid | F-Droid's build servers | Also official, but F-Droid rebuilds and re-signs with its own key. |

If you would rather not add F-Droid, use GitHub — you lose nothing. The APKs
there are built and signed by the Termux developers themselves, with no third
party in between.

> ### ⚠ All three apps must come from the same source
>
> Android only lets apps talk to each other when their signatures match. The
> F-Droid and GitHub builds are signed with **different keys**, so mixing them
> means Termux:API and Termux:Boot install fine and then silently do nothing —
> no error, just a wake lock that never works and a receiver that never starts
> at boot.
>
> If you already have Termux from one source, uninstall it before switching.

**Download from these three pages:**

1. **Termux** — [github.com/termux/termux-app/releases](https://github.com/termux/termux-app/releases)
2. **Termux:API** — [github.com/termux/termux-api/releases](https://github.com/termux/termux-api/releases) (provides the wake lock)
3. **Termux:Boot** — [github.com/termux/termux-boot/releases](https://github.com/termux/termux-boot/releases) (starts the receiver at boot)

On each page, open the newest release and download the `.apk` from **Assets**.
Choose the `universal` file if there is one — it works on every phone. If only
per-architecture files are listed, `arm64-v8a` is right for any phone made in
roughly the last seven years.

> The filenames contain the word `debug` (for example
> `termux-app_…-github-debug_universal.apk`). That is normal and expected — it
> is how the Termux project labels its GitHub build channel, not a test build.

**Then install them:**

Android will ask permission for your browser to install unknown apps the first
time — allow it, then install all three APKs.

Finally: **open Termux:Boot once.** It shows a blank screen; that is correct.
Android will not grant boot permission until the app has been launched at least
once.

> **Would you rather skip Termux entirely?** You do not have to use a phone as
> the receiver. Any spare Linux machine — an old laptop, a mini PC, a Raspberry
> Pi you already own — works today with **Option 2B** below, and needs none of
> this. The receiver software is identical either way.

#### 2A.2 Get the code

Open Termux and run:

```bash
$ pkg update -y && pkg upgrade -y
$ pkg install -y git nodejs-lts
$ cd ~
$ git clone <YOUR-REPO-URL> voice-intercom
$ cd voice-intercom
```

#### 2A.3 Run the installer

```bash
$ bash deploy/termux/install.sh
```

This installs PulseAudio, `paplay`, `termux-api` and `curl`, runs
`npm install`, creates `.env`, and prints your access token.

**Copy the token it prints.** It looks like:

```
Your AUTH_TOKEN (needed by the controller):
f2e65081c636273968f76081a7973a31062a80a08cd2cfb78629ce5f4099cd7d
```

You can always see it again with:

```bash
$ grep AUTH_TOKEN ~/voice-intercom/.env
```

#### 2A.4 Check the phone can play audio

```bash
$ node tools/doctor.js
```

You want:

```
  Detected               android
  Backend selected       android
  Usable                 yes
```

If `Usable` says `NO`, the report names the missing package. Usually:

```bash
$ pkg install pulseaudio
```

> On Termux, `paplay` and `pactl` are part of the **`pulseaudio`** package.
> There is no `pulseaudio-utils` here — that is a Debian/Ubuntu package name,
> and asking for it gives `E: Unable to locate package pulseaudio-utils`.

#### 2A.5 Start it

```bash
$ bash deploy/termux/run.sh
```

Leave this running. You should see:

```
Wake lock acquired.
Starting receiver on port 8080 (Ctrl-C to stop)...
{"level":"info","message":"receiver listening",...}
```

Now go to **Part 4A** to make it survive reboots.

---

### Option 2B — Ubuntu, Debian or Raspberry Pi

#### 2B.1 Prepare the machine

**On a Raspberry Pi**, flash **Raspberry Pi OS Lite (64-bit)** with Raspberry
Pi Imager. In the imager's advanced options set the hostname, enable SSH and
configure Wi-Fi *before* writing — that saves needing a keyboard and monitor.

> **Power supply matters.** A Pi Zero 2 W on a weak supply throttles silently,
> and the first symptom is stuttering audio that looks like a network problem.
> Use a 5V 2.5A or better supply.

**On any Ubuntu/Debian machine**, nothing special is needed.

```bash
$ sudo apt update && sudo apt full-upgrade -y
```

#### 2B.2 Connect the speaker

Plug in a USB sound card, an I2S DAC HAT, or an HDMI display with speakers.
Then confirm Linux sees it:

```bash
$ aplay -l
```

You should see at least one `card N:` line. If you see none, fix that before
continuing — no amount of software will help.

#### 2B.3 Get the code and install

```bash
$ cd ~
$ git clone <YOUR-REPO-URL> voice-intercom
$ cd voice-intercom
$ bash deploy/install.sh
```

This installs `alsa-utils`, `curl` and Node.js 22, adds you to the `audio`
group, runs `npm install`, creates `.env`, and prints your token.

**Copy the token it prints.** To see it again:

```bash
$ grep AUTH_TOKEN ~/voice-intercom/.env
```

#### 2B.4 Log out and back in

Required — the `audio` group membership does not apply to your current shell.
Without it, opening the sound device fails with a permission error that looks
like a missing sound card.

```bash
$ exit
```

Then reconnect and:

```bash
$ cd ~/voice-intercom
$ groups          # should now include: audio
```

#### 2B.5 Check it can play audio

```bash
$ node tools/doctor.js
```

You want:

```
  Detected               raspberrypi          (or "linux")
  Backend selected       alsa
  Usable                 yes

  Required tools:
    [ok]      aplay
    [ok]      amixer
```

If more than one sound card is listed and the wrong one is default, set it in
`.env`:

```bash
$ nano .env
```

```ini
AUDIO_DEVICE=plughw:1,0
```

#### 2B.6 Start it once by hand

```bash
$ npm start
```

Confirm it prints `receiver listening`, then stop it with `Ctrl-C`. Part 4B
turns it into a service.

---

## Part 3 — HTTPS

**Skip this entire part if you are using the desktop controller.** It is only
needed for the Android controller.

This requires a Linux receiver (Part 2B). Tailscale's CLI does not exist on
Android.

### 3.1 Enable HTTPS for your tailnet

In the [admin console → DNS](https://login.tailscale.com/admin/dns), scroll to
**HTTPS Certificates** and enable it.

### 3.2 Let Tailscale terminate TLS

```bash
$ sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
```

This is the **recommended** approach because Tailscale obtains *and
automatically renews* the certificate. The alternative, `tailscale cert`,
produces files that expire after 90 days and will silently break your intercom
months later unless you renew them yourself.

Check it:

```bash
$ tailscale serve status
```

### 3.3 Lock the receiver to loopback

Since Tailscale now fronts it, the receiver no longer needs to listen on the
network directly:

```bash
$ nano ~/voice-intercom/.env
```

```ini
HOST=127.0.0.1
```

Restart the receiver afterwards (`sudo systemctl restart voice-intercom` once
Part 4B is done).

Your receiver is now reachable at **`https://RECEIVER-NAME`** — port 443, so no
port number is needed in the address.

---

## Part 4 — Make it always-on

This is what makes it an appliance: it starts itself after a power cut,
restarts itself if it crashes, and restarts itself if it hangs.

### Option 4A — Android (Termux)

#### 4A.1 Start at boot

```bash
$ mkdir -p ~/.termux/boot
$ ln -sf ~/voice-intercom/deploy/termux/boot.sh ~/.termux/boot/voice-intercom
$ chmod +x ~/voice-intercom/deploy/termux/boot.sh
```

Confirm you opened the **Termux:Boot** app at least once (step 2A.1), or
Android will not run it.

#### 4A.2 Stop Android from killing it

In Android **Settings → Apps → Termux → Battery**, choose **Unrestricted** (the
wording varies by manufacturer — Samsung, Xiaomi and OnePlus are especially
aggressive). Do the same for **Termux:Boot**.

This is not optional. Without it Android will freeze the process within minutes
of the screen going off.

#### 4A.3 Keep it powered

Leave the phone on a charger. Optionally set the screen to stay off — the wake
lock keeps the CPU running regardless.

#### 4A.4 Test it

Reboot the phone. Wait two minutes, then from another device on your tailnet:

```bash
$ curl http://RECEIVER-NAME:8080/api/health
{"status":"ok","name":"voice-intercom","version":"0.1.0","uptimeSeconds":94}
```

If that answers, boot-start works.

**What is now automatic:** `run.sh` restarts the receiver if it exits, and
polls `/api/health` every 20 seconds — three consecutive failures and it kills
and restarts the process. Tailscale reconnects on its own after any network
drop, and the controller reconnects with backoff.

---

### Option 4B — Linux / Raspberry Pi (systemd)

#### 4B.1 Install the service

```bash
$ sudo cp deploy/systemd/voice-intercom.service /etc/systemd/system/
```

If your username is not `pi` or your path is not `/home/pi/voice-intercom`,
edit it:

```bash
$ sudo systemctl edit --full voice-intercom
```

Change `User=`, `Group=`, `WorkingDirectory=` and `ReadWritePaths=` to match.
Check your values with `whoami` and `pwd`.

#### 4B.2 Enable it

```bash
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now voice-intercom
$ systemctl status voice-intercom
```

You want `Active: active (running)`.

#### 4B.3 Install the hang watchdog

`Restart=always` covers a receiver that *crashes*. This covers the nastier
case — one that is still running but has stopped answering, which systemd
cannot detect on its own.

```bash
$ sudo cp deploy/systemd/voice-intercom-watchdog.service /etc/systemd/system/
$ sudo cp deploy/systemd/voice-intercom-watchdog.timer   /etc/systemd/system/
$ sudo systemctl daemon-reload
$ sudo systemctl enable --now voice-intercom-watchdog.timer
$ systemctl list-timers voice-intercom-watchdog.timer
```

It checks `/api/health` every minute and restarts the receiver if there is no
healthy answer. If you changed `PORT` in `.env`, edit the `HEALTH_URL` line in
`voice-intercom-watchdog.service` to match.

#### 4B.4 Test it properly

Do all three — each proves a different failure mode is handled:

```bash
# 1. Survives a crash
$ sudo systemctl kill -s SIGKILL voice-intercom
$ sleep 6 && systemctl is-active voice-intercom      # → active

# 2. Survives a reboot
$ sudo reboot
#    wait, reconnect, then:
$ systemctl is-active voice-intercom                 # → active

# 3. Survives a network outage
#    Unplug the network / disable Wi-Fi for a minute, plug it back in.
$ curl http://127.0.0.1:8080/api/health              # → still ok
```

---

## Part 5 — Install a controller

### Option 5A — Desktop app (Ubuntu or Windows)

**No certificate needed.** The desktop app grants its own microphone
permission, so it talks to a plain-HTTP receiver directly.

#### 5A.1 Run it from source

On the computer you want to talk from:

```bash
$ cd voice-intercom/controller-desktop
$ npm install
$ npm start
```

The first `npm install` downloads Electron (~150 MB) and takes a few minutes.
It installs only into `controller-desktop/` and never touches the receiver.

#### 5A.2 Or build an installer

```bash
$ npm run dist:linux     # → dist/*.deb and dist/*.AppImage
$ npm run dist:win       # → dist/*.exe
```

Then install the package normally. Build Linux targets on Linux — cross-building
`.deb` from Windows is unreliable.

#### 5A.3 Add your receiver

1. Click **+** in the top right.
2. **Address:** `RECEIVER-NAME:8080`
   (or just `RECEIVER-NAME` if you did Part 3 with `tailscale serve`)
3. **Access token:** the token from Part 2.
4. Click **Add receiver**.

A green dot means connected. Hold the big button and talk.

#### 5A.4 Optional niceties

- **Global hotkey:** `F8` toggles transmission from any window — you do not
  need the app focused. It *toggles* rather than holds; press once to start,
  once to stop. Change it with `VOICE_INTERCOM_HOTKEY=F9 npm start`.
- **Start at login:** the checkbox in the Desktop panel.
- **Tray:** closing the window hides it to the tray. Quit from the tray menu.

---

### Option 5B — Android app

**This requires Part 3 (HTTPS) to be done.**

#### 5B.1 Install it

1. Open **Chrome** on the phone.
2. Go to **`https://RECEIVER-NAME`**.
3. Chrome menu (⋮) → **Install app**.
4. Open it from the app drawer. It runs standalone, with its own icon.

> If Chrome only offers "Add shortcut to Home screen" instead of "Install app",
> the page is not on a proper HTTPS origin. Go back to Part 3.

#### 5B.2 Add your receiver

1. Tap **+**.
2. **Address:** `RECEIVER-NAME`
3. **Access token:** the token from Part 2.
4. Tap **Add receiver**.
5. Hold the button. Grant microphone permission when asked — once only.

#### 5B.3 Stop Android killing it

**Settings → Apps → Voice Intercom → Battery → Unrestricted.**

---

## Part 6 — Verify everything

Work down this list. Each step isolates a different layer, so the first failure
tells you where the problem is.

| # | Check | How | Expected |
| --- | --- | --- | --- |
| 1 | Receiver is alive | `curl http://RECEIVER-NAME:8080/api/health` | `{"status":"ok",...}` |
| 2 | Tailscale reaches it | run check 1 from the *controller* device | same |
| 3 | Token is right | Controller shows a **green** dot | Connected |
| 4 | Speaker works | Tap **Test speaker** | A tone from the receiver |
| 5 | Microphone works | Hold the button | Level meter moves |
| 6 | Audio arrives | Hold and speak | You hear it from the speaker |
| 7 | Latency is sane | Look at the **Latency** stat | Under ~100 ms on a LAN |
| 8 | No audio dropped | Diagnostics → `audio.stats.framesDropped` | `0` |
| 9 | Backend is right | Diagnostics → `audio.backend` | `android` or `alsa` |
| 10 | Survives restart | Reboot the receiver, wait 2 min, retry check 1 | still ok |
| 11 | Reconnects | Turn controller Wi-Fi off and on | dot returns to green unaided |
| 12 | Pi is not throttling | Diagnostics → `sensors.piThrottling.underVoltage` | `false` |

If check 4 passes but check 6 fails, the speaker is fine and the problem is
capture — almost always the HTTPS issue from Part 3.

---

## Part 7 — Day-to-day

### Where are the logs?

**Linux/Pi:**
```bash
$ journalctl -u voice-intercom -f
```

**Termux:**
```bash
$ tail -f ~/voice-intercom/boot.log
```

**From either controller:** the **Receiver logs** panel, with **Follow** ticked.
No SSH needed.

### Restart it

```bash
$ sudo systemctl restart voice-intercom        # Linux/Pi
```
On Termux, `Ctrl-C` in the Termux session and re-run `run.sh`, or reboot.

### Update to a new version

```bash
$ cd ~/voice-intercom
$ git pull
$ npm install --omit=dev
$ sudo systemctl restart voice-intercom        # Linux/Pi
```

### Change the token

```bash
$ node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Put the result in `.env` as `AUTH_TOKEN=`, restart the receiver, then update
each controller (**Remove this receiver**, then add it again).

### Move from the phone to a Raspberry Pi

Do Part 2B and Part 4B on the Pi. In the controller, add the Pi as a second
receiver — you can keep both and pick between them. **No application code
changes.** See [MIGRATION.md](MIGRATION.md) for the full checklist.

---

## Part 8 — Troubleshooting

### "Microphone access needs a secure context"

You are using the Android/browser controller over `http://`. Either do Part 3,
or use the desktop app, which does not need it.

### Chrome offers "Add shortcut" instead of "Install app"

Same cause — the origin is not proper HTTPS. Part 3.

### The receiver shows as offline in the controller

Work through these in order:

```bash
# On the receiver — is it running at all?
$ curl http://127.0.0.1:8080/api/health

# Is Tailscale up on both ends?
$ tailscale status

# From the controller device — can it reach the receiver?
$ curl http://RECEIVER-NAME:8080/api/health
```

If the first works and the third does not, it is a Tailscale problem, not a
receiver problem.

Also check the address includes `:8080` — unless you did Part 3, in which case
it must **not**.

### "That token was rejected"

```bash
$ grep AUTH_TOKEN ~/voice-intercom/.env
```

Compare character for character. After 10 wrong attempts the address is locked
out for 60 seconds and even the correct token is refused — wait a minute.

### Test tone plays nothing

```bash
$ node tools/doctor.js
```

It names the missing piece. Most common:

- **Termux:** PulseAudio is not running.
  ```bash
  $ pulseaudio --start --exit-idle-time=-1
  ```
  The receiver loads the Android output sink itself if one is missing. Do not
  add `--load=module-sles-sink` here — Termux's default config usually loads it
  already, and doing both leaves you with two duplicate sinks.
- **Linux/Pi:** you are not in the `audio` group. `sudo usermod -aG audio $USER`,
  then log out and back in.
- **Linux/Pi:** wrong card. `aplay -l`, then set `AUDIO_DEVICE=plughw:N,0`.

### Audio is choppy

Check, in this order:

1. Diagnostics → `sensors.piThrottling.underVoltage` — if `true`, your power
   supply is the problem. Nothing else will fix it.
2. Diagnostics → `audio.stats.framesDropped` — if climbing, raise
   `AUDIO_MAX_QUEUE_FRAMES` in `.env` (trades latency for tolerance).
3. Diagnostics → `resources.loadAverage` — something else is eating the CPU.

### The receiver stops working after a few hours (Termux)

Android suspended it. Confirm the wake lock is held and that Termux **and**
Termux:Boot are set to **Unrestricted** battery usage (step 4A.2). Some phones
also need Termux pinned in the recent-apps list.

### Volume control does nothing

Some sound cards expose no mixer; the API returns `501` and this is expected.
Check what exists:

```bash
$ amixer scontrols
```

The receiver tries `Master`, `PCM`, `Speaker`, `Headphone`, `Digital` in that
order. USB cards often expose only `PCM`.

### Service will not start (Linux/Pi)

```bash
$ journalctl -u voice-intercom -n 50 --no-pager
```

Exit code **78** means a configuration error — the message names the offending
variable in `.env`.

### Start over

```bash
$ cd ~/voice-intercom
$ rm .env
$ bash deploy/install.sh          # or deploy/termux/install.sh
```

In the controller, use **Remove this receiver** and add it again with the new
token.

---

## Reference

| | |
| --- | --- |
| Receiver config | `~/voice-intercom/.env` |
| All settings explained | `.env.example` |
| Self-check tool | `node tools/doctor.js` |
| Test without a browser | `node tools/ptt-cli.js --url ws://RECEIVER-NAME:8080/ws --token TOKEN` |
| Run the test suite | `npm test` |
| Default port | `8080` |
| Health endpoint (no auth) | `/api/health` |

Related documents: [ARCHITECTURE.md](ARCHITECTURE.md) ·
[DESKTOP.md](DESKTOP.md) · [MIGRATION.md](MIGRATION.md) · [API.md](API.md) ·
[TESTING.md](TESTING.md)
