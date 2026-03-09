const KEEPALIVE_INTERVAL_MS = 10_000;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1_000;

export default class SttService {
  private apiKey: string;
  private endpointingMs: number;
  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;
  private disconnecting = false;

  private transcriptCb: ((text: string, isFinal: boolean) => void) | null = null;
  private speechEndCb: ((transcript: string) => void) | null = null;
  private speechStartCb: (() => void) | null = null;
  private errorCb: ((error: Error) => void) | null = null;

  constructor(apiKey: string, vadSensitivity = 300) {
    this.apiKey = apiKey;
    this.endpointingMs = vadSensitivity;
  }

  connect(): void {
    this.disconnecting = false;
    this.retryCount = 0;
    this.openSocket();
  }

  disconnect(): void {
    this.disconnecting = true;
    this.clearKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  sendAudio(pcm: Int16Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcm.buffer);
    }
  }

  onTranscript(cb: (text: string, isFinal: boolean) => void): void {
    this.transcriptCb = cb;
  }

  onSpeechEnd(cb: (transcript: string) => void): void {
    this.speechEndCb = cb;
  }

  onSpeechStart(cb: () => void): void {
    this.speechStartCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb;
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      endpointing: String(this.endpointingMs),
      vad_events: 'true',
      interim_results: 'true',
      utterance_end_ms: '1500',
      smart_format: 'true',
      punctuate: 'true',
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  private openSocket(): void {
    const url = this.buildUrl();
    const ws = new WebSocket(url, ['token', this.apiKey]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retryCount = 0;
      this.startKeepAlive();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data);
    });

    ws.addEventListener('close', () => {
      this.clearKeepAlive();
      if (!this.disconnecting) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      this.errorCb?.(new Error('Deepgram WebSocket error'));
    });
  }

  private handleMessage(data: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data as string) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg['type'] as string | undefined;

    if (type === 'SpeechStarted') {
      this.speechStartCb?.();
      return;
    }

    if (type === 'Results') {
      const channel = msg['channel'] as Record<string, unknown> | undefined;
      const alternatives = channel?.['alternatives'] as Array<Record<string, unknown>> | undefined;
      const transcript = (alternatives?.[0]?.['transcript'] as string) ?? '';
      const isFinalMsg = msg['is_final'] as boolean | undefined;
      const speechFinal = msg['speech_final'] as boolean | undefined;

      if (speechFinal === true) {
        this.speechEndCb?.(transcript);
        return;
      }

      if (isFinalMsg === false) {
        this.transcriptCb?.(transcript, false);
        return;
      }

      if (isFinalMsg === true) {
        this.transcriptCb?.(transcript, true);
      }
    }
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      this.errorCb?.(new Error(`Deepgram reconnect failed after ${MAX_RETRIES} attempts`));
      return;
    }
    const delay = BASE_BACKOFF_MS * Math.pow(2, this.retryCount);
    this.retryCount++;
    setTimeout(() => {
      if (!this.disconnecting) {
        this.openSocket();
      }
    }, delay);
  }
}
