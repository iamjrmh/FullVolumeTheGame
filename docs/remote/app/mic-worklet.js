// FullVolume phone mic: runs on the audio thread. Turns the phone's microphone into
// 16 kHz, 16-bit, 10 ms frames for the game's pitch detectors, and measures the level
// of each frame for the meter.
//
// Resampling is a low-pass filter (a Blackman-windowed sinc, below 16 kHz's Nyquist)
// followed by linear interpolation: with the high frequencies gone first, nothing
// folds down into the range a voice is in.

const OUT_RATE = 16000;
const FRAME = 160;
const TAPS = 33;
const CUTOFF_HZ = 7000;

class FvMicSender extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE;
    this.taps = FvMicSender.lowPass(CUTOFF_HZ / sampleRate);
    this.history = new Float32Array(TAPS);
    this.head = 0;
    this.prev = 0;
    this.pos = 0;
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
    this.energy = 0;
    this.seq = 0;
    this.port.onmessage = (e) => { if (e.data === "restart") this.seq = 0; };
  }

  static lowPass(fc) {
    const taps = new Float32Array(TAPS);
    const mid = (TAPS - 1) / 2;
    let sum = 0;
    for (let n = 0; n < TAPS; n++) {
      const x = n - mid;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (TAPS - 1));
      taps[n] = sinc * w;
      sum += taps[n];
    }
    for (let n = 0; n < TAPS; n++) taps[n] /= sum;
    return taps;
  }

  emit(value) {
    const v = value > 1 ? 1 : value < -1 ? -1 : value;
    this.frame[this.filled++] = v * 32767;
    this.energy += v * v;

    if (this.filled === FRAME) {
      const pcm = this.frame.buffer.slice(0);
      this.port.postMessage({ seq: this.seq++, pcm, rms: Math.sqrt(this.energy / FRAME) }, [pcm]);
      this.filled = 0;
      this.energy = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    const taps = this.taps, history = this.history;

    for (let i = 0; i < channel.length; i++) {
      history[this.head] = channel[i];
      let acc = 0, j = this.head;
      for (let k = 0; k < TAPS; k++) {
        acc += taps[k] * history[j];
        j = j === 0 ? TAPS - 1 : j - 1;
      }
      this.head = this.head === TAPS - 1 ? 0 : this.head + 1;

      // Outputs that fall between the previous filtered sample (0) and this one (1).
      while (this.pos <= 1) {
        this.emit(this.prev + (acc - this.prev) * this.pos);
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = acc;
    }
    return true;
  }
}

registerProcessor("fv-mic-sender", FvMicSender);
