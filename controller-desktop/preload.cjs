/**
 * Preload bridge.
 *
 * The renderer runs with contextIsolation and no Node integration, so this is
 * the entire surface it can reach. Everything exposed is a narrow, named
 * capability - the renderer can never see ipcRenderer itself, nor name an
 * arbitrary channel.
 *
 * CommonJS on purpose: preload scripts are loaded before the ESM loader is
 * available in the renderer context.
 */

const { contextBridge, ipcRenderer } = require('electron');

// info arrives over IPC, which is asynchronous even though it resolves almost
// immediately - `window.desktop.hostname` reads as undefined until it does.
// That one tick matters: controller/identity.js generates and PERMANENTLY
// caches a default controller name the first time it is asked, so if it asks
// before this promise resolves, the hostname is lost forever in favour of a
// random name. `whenReady` lets identity.js wait for the real value on that
// first call only; every call after is instant because the cache is warm.
let info = { platform: process.platform, hotkey: 'F8' };
const ready = ipcRenderer.invoke('desktop:info').then((value) => {
  Object.assign(info, value);
  return info;
});

contextBridge.exposeInMainWorld('desktop', {
  // CAUTION: contextBridge evaluates a plain accessor like `get x() {...}`
  // ONCE, eagerly, at the moment exposeInMainWorld() runs - NOT live on every
  // read. `hostname` has no default in `info` above, so reading it via this
  // getter returns undefined forever, even long after `ready` resolves and
  // `info.hostname` is actually populated. Proven directly: probing the live
  // renderer showed `whenReady()` resolving with the correct hostname while
  // this getter kept returning undefined in the same tick.
  //
  // platform/hotkey happen to look fine here only because their eager
  // snapshot already equals the real value (they have defaults above) - that
  // is a coincidence, not evidence the getter is live. Anything that is only
  // known after the IPC round-trip - hostname today, potentially more later -
  // MUST be read from the resolved value of whenReady(), never from a getter.
  get platform() { return info.platform; },
  get hotkey() { return info.hotkey; },

  /**
   * Resolves with the full info object once populated from the main process.
   * This is the only reliable way to read `hostname` - see the caution above.
   */
  whenReady() {
    return ready;
  },

  /**
   * Subscribe to global-hotkey transmit toggles.
   * @param {(active: boolean) => void} callback
   */
  onTransmit(callback) {
    const listener = (_event, active) => callback(Boolean(active));
    ipcRenderer.on('desktop:transmit', listener);
    return () => ipcRenderer.removeListener('desktop:transmit', listener);
  },

  /** Report the true transmit state so the tray reflects reality. */
  setTalking(value) {
    ipcRenderer.send('desktop:set-talking', Boolean(value));
  },

  getLaunchAtLogin() {
    return ipcRenderer.invoke('desktop:get-launch-at-login');
  },

  setLaunchAtLogin(enabled) {
    return ipcRenderer.invoke('desktop:set-launch-at-login', Boolean(enabled));
  },
});
