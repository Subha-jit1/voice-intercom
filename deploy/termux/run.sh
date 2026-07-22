#!/data/data/com.termux/files/usr/bin/bash
#
# Start the receiver under Termux and keep it running.
#
# The Termux equivalent of the systemd unit plus its watchdog timer. It does
# the same four jobs using what Android gives us instead of systemd:
#
#   1. hold a wake lock so Android does not freeze the process;
#   2. make sure PulseAudio is up;
#   3. restart the receiver if it exits;
#   4. restart it if it stops *answering* while still running.
#
#   bash deploy/termux/run.sh
#
# To start automatically at boot, see deploy/termux/boot.sh.
#
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

# --- Configuration ----------------------------------------------------------

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-8080}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

# Seconds between health checks, and how many consecutive failures before we
# conclude the receiver is wedged rather than merely busy.
CHECK_INTERVAL=20
FAILURES_BEFORE_RESTART=3

# --- Wake lock --------------------------------------------------------------

# Android aggressively suspends background processes. Without a wake lock the
# receiver is frozen within minutes of the screen turning off.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  trap 'termux-wake-unlock 2>/dev/null || true' EXIT
  echo "Wake lock acquired."
else
  echo "WARNING: termux-wake-lock not found (pkg install termux-api)."
  echo "         The receiver will be suspended when the screen turns off."
fi

# --- Audio ------------------------------------------------------------------

# The receiver starts PulseAudio itself, but doing it here too means a clear
# error message now rather than a failed transmission later.
if command -v pulseaudio >/dev/null 2>&1; then
  if ! pulseaudio --check 2>/dev/null; then
    echo "Starting PulseAudio..."
    pulseaudio --start --exit-idle-time=-1 --load="module-sles-sink sink_name=OpenSLES_SINK"
  fi
else
  # On Termux, paplay and pactl are inside the pulseaudio package - there is no
  # separate pulseaudio-utils, that is a Debian name.
  echo "WARNING: pulseaudio not installed (pkg install pulseaudio)."
fi

# --- Supervise --------------------------------------------------------------

# Run the receiver in the background so this script can watch it, then poll
# /api/health. A receiver that is running but not answering gets killed, which
# drops us back into the restart loop below.
run_receiver() {
  node receiver/src/index.js &
  local node_pid=$!
  local failures=0

  while kill -0 "$node_pid" 2>/dev/null; do
    sleep "$CHECK_INTERVAL"

    # Do not judge a process that has already exited on its own.
    kill -0 "$node_pid" 2>/dev/null || break

    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      failures=0
    else
      failures=$((failures + 1))
      echo "Health check failed (${failures}/${FAILURES_BEFORE_RESTART})."
      if [ "$failures" -ge "$FAILURES_BEFORE_RESTART" ]; then
        echo "Receiver is not responding; killing it so it restarts."
        kill -9 "$node_pid" 2>/dev/null
        break
      fi
    fi
  done

  wait "$node_pid" 2>/dev/null
  return $?
}

if ! command -v curl >/dev/null 2>&1; then
  echo "NOTE: curl is not installed, so the hang watchdog is disabled."
  echo "      Install it with: pkg install curl"
fi

echo "Starting receiver on port ${PORT} (Ctrl-C to stop)..."
while true; do
  run_receiver
  status=$?

  # Exit code 78 is EX_CONFIG - a bad .env will not fix itself, so stop rather
  # than spin forever on the same error.
  if [ "$status" -eq 78 ]; then
    echo "Configuration error. Fix .env and try again."
    exit 78
  fi

  echo "Receiver exited with status ${status}; restarting in 3s..."
  sleep 3
done
