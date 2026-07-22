/**
 * PTT capture worklet.
 *
 * Runs on the browser's realtime audio thread. Its whole job is to turn
 * Float32 microphone samples into the 16-bit little-endian PCM chunks the
 * receiver expects, and to post them to the main thread only while the
 * push-to-talk button is held.
 *
 * A worklet is used rather than the deprecated ScriptProcessorNode because
 * ScriptProcessorNode runs on the main thread, where a UI repaint or garbage
 * collection pause turns into an audible dropout.
 */

const CHUNK_MS = 20;

class PttProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const { targetRate } = options.processorOptions;
    this.targetRate = targetRate;

    // The AudioContext is created with sampleRate: 16000 so the browser does
    // the resampling in native code. This ratio is therefore normally 1; the
    // interpolation path below is a fallback for browsers that refuse the
    // requested rate and hand us hardware rate instead.
    this.ratio = sampleRate / targetRate;

    this.chunkSamples = Math.round((targetRate * CHUNK_MS) / 1000);
    this.chunk = new Int16Array(this.chunkSamples);
    this.filled = 0;

    /** Fractional read position carried across blocks when resampling. */
    this.readPos = 0;
    this.active = false;

    /** Running peak, reported to the UI so the user can see the mic is live. */
    this.peak = 0;
    this.blocksSincePeakReport = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === 'active') {
        this.active = Boolean(event.data.value);
        // Drop any partial chunk so a new transmission never starts with
        // audio captured before the button was pressed.
        this.filled = 0;
        this.readPos = 0;
      }
    };
  }

  /** @param {number} sample Float32 in [-1, 1] */
  pushSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    if (Math.abs(clamped) > this.peak) this.peak = Math.abs(clamped);

    // Asymmetric scaling: Int16 range is -32768..32767.
    this.chunk[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.filled += 1;

    if (this.filled === this.chunkSamples) {
      // Transfer the buffer rather than copying it - this runs 50x a second.
      const payload = this.chunk.slice();
      this.port.postMessage({ type: 'audio', buffer: payload.buffer }, [payload.buffer]);
      this.filled = 0;
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    if (this.active) {
      if (this.ratio === 1) {
        for (let i = 0; i < input.length; i += 1) this.pushSample(input[i]);
      } else {
        let p = this.readPos;
        while (p < input.length) {
          const i = Math.floor(p);
          const frac = p - i;
          const s0 = input[i];
          const s1 = i + 1 < input.length ? input[i + 1] : s0;
          this.pushSample(s0 + (s1 - s0) * frac);
          p += this.ratio;
        }
        this.readPos = p - input.length;
      }
    }

    // Report level roughly 12 times a second - often enough to look live,
    // rarely enough not to flood the message port.
    this.blocksSincePeakReport += 1;
    if (this.blocksSincePeakReport >= 6) {
      this.port.postMessage({ type: 'level', value: this.peak });
      this.peak = 0;
      this.blocksSincePeakReport = 0;
    }

    return true;
  }
}

registerProcessor('ptt-processor', PttProcessor);
