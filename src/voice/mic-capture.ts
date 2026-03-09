import { WORKLET_PROCESSOR_CODE } from './audio-worklet-processor';

export default class MicCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private audioDataCallback: ((pcm: Int16Array) => void) | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext();
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserBuffer = new Float32Array(this.analyserNode.fftSize) as Float32Array<ArrayBuffer>;
    this.sourceNode.connect(this.analyserNode);

    const workletSupported =
      typeof AudioWorkletNode !== 'undefined' &&
      typeof this.audioContext.audioWorklet !== 'undefined';

    if (workletSupported) {
      await this._startWorklet();
    } else {
      this._startScriptProcessor();
    }
  }

  private async _startWorklet(): Promise<void> {
    const ctx = this.audioContext!;
    const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.workletNode = new AudioWorkletNode(ctx, 'mic-downsampler');
    this.workletNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
      if (this.audioDataCallback) {
        this.audioDataCallback(event.data);
      }
    };
    this.sourceNode!.connect(this.workletNode);
  }

  private _startScriptProcessor(): void {
    const ctx = this.audioContext!;
    const nativeSampleRate = ctx.sampleRate;
    const targetSampleRate = 16000;
    const ratio = nativeSampleRate / targetSampleRate;
    const bufferSize = 4096;

    this.scriptNode = ctx.createScriptProcessor(bufferSize, 1, 1);
    this.scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const channel = event.inputBuffer.getChannelData(0);
      const outputLength = Math.floor(channel.length / ratio);
      if (outputLength === 0 || !this.audioDataCallback) return;

      const pcm = new Int16Array(outputLength);
      for (let i = 0; i < outputLength; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = channel[idx] ?? 0;
        const b = channel[idx + 1] ?? a;
        const sample = a + frac * (b - a);
        pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }
      this.audioDataCallback(pcm);
    };

    this.sourceNode!.connect(this.scriptNode);
    this.scriptNode.connect(ctx.destination);
  }

  stop(): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode.onaudioprocess = null;
      this.scriptNode = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyserBuffer = null;
  }

  onAudioData(cb: (pcm: Int16Array) => void): void {
    this.audioDataCallback = cb;
  }

  getAudioLevel(): number {
    if (!this.analyserNode || !this.analyserBuffer) return 0;
    this.analyserNode.getFloatTimeDomainData(this.analyserBuffer);
    let sumSq = 0;
    for (let i = 0; i < this.analyserBuffer.length; i++) {
      sumSq += this.analyserBuffer[i] * this.analyserBuffer[i];
    }
    const rms = Math.sqrt(sumSq / this.analyserBuffer.length);
    return Math.min(1, rms);
  }
}
