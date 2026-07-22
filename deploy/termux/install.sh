#!/data/data/com.termux/files/usr/bin/bash
#
# One-time Termux setup for the receiver.
#
#   bash deploy/termux/install.sh
#
# Safe to re-run: it skips an existing .env and reinstalls nothing that is
# already present.
#
# Note: no `set -e`. A single unavailable package must not abort the whole
# script and leave the install half-finished - it reports what failed at the
# end instead.
set -uo pipefail

echo "voice-intercom - Termux setup"
echo "============================="

if [ -z "${PREFIX:-}" ] || [[ "$PREFIX" != *com.termux* ]]; then
  echo "This script is for Termux. On Debian/Ubuntu/Raspberry Pi OS run:" >&2
  echo "  bash deploy/install.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/../.." || exit 1

FAILED_PACKAGES=()

# Install one package, recording rather than aborting on failure.
try_install() {
  local package="$1"
  printf '  %-16s ' "$package"
  if pkg install -y "$package" >/dev/null 2>&1; then
    echo "ok"
    return 0
  fi
  echo "FAILED"
  FAILED_PACKAGES+=("$package")
  return 1
}

# --- 1. Package lists -------------------------------------------------------

echo
echo "[1/5] Updating package lists..."
if ! pkg update -y >/dev/null 2>&1; then
  echo "  WARNING: could not update package lists."
  echo "  If downloads keep failing, pick a closer mirror with: termux-change-repo"
fi

# --- 2. Packages ------------------------------------------------------------

echo
echo "[2/5] Installing packages..."

# Node.js. The LTS package is preferred; fall back to the current one.
if ! command -v node >/dev/null 2>&1; then
  try_install nodejs-lts || try_install nodejs
else
  printf '  %-16s %s\n' "nodejs" "already present ($(node --version))"
fi

# IMPORTANT: on Termux, paplay and pactl ship INSIDE the pulseaudio package.
# There is no separate pulseaudio-utils here - that is a Debian package name,
# and asking for it makes apt fail with "Unable to locate package".
try_install pulseaudio

try_install termux-api      # termux-wake-lock, termux-volume
try_install curl            # used by run.sh's hang watchdog
try_install git

# --- 3. Verify the tools that actually matter -------------------------------

echo
echo "[3/5] Checking required tools..."

MISSING_TOOLS=()
check_tool() {
  local tool="$1" why="$2"
  printf '  %-18s ' "$tool"
  if command -v "$tool" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "MISSING  ($why)"
    MISSING_TOOLS+=("$tool")
  fi
}

check_tool node    "required - the receiver will not run"
check_tool npm     "required - cannot install dependencies"
check_tool paplay  "required - audio playback"
check_tool pactl   "required - volume control"
check_tool pulseaudio "required - the Android audio bridge"
check_tool termux-wake-lock "recommended - Android will suspend the receiver without it"
check_tool curl    "recommended - the hang watchdog needs it"

# --- 4. Dependencies --------------------------------------------------------

echo
echo "[4/5] Installing npm dependencies..."
if command -v npm >/dev/null 2>&1; then
  if npm install --omit=dev; then
    echo "  ok"
  else
    echo "  FAILED - see the npm output above."
  fi
else
  echo "  SKIPPED - npm is not installed."
fi

# --- 5. Configuration -------------------------------------------------------

echo
echo "[5/5] Creating .env..."
if [ -f .env ]; then
  echo "  .env already exists, leaving it alone."
elif command -v node >/dev/null 2>&1; then
  cp .env.example .env
  TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  # Portable in-place edit: BSD and GNU sed disagree about -i.
  sed "s|^AUTH_TOKEN=.*|AUTH_TOKEN=${TOKEN}|" .env > .env.tmp && mv .env.tmp .env
  echo "  Generated .env with a fresh AUTH_TOKEN."
else
  echo "  SKIPPED - node is needed to generate a token."
fi

# --- Report -----------------------------------------------------------------

echo
echo "============================="

if [ ${#FAILED_PACKAGES[@]} -gt 0 ]; then
  echo
  echo "These packages failed to install:"
  for package in "${FAILED_PACKAGES[@]}"; do echo "  - ${package}"; done
  echo
  echo "Try a different mirror and re-run this script:"
  echo "  termux-change-repo"
  echo "  bash deploy/termux/install.sh"
fi

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
  echo
  echo "Setup is INCOMPLETE - these tools are missing:"
  for tool in "${MISSING_TOOLS[@]}"; do echo "  - ${tool}"; done
  echo
  echo "Fix those, then re-run this script."
  exit 1
fi

echo
echo "Setup complete. Next steps:"
echo
echo "  1. Check the platform and speaker are detected:"
echo "       node tools/doctor.js"
echo
echo "  2. Start the receiver:"
echo "       bash deploy/termux/run.sh"
echo
if [ -f .env ]; then
  echo "  Your AUTH_TOKEN (needed by the controller):"
  grep '^AUTH_TOKEN=' .env | cut -d= -f2
fi
echo
