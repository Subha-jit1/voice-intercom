/**
 * Shared type definitions.
 *
 * Plain JS keeps the Raspberry Pi deployment build-free, so types live in
 * JSDoc. Editors and `tsc --noEmit` (via jsconfig.json) still check them.
 */

/**
 * @typedef {object} TlsConfig
 * @property {string} certPath
 * @property {string} keyPath
 */

/**
 * @typedef {object} HttpConfig
 * @property {string} host
 * @property {number} port
 * @property {TlsConfig | null} tls
 */

/**
 * @typedef {object} AuthConfig
 * @property {string} token
 * @property {number} maxFailures
 * @property {number} lockoutMs
 */

/**
 * @typedef {object} AudioConfig
 * @property {'auto'|'android'|'alsa'|'linux'|'null'} backend
 * @property {string | null} device
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitDepth
 * @property {number} idleTimeoutMs
 * @property {number} maxQueueFrames
 */

/**
 * @typedef {object} LoggingConfig
 * @property {'trace'|'debug'|'info'|'warn'|'error'} level
 * @property {number} bufferSize
 * @property {string | null} file
 */

/**
 * @typedef {object} Config
 * @property {string} version
 * @property {string} receiverName
 * @property {HttpConfig} http
 * @property {AuthConfig} auth
 * @property {AudioConfig} audio
 * @property {LoggingConfig} logging
 */

/**
 * The audio wire format negotiated between controller and receiver.
 * @typedef {object} AudioFormat
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitDepth
 */

export {};
