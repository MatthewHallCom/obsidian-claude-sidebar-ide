export const WORKLET_PROCESSOR_CODE = `
class MicDownsamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._inputSampleRate = sampleRate;
    this._targetSampleRate = 16000;
    this._ratio = this._inputSampleRate / this._targetSampleRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];
    const outputLength = Math.floor(channel.length / this._ratio);
    if (outputLength === 0) return true;

    const pcm = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const pos = i * this._ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = channel[idx] ?? 0;
      const b = channel[idx + 1] ?? a;
      const sample = a + frac * (b - a);
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }

    this.port.postMessage(pcm, [pcm.buffer]);
    return true;
  }
}

registerProcessor('mic-downsampler', MicDownsamplerProcessor);
`;
