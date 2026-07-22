#!/data/data/com.termux/files/usr/bin/bash
#
# One-time Termux setup for the development receiver (Phone B).
#
#   bash deploy/termux/install.sh
#
set -euo pipefail

echo "voice-intercom - Termux setup"
echo "============================="

if [ -z "${PREFIX:-}" ] || [[ "$PREFIX" != *com.termux* ]]; then
  echo "This script is for Termux. On Debian/Ubuntu/Raspberry Pi OS run:" >&2
  echo "  bash deploy/install.sh" >&2
  exit 1
fi

echo
echo "[1/4] Updating packages..."
pkg update -y
pkg upgrade -y

echo
echo "[2/4] Installing Node.js, PulseAudio and tools..."
# pulseaudio provides the module-sles-sink bridge to Android's audio stack;
# pulseaudio-utils provides paplay, which is how audio is actually played.
# curl is used by run.sh's hang watchdog, not just for convenience.
pkg install -y nodejs-lts pulseaudio pulseaudio-utils termux-api git curl

echo
echo "[3/4] Installing npm dependencies..."
cd "$(dirname "$0")/../.."
npm install --omit=dev

echo
echo "[4/4] Creating .env..."
if [ -f .env ]; then
  echo "  .env already exists, leaving it alone."
else
  cp .env.example .env
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  # Portable in-place edit: BSD and GNU sed disagree about -i.
  sed "s|^AUTH_TOKEN=.*|AUTH_TOKEN=${TOKEN}|" .env > .env.tmp && mv .env.tmp .env
  echo "  Generated .env with a fresh AUTH_TOKEN."
fi

echo
echo "Done. Next steps:"
echo
echo "  1. Keep Termux alive in the background:"
echo "       termux-wake-lock"
echo
echo "  2. Check the platform is detected correctly:"
echo "       node tools/doctor.js"
echo
echo "  3. Start the receiver:"
echo "       bash deploy/termux/run.sh"
echo
echo "  Your AUTH_TOKEN (needed by the controller):"
grep '^AUTH_TOKEN=' .env | cut -d= -f2
echo
