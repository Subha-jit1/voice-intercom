#!/usr/bin/env bash
#
# Setup for Raspberry Pi OS, Debian and Ubuntu.
#
#   bash deploy/install.sh
#
# This installs system packages and dependencies. It changes no application
# code - the receiver that runs here is identical to the one running in Termux
# during development.
#
set -euo pipefail

echo "voice-intercom - Linux / Raspberry Pi setup"
echo "=========================================="

if [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *com.termux* ]]; then
  echo "This looks like Termux. Run instead:" >&2
  echo "  bash deploy/termux/install.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

echo
echo "[1/5] Installing system packages..."
sudo apt-get update
# alsa-utils gives us aplay and amixer, which is the whole audio dependency.
# curl is used by the watchdog timer's health check, not just for convenience.
sudo apt-get install -y alsa-utils curl git

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "[2/5] Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo
  echo "[2/5] Node.js $(node --version) already installed."
fi

echo
echo "[3/5] Adding $USER to the audio group..."
# Without this, opening the ALSA device fails with a permission error that
# looks like a missing sound card.
sudo usermod -aG audio "$USER"

echo
echo "[4/5] Installing npm dependencies..."
npm install --omit=dev

echo
echo "[5/5] Creating .env..."
if [ -f .env ]; then
  echo "  .env already exists, leaving it alone."
else
  cp .env.example .env
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=${TOKEN}|" .env
  echo "  Generated .env with a fresh AUTH_TOKEN."
fi

echo
echo "Done. Next steps:"
echo
echo "  1. Log out and back in so the 'audio' group membership takes effect."
echo "  2. Verify the platform and speaker:"
echo "       node tools/doctor.js"
echo "  3. Install the service:"
echo "       sudo cp deploy/systemd/voice-intercom.service /etc/systemd/system/"
echo "       sudo systemctl daemon-reload"
echo "       sudo systemctl enable --now voice-intercom"
echo
echo "  Your AUTH_TOKEN (needed by the controller):"
grep '^AUTH_TOKEN=' .env | cut -d= -f2
echo
