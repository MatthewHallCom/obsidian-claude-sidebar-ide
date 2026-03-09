export default class AudioPlayer {
  private context: AudioContext;
  private analyser: AnalyserNode;
  private queue: ArrayBuffer[] = [];
  private currentSource: AudioBufferSourceNode | null = null;
  private playing = false;
  private playbackDoneCallback: (() => void) | null = null;
  private frequencyData: Uint8Array<ArrayBuffer>;

  constructor(audioContext?: AudioContext) {
    this.context = audioContext ?? new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.context.destination);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  }

  enqueue(pcm: ArrayBuffer): void {
    this.queue.push(pcm);
    if (!this.playing) {
      this.playNext();
    }
  }

  private playNext(): void {
    if (this.queue.length === 0) {
      this.playing = false;
      this.currentSource = null;
      this.playbackDoneCallback?.();
      return;
    }

    this.playing = true;
    const chunk = this.queue.shift()!;
    const audioBuffer = this.pcmToAudioBuffer(chunk);

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);
    this.currentSource = source;

    source.onended = () => {
      if (this.currentSource === source) {
        this.playNext();
      }
    };

    source.start();
  }

  private pcmToAudioBuffer(pcm: ArrayBuffer): AudioBuffer {
    const int16 = new Int16Array(pcm);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buffer = this.context.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    return buffer;
  }

  stop(): void {
    this.queue = [];
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.disconnect();
        this.currentSource.stop();
      } catch {
        // source may already be stopped
      }
      this.currentSource = null;
    }
    this.playing = false;
  }

  getAudioLevel(): number {
    this.analyser.getByteFrequencyData(this.frequencyData);
    let sum = 0;
    for (let i = 0; i < this.frequencyData.length; i++) {
      const v = this.frequencyData[i] / 255;
      sum += v * v;
    }
    return Math.sqrt(sum / this.frequencyData.length);
  }

  onPlaybackDone(cb: () => void): void {
    this.playbackDoneCallback = cb;
  }

  destroy(): void {
    this.stop();
    this.analyser.disconnect();
    if (this.context.state !== "closed") {
      this.context.close();
    }
  }
}
