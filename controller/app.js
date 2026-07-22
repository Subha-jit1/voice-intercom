/**
 * Controller application.
 *
 * The only file that touches the DOM. Runs unchanged in two hosts:
 *
 *   - the browser PWA served by a receiver;
 *   - the Electron desktop shell, which loads these same files from disk.
 *
 * The desktop shell exposes `window.desktop`; everything gated on that is
 * progressive enhancement, so the browser build never breaks.
 */

import { Connection } from './connection.js';
import { MicCapture } from './mic.js';
import { ReceiverStore, receiverApi, websocketUrl } from './receivers.js';

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  receiverName: $('receiver-name'),
  addToggle: $('add-toggle'),

  receiverList: $('receiver-list'),
  receiverEmpty: $('receiver-empty'),

  addForm: $('add-form'),
  url: $('receiver-url'),
  token: $('token'),
  addReceiver: $('add-receiver'),
  addError: $('add-error'),

  main: $('main'),
  ptt: $('ptt'),
  pttHint: $('ptt-hint'),
  levelBar: $('level-bar'),

  latency: $('stat-latency'),
  sent: $('stat-sent'),
  channel: $('stat-channel'),

  volume: $('volume'),
  volumeValue: $('volume-value'),
  testSpeaker: $('test-speaker'),
  stopAudio: $('stop-audio'),
  audioResult: $('audio-result'),

  diagnostics: $('diagnostics'),
  refreshDiagnostics: $('refresh-diagnostics'),
  logs: $('logs'),
  refreshLogs: $('refresh-logs'),
  followLogs: $('follow-logs'),

  forget: $('forget'),

  desktopPanel: $('desktop-panel'),
  hotkeyLabel: $('hotkey-label'),
  launchAtLogin: $('launch-at-login'),
};

/** The Electron bridge, or undefined in a browser. */
const desktop = globalThis.desktop;

const store = new ReceiverStore();

let pttHeld = false;
let hasFloor = false;
let chunksSent = 0;
let logTimer;
/** @type {any} */
let wakeLock = null;
/** Which receiver the live WebSocket belongs to, so we know when to switch. */
let connectedId = null;

// --- Connection -------------------------------------------------------------

const connection = new Connection({
  onStatus: (status, detail) => {
    els.statusDot.dataset.state = status;
    els.statusText.textContent =
      detail ??
      { online: 'Connected', connecting: 'Connecting…', offline: 'Not connected' }[status];

    const usable = status === 'online';
    els.ptt.disabled = !usable;
    if (!usable) {
      endTalking();
      els.channel.textContent = 'offline';
      els.latency.textContent = '–';
    }
    usable ? requestWakeLock() : releaseWakeLock();
  },

  onWelcome: (message) => {
    const selected = store.selected;
    if (selected) store.update(selected.id, { name: message.receiver.name });
    els.receiverName.textContent = message.receiver.name;
    document.title = `${message.receiver.name} · Voice Intercom`;
    applyState(message.state);
  },

  onState: applyState,

  onGranted: () => {
    hasFloor = true;
    // The user may have let go while the grant was in flight.
    if (!pttHeld) {
      releaseFloor();
      return;
    }
    mic.setActive(true);
    els.ptt.dataset.state = 'talking';
    els.pttHint.textContent = 'Transmitting…';
    desktop?.setTalking?.(true);
  },

  onDenied: (message) => {
    hasFloor = false;
    mic.setActive(false);
    els.ptt.dataset.state = 'denied';
    desktop?.setTalking?.(false);

    els.pttHint.textContent =
      message.reason === 'busy'
        ? `${message.holder?.name ?? 'Someone else'} is talking`
        : `Receiver could not open audio: ${message.detail ?? message.reason}`;

    setTimeout(() => {
      if (!pttHeld) resetPttHint();
    }, 1800);
  },

  onEnded: () => {
    hasFloor = false;
    mic.setActive(false);
    els.ptt.dataset.state = '';
    desktop?.setTalking?.(false);
    resetPttHint();
  },

  onLatency: (ms) => { els.latency.textContent = `${ms} ms`; },

  onAuthFailure: (reason) => {
    const selected = store.selected;
    if (selected) store.update(selected.id, { status: 'unauthorised', error: reason });
    els.statusText.textContent = reason;
  },
});

