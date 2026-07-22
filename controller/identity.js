/**
 * Controller identity - the name announced to a receiver in the `hello`
 * message, and shown to every other controller connected to it.
 *
 * This exists because with two or three controllers "controller is talking"
 * is mildly ambiguous; with five or six it is useless. The old default sent
 * literally the string "controller" (or "phone" on Android) from every single
 * device, so a "busy" denial could never say who actually held the floor.
 *
 * The default is generated once and persisted, not recomputed per session -
 * a name that changes every launch is just as useless as one that never
 * varies. It is editable at any time from the field in the UI.
 */

const STORAGE_KEY = 'voice-intercom.controller-name';

/** Words chosen to be short, unambiguous when read aloud, and never offensive. */
const ADJECTIVES = ['Swift', 'Quiet', 'Amber', 'Cedar', 'Nova', 'Coral', 'Ember', 'Sage'];
const NOUNS = ['Fox', 'Wren', 'Lynx', 'Otter', 'Hawk', 'Finch', 'Heron', 'Vole'];

/** @param {string[]} list */
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * A short, memorable, human-sounding default name. Not a hostname or a UUID
 * fragment - "Amber Fox" reads naturally in "Amber Fox is talking", where
 * "DESKTOP-598HJ37 is talking" or "a1b2c3 is talking" does not.
 */
function randomName() {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

/**
 * @param {string | null | undefined} hostname
 * @returns {string}
 */
function defaultName(hostname) {
  // The desktop shell knows its own hostname, which makes a better default
  // than a random pair of words when it is available - "DESKTOP-598HJ37"
  // already identifies the machine to whoever set it up. Browsers have no
  // equivalent, so they fall back to the random name.
  return hostname || randomName();
}

/**
 * The name this controller announces itself with. Generated once and cached
 * in localStorage; every later call returns the same value until changed.
 *
 * Safe to call any time. Note that this can only use `desktop.platform`-style
 * synchronous values, never the hostname - see `ensureControllerName()` for
 * why, and call that once at startup instead so a fresh install gets the
 * hostname-based default rather than a random one.
 * @returns {string}
 */
export function getControllerName() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored?.trim()) return stored.trim();

  const generated = defaultName(null);
  localStorage.setItem(STORAGE_KEY, generated);
  return generated;
}

/**
 * Resolve the default name correctly on a fresh install, then behave exactly
 * like `getControllerName()` afterwards.
 *
 * Call this once, before the first `hello`, at application startup.
 *
 * The hostname is threaded through explicitly from `desktop.whenReady()`'s
 * RESOLVED VALUE rather than read from a `desktop.hostname` getter, because
 * that getter cannot be made to work here: Electron's contextBridge evaluates
 * a plain `get x() {...}` accessor once, eagerly, at the moment the bridge is
 * exposed - before the asynchronous IPC round-trip to the main process has a
 * chance to arrive. `hostname` has no synchronous default, so the getter
 * reads as undefined forever, even long after this very promise resolves with
 * the correct value. Proven directly against a running instance: `whenReady()`
 * resolved with `{ hostname: "DESKTOP-598HJ37", ... }` in the same tick where
 * a `hostname` getter still read undefined. Do not reintroduce that getter as
 * a shortcut here - it will silently regress to the random name.
 * @returns {Promise<string>}
 */
export async function ensureControllerName() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored?.trim()) return stored.trim();

  let hostname = null;
  try {
    const info = await globalThis.desktop?.whenReady?.();
    hostname = info?.hostname ?? null;
  } catch {
    // No desktop bridge (browser), or the IPC call failed - fall back below.
  }

  const generated = defaultName(hostname);
  localStorage.setItem(STORAGE_KEY, generated);
  return generated;
}

/**
 * @param {string} name
 * @returns {string} the name actually stored, after trimming and length limits
 */
export function setControllerName(name) {
  // Matches the server's own limit (PttServer truncates `hello.name` at 64
  // chars) with room to spare, and rejects blank input rather than storing it.
  const trimmed = name.trim().slice(0, 40);
  const value = trimmed || defaultName(null);
  localStorage.setItem(STORAGE_KEY, value);
  return value;
}
