/**
 * AudioWorklet: buffers raw mic PCM at the AudioContext sample rate (we set
 * 16kHz in the recorder) into 512-sample frames and posts each completed
 * frame to the main thread. Browser delivers 128-sample quanta, so 4 quanta
 * (~32ms at 16kHz) fill one frame.
 */
class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(512);
    this.idx = 0;
    this.quanta = 0;
    this.framesOut = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    this.quanta++;
    // Every 200 quanta (~1.3s at 128-sample quanta at 16kHz), post a ping.
    if (this.quanta % 200 === 0) {
      this.port.postMessage({
        type: 'diag',
        quanta: this.quanta,
        framesOut: this.framesOut,
        hasInput: !!ch,
        inputLen: ch ? ch.length : 0,
      });
    }
    if (!ch) return true;
    let absSum = 0, absMax = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.buffer[this.idx++] = v;
      const a = v < 0 ? -v : v;
      absSum += a;
      if (a > absMax) absMax = a;
      if (this.idx >= 512) {
        this.port.postMessage({ type: 'frame', frame: this.buffer.slice() });
        this.framesOut++;
        this.idx = 0;
      }
    }
    // Lightweight amplitude heartbeat (every 200 quanta, same cadence as diag)
    if (this.quanta % 200 === 0) {
      this.port.postMessage({
        type: 'amp',
        absMean: absSum / ch.length,
        absMax,
      });
    }
    return true;
  }
}

registerProcessor('vad-processor', VADProcessor);