function applyState(state) {
  if (!state) return;
  els.channel.textContent = state.speaker ? `${state.speaker.name} talking` : 'idle';
}

/** Open (or switch) the WebSocket to whichever receiver is selected. */
function syncConnection() {
  const selected = store.selected;

  if (!selected) {
    connection.disconnect();
    connectedId = null;
    els.main.hidden = true;
    els.receiverName.textContent = 'Voice Intercom';
    els.statusText.textContent = 'No receiver selected';
    return;
  }

  els.main.hidden = false;
  if (connectedId === selected.id) return;

  connection.disconnect();
  connectedId = selected.id;
  chunksSent = 0;
  els.sent.textContent = '–';
  els.receiverName.textContent = selected.name;
  connection.connect(websocketUrl(selected), selected.token);
  loadVolume(selected);
}

// --- Receiver list ----------------------------------------------------------

function renderReceivers() {
  const { receivers, selectedId } = store;

  els.receiverEmpty.hidden = receivers.length > 0;
  els.receiverList.replaceChildren(
    ...receivers.map((receiver) => {
      const item = document.createElement('li');

      const button = document.createElement('button');
      button.className = 'receiver-card';
      button.type = 'button';
      button.dataset.selected = String(receiver.id === selectedId);
      button.setAttribute('aria-pressed', String(receiver.id === selectedId));
      button.addEventListener('click', () => store.select(receiver.id));

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.dataset.state = receiver.status === 'online' ? 'online' : 'offline';
      dot.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'receiver-text';

      // textContent throughout: receiver names come from a remote machine and
      // must never be parsed as markup.
      const name = document.createElement('span');
      name.className = 'receiver-name';
      name.textContent = receiver.name;

      const meta = document.createElement('span');
      meta.className = 'receiver-meta';
      meta.textContent = describeReceiver(receiver);

      text.append(name, meta);
      button.append(dot, text);
      item.append(button);
      return item;
    })
  );
}

/** @param {import('./receivers.js').Receiver} receiver */
function describeReceiver(receiver) {
  if (receiver.status === 'offline') return receiver.error ?? 'offline';
  if (receiver.status === 'unauthorised') return 'token rejected';
  if (receiver.status === 'unknown') return 'checking…';

  const parts = [];
  if (receiver.identity?.platform) parts.push(receiver.identity.platform);
  if (receiver.latencyMs != null) parts.push(`${receiver.latencyMs} ms`);
  return parts.join(' · ') || 'online';
}

store.subscribe(() => {
  renderReceivers();
  syncConnection();
});

// --- Add receiver -----------------------------------------------------------

function showAddForm(show) {
  els.addForm.hidden = !show;
  els.addToggle.setAttribute('aria-expanded', String(show));
  if (show) {
    els.addError.hidden = true;
    // In the browser build the receiver serving this page is the obvious
    // default. The desktop app has no such origin, so it starts empty.
    if (!els.url.value && !desktop) els.url.value = location.origin;
    els.url.focus();
  }
}

els.addToggle.addEventListener('click', () => showAddForm(els.addForm.hidden));

els.addReceiver.addEventListener('click', async () => {
  const baseUrl = els.url.value.trim();
  const token = els.token.value.trim();

  if (!baseUrl || !token) {
    els.addError.hidden = false;
    els.addError.textContent = 'An address and a token are both required.';
    return;
  }

  els.addReceiver.disabled = true;
  els.addError.hidden = true;
  try {
    const receiver = await store.add({ baseUrl, token });
    store.select(receiver.id);
    els.url.value = '';
    els.token.value = '';
    showAddForm(false);
  } catch (err) {
    els.addError.hidden = false;
    els.addError.textContent = err.message;
  } finally {
    els.addReceiver.disabled = false;
  }
});

