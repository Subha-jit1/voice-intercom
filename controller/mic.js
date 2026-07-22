/**
 * Microphone capture.
 *
 * The stream and the AudioContext are acquired once and kept alive for the
 * whole session; push-to-talk only toggles a flag inside the worklet. Opening
 * the device on each press would add a few hundred milliseconds of latency and
 * clip the first syllable every time.
 */

const TARGET_SAMPLE_RATE = 16000;

export class MicCapture {
  /**
   * @param {object} handlers
   * @param {(buffer: ArrayBuffer) => void} handlers.onChunk
   * @param {(level: number) => void} handlers.onLevel
   */
  constructor(handlers) {
    this.handlers = handlers;
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {AudioContext | null} */
    this.context = null;
    /** @type {AudioWorkletNode | null} */
    this.node = null;
    this.active = false;
  }

  get ready() {
    return Boolean(this.node);
  }

  /** The format actually being produced, for the ptt.start negotiation. */
  get format() {
    return { sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitDepth: 16 };
  }

  /**
   * Acquire the microphone. Must be called from a user gesture, and requires a
   * secure context - see docs/SETUP.md for why that means TLS in a browser,
   * and why the desktop app is exempt.
   */
  async start() {
    if (this.node) {
      await this.context?.resume();
      return;
    }

    if (!globalThis.isSecureContext) {
      throw new Error(
        'Microphone access needs a secure context. Open this page over https:// ' +
          '(run `tailscale cert` on the receiver) or via http://localhost.'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support microphone capture.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    // Asking for 16 kHz lets the browser resample in native code, which is
    // both faster and better than anything we could do in a worklet. Browsers
    // that refuse simply hand back their hardware rate and the worklet's
    // fallback resampler takes over.
    this.context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
    if (this.context.state === 'suspended') await this.context.resume();

    await this.context.audioWorklet.addModule('ptt-processor.js');

    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'ptt-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: { targetRate: TARGET_SAMPLE_RATE },
    });

    this.node.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'audio') this.handlers.onChunk(data.buffer);
      else if (data.type === 'level') this.handlers.onLevel(data.value);
    };

    source.connect(this.node);
    // No connection to destination: the worklet has no outputs, so nothing is
    // routed back to the speaker and there is no feedback loop.
  }

  /** @param {boolean} value */
  setActive(value) {
    if (!this.node || this.active === value) return;
    this.active = value;
    this.node.port.postMessage({ type: 'active', value });
  }

  async stop() {
    this.setActive(false);
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    await this.context?.close();
    this.context = null;
  }
}
