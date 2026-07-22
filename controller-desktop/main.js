/**
 * Electron main process for the desktop controller.
 *
 * This shell owns everything a browser cannot do: a global push-to-talk
 * hotkey, a system tray, autostart, and — the reason it exists at all —
 * microphone access without a TLS certificate.
 *
 * It deliberately contains no intercom logic. The UI it loads is the same
 * `controller/` directory the receiver serves to phones; this process only
 * provides capabilities to it. Keeping the split that way means a fix to the
 * push-to-talk flow lands in both the desktop app and the PWA at once.
 *
 * CommonJS on purpose. The rest of the project is ESM, but Electron's main
 * process is far better tested on CJS, and an ESM entry point trips module
 * interop on the `electron` builtin. This file is pure glue, so the
 * inconsistency buys reliability at no architectural cost.
 */

const {
  app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, protocol, shell,
} = require('electron');
const { readFile } = require('node:fs/promises');
const os = require('node:os');
const { extname, join, normalize, resolve, sep } = require('node:path');

/**
 * The shared UI, loaded from disk rather than from a receiver.
 *
 * In development it sits alongside this package; once packaged, electron-builder
 * has copied it into the app's resources directory.
 */
const UI_DIR = app.isPackaged
  ? join(process.resourcesPath, 'controller')
  : resolve(__dirname, '..', 'controller');

/**
 * Global push-to-talk key.
 *
 * This TOGGLES transmission rather than holding it. Electron's globalShortcut
 * reports key *presses* only — there is no global key-up event without a
 * native input hook — so binding hold-to-talk here would start a transmission
 * that never ends. Hold-to-talk still works inside the window, where real
 * keyup events exist.
 */
const HOTKEY = process.env.VOICE_INTERCOM_HOTKEY || 'F8';

/** @type {BrowserWindow | null} */
let window = null;
/** @type {Tray | null} */
let tray = null;
let transmitting = false;
/** Distinguishes "user closed the window" from "user quit the app". */
let quitting = false;

// A custom scheme, registered as secure, is what lets getUserMedia work
// without a certificate. file:// is not a secure context and would be
// rejected exactly the way plain http:// is in a browser.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve the shared UI over app://, refusing anything outside UI_DIR. */
function registerUiProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const requested = decodeURIComponent(url.pathname);
    const relative = requested === '/' || requested === '' ? 'index.html' : requested.slice(1);

    // Path traversal guard: resolve, then require the result to stay inside.
    const target = resolve(UI_DIR, normalize(relative));
    if (target !== UI_DIR && !target.startsWith(UI_DIR + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const body = await readFile(target);
      return new Response(body, {
        headers: {
          'Content-Type': MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 440,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#0f1419',
    autoHideMenuBar: true,
    icon: iconImage(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The renderer is our own UI asking for its own microphone; prompting would
  // be theatre. Everything else is refused.
  const { session } = window.webContents;
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });
  session.setPermissionCheckHandler((_contents, permission) => permission === 'media');

  window.loadURL('app://ui/index.html');

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides it; an intercom you have to relaunch to hear is
  // not an intercom. Quit explicitly from the tray.
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window && window.hide();
  });

  window.on('closed', () => { window = null; });
}

function iconImage() {
  const icon = nativeImage.createFromPath(join(__dirname, 'build', 'icon.png'));
  return icon.isEmpty() ? undefined : icon;
}

function createTray() {
  const image = iconImage();
  if (!image) return;

  tray = new Tray(image.resize({ width: 22, height: 22 }));
  tray.setToolTip('Voice Intercom');
  tray.on('click', toggleWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: transmitting ? 'Stop transmitting' : `Transmit (${HOTKEY})`, click: toggleTransmit },
      { type: 'separator' },
      {
        label: window && window.isVisible() ? 'Hide window' : 'Show window',
        click: toggleWindow,
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.setToolTip(transmitting ? 'Voice Intercom — transmitting' : 'Voice Intercom');
}

function toggleWindow() {
  if (!window) {
    createWindow();
    return;
  }
  if (window.isVisible()) {
    window.hide();
  } else {
    window.show();
    window.focus();
  }
  refreshTrayMenu();
}

function toggleTransmit() {
  transmitting = !transmitting;
  if (window) window.webContents.send('desktop:transmit', transmitting);
  refreshTrayMenu();
}

// --- IPC --------------------------------------------------------------------

// hostname feeds the default controller name (controller/identity.js) - a
// machine's own name is a better default than a randomly generated one, since
// it already tells other controllers which physical device is talking.
ipcMain.handle('desktop:info', () => ({
  platform: process.platform,
  hotkey: HOTKEY,
  hostname: os.hostname(),
}));

// The renderer is the authority on whether audio is actually flowing - the
// hotkey only requests it, and the receiver can refuse.
ipcMain.on('desktop:set-talking', (_event, value) => {
  transmitting = Boolean(value);
  refreshTrayMenu();
});

ipcMain.handle('desktop:get-launch-at-login', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('desktop:set-launch-at-login', (_event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return true;
  } catch {
    return false;
  }
});

// --- Lifecycle --------------------------------------------------------------

// A second launch should surface the running app, not start a rival copy that
// fights it for the global hotkey.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      window.show();
      window.focus();
    }
  });

  app.whenReady().then(() => {
    registerUiProtocol();
    createWindow();
    createTray();

    if (!globalShortcut.register(HOTKEY, toggleTransmit)) {
      // Another application already owns the key. Not fatal - the in-window
      // controls still work - but the user needs to know why nothing happens.
      console.warn(
        `Could not register the global hotkey "${HOTKEY}". Another application ` +
          `is probably using it. Set VOICE_INTERCOM_HOTKEY to choose another.`
      );
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (window) window.show();
    });
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Do not quit when the window closes - the app lives in the tray.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && quitting) app.quit();
  });
}