els.forget.addEventListener('click', () => {
  const selected = store.selected;
  if (selected) store.remove(selected.id);
});

// --- Microphone -------------------------------------------------------------

const mic = new MicCapture({
  onChunk: (buffer) => {
    if (!hasFloor) return;
    if (connection.sendAudio(buffer)) {
      chunksSent += 1;
      els.sent.textContent = `${chunksSent}`;
    }
  },
  onLevel: (level) => {
    // Perceptual rather than linear: speech sits low on a linear scale and the
    // meter would barely move.
    const percent = Math.min(100, Math.round(Math.sqrt(level) * 130));
    els.levelBar.style.width = `${pttHeld ? percent : 0}%`;
  },
});

// --- Push to talk -----------------------------------------------------------

function resetPttHint() {
  els.pttHint.textContent = desktop
    ? `Hold the button or space bar · ${desktop.hotkey ?? 'F8'} toggles from anywhere`
    : 'Hold the button, or hold the space bar';
}

async function beginTalking() {
  if (pttHeld || els.ptt.disabled) return;
  pttHeld = true;
  els.ptt.dataset.state = 'talking';
  els.pttHint.textContent = 'Requesting channel…';

  try {
    await mic.start();
  } catch (err) {
    pttHeld = false;
    els.ptt.dataset.state = 'denied';
    els.pttHint.textContent = err.message;
    return;
  }

  // The user may have released during the permission prompt.
  if (!pttHeld) return;

  chunksSent = 0;
  els.sent.textContent = '0';
  connection.requestFloor(mic.format);
}

function endTalking() {
  if (!pttHeld) return;
  pttHeld = false;
  mic.setActive(false);
  els.levelBar.style.width = '0%';
  els.ptt.dataset.state = '';
  desktop?.setTalking?.(false);
  if (hasFloor) releaseFloor();
  resetPttHint();
}

function releaseFloor() {
  hasFloor = false;
  connection.releaseFloor();
}

// Pointer events cover mouse, touch and stylus in one path. Capturing the
// pointer means a finger that slides off the button still ends the
// transmission on release, instead of leaving the channel open.
els.ptt.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  els.ptt.setPointerCapture(event.pointerId);
  beginTalking();
});
els.ptt.addEventListener('pointerup', endTalking);
els.ptt.addEventListener('pointercancel', endTalking);
els.ptt.addEventListener('contextmenu', (event) => event.preventDefault());

addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (document.activeElement?.tagName === 'INPUT') return;
  event.preventDefault();
  beginTalking();
});
addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  endTalking();
});

// Losing focus mid-transmission must not leave the channel held open - except
// on the desktop, where the whole point of the global hotkey is to keep
// transmitting while another window has focus.
if (!desktop) {
  addEventListener('blur', endTalking);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') endTalking();
  });
}

// --- Receiver controls ------------------------------------------------------

/** Every control acts on the selected receiver; there is no ambient "current". */
async function api(path, options) {
  const selected = store.selected;
  if (!selected) throw new Error('No receiver selected.');
  return receiverApi(selected, path, options);
}

async function loadVolume(receiver) {
  try {
    const state = await receiverApi(receiver, '/api/audio');
    if (typeof state.currentVolume === 'number') {
      els.volume.value = String(state.currentVolume);
      els.volumeValue.textContent = `${state.currentVolume}%`;
    }
  } catch {
    // Volume is optional on some backends.
  }
}

els.volume.addEventListener('input', () => {
  els.volumeValue.textContent = `${els.volume.value}%`;
});

els.volume.addEventListener('change', async () => {
  try {
    await api('/api/audio/volume', {
      method: 'POST',
      body: JSON.stringify({ percent: Number(els.volume.value) }),
    });
    els.audioResult.textContent = `Volume set to ${els.volume.value}%.`;
  } catch (err) {
    els.audioResult.textContent = `Volume control unavailable: ${err.message}`;
  }
});

