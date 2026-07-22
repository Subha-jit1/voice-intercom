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

// Fetched synchronously at load so `window.desktop.hotkey` is readable by the
// UI's first paint rather than arriving a tick later.
let info = { platform: process.platform, hotkey: 'F8' };
ipcRenderer.invoke('desktop:info').then((value) => Object.assign(info, value));

contextBridge.exposeInMainWorld('desktop', {
  get platform() { return info.platform; },
  get hotkey() { return info.hotkey; },

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
