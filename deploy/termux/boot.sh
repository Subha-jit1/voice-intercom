#!/data/data/com.termux/files/usr/bin/bash
#
# Start the receiver automatically when the phone boots.
#
# Requires the Termux:Boot add-on, installed from the same source as Termux
# itself (F-Droid). Termux:Boot runs every executable script in
# ~/.termux/boot/ after the device starts.
#
# Install:
#   mkdir -p ~/.termux/boot
#   ln -sf ~/voice-intercom/deploy/termux/boot.sh ~/.termux/boot/voice-intercom
#   chmod +x ~/voice-intercom/deploy/termux/boot.sh
#
# Then open the Termux:Boot app once - it does nothing visible, but Android
# will not grant boot permission until the app has been launched at least once.
#
set -uo pipefail

# Termux:Boot starts scripts with a minimal environment and no controlling
# terminal, so use absolute paths and never assume the working directory.
REPO="${HOME}/voice-intercom"

if [ ! -d "$REPO" ]; then
  echo "voice-intercom not found at ${REPO}" >&2
  exit 1
fi

# Hold the CPU awake for the whole session, not just while this script runs.
termux-wake-lock 2>/dev/null || true

# Log somewhere findable - there is no journal here, and a boot-time failure is
# otherwise invisible.
LOG="${REPO}/boot.log"
echo "=== boot at $(date -Is) ===" >> "$LOG"

exec bash "${REPO}/deploy/termux/run.sh" >> "$LOG" 2>&1