els.testSpeaker.addEventListener('click', async () => {
  els.testSpeaker.disabled = true;
  els.audioResult.textContent = 'Playing test tone…';
  try {
    const result = await api('/api/audio/test', {
      method: 'POST',
      body: JSON.stringify({ frequency: 440, durationMs: 900 }),
    });
    els.audioResult.textContent = `Played ${result.durationMs} ms via "${result.backend}". Hear it?`;
  } catch (err) {
    els.audioResult.textContent = `Test failed: ${err.message}`;
  } finally {
    els.testSpeaker.disabled = false;
  }
});

els.stopAudio.addEventListener('click', async () => {
  try {
    await api('/api/audio/stop', { method: 'POST' });
    els.audioResult.textContent = 'Audio stopped.';
  } catch (err) {
    els.audioResult.textContent = `Failed: ${err.message}`;
  }
});

// --- Diagnostics and logs ---------------------------------------------------

async function refreshDiagnostics() {
  els.diagnostics.textContent = 'Loading…';
  try {
    els.diagnostics.textContent = JSON.stringify(await api('/api/diagnostics'), null, 2);
  } catch (err) {
    els.diagnostics.textContent = `Failed: ${err.message}`;
  }
}

async function refreshLogs() {
  try {
    const { records } = await api('/api/logs?limit=200');
    els.logs.textContent = records
      .map(
        (r) =>
          `${r.time.slice(11, 23)} ${r.level.padEnd(5)} ${r.scope}  ${r.message}` +
          (r.fields ? `\n${' '.repeat(14)}${JSON.stringify(r.fields)}` : '')
      )
      .join('\n');
    els.logs.scrollTop = els.logs.scrollHeight;
  } catch (err) {
    els.logs.textContent = `Failed: ${err.message}`;
  }
}

els.refreshDiagnostics.addEventListener('click', refreshDiagnostics);
els.refreshLogs.addEventListener('click', refreshLogs);
els.followLogs.addEventListener('change', () => {
  clearInterval(logTimer);
  if (els.followLogs.checked) {
    refreshLogs();
    logTimer = setInterval(refreshLogs, 2000);
  }
});

// --- Wake lock --------------------------------------------------------------

// An intercom is useless if the screen sleeping drops the connection. The
// desktop shell keeps itself awake, so this is browser-only.
async function requestWakeLock() {
  if (desktop || wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    // Denied or unsupported; not fatal.
  }
}

function releaseWakeLock() {
  wakeLock?.release?.();
  wakeLock = null;
}

// --- Desktop integration ----------------------------------------------------

if (desktop) {
  document.body.dataset.host = 'desktop';
  els.desktopPanel.hidden = false;
  els.hotkeyLabel.textContent = desktop.hotkey ?? 'F8';

  // The global hotkey toggles rather than holds. A global *keyup* is not
  // available to Electron without a native input hook, so binding hold-to-talk
  // to it would mean a transmission that never ends.
  desktop.onTransmit?.((active) => {
    if (active) beginTalking();
    else endTalking();
  });

  desktop.getLaunchAtLogin?.().then((enabled) => {
    els.launchAtLogin.checked = Boolean(enabled);
  });
  els.launchAtLogin.addEventListener('change', () => {
    desktop.setLaunchAtLogin?.(els.launchAtLogin.checked);
  });
}

// --- Boot -------------------------------------------------------------------

renderReceivers();
syncConnection();
resetPttHint();
store.startPolling();

if (store.receivers.length === 0) showAddForm(true);

// getUserMedia needs a secure context. The desktop shell serves its UI over a
// privileged scheme, so this only ever fires in a browser on plain http.
if (!globalThis.isSecureContext) {
  els.pttHint.textContent =
    'This page is not on a secure origin, so the browser will block microphone ' +
    'access. Run `tailscale cert` on the receiver, or use the desktop app.';
}

// The service worker is a browser-only concern; the desktop app ships its UI.
if ('serviceWorker' in navigator && !desktop) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
  });
}
