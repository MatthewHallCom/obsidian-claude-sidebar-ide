export default class TtsService {
	private apiKey: string;
	private voice: string;
	private ws: WebSocket | null = null;

	private audioChunkCallback: ((pcm: ArrayBuffer) => void) | null = null;
	private turnAudioDoneCallback: (() => void) | null = null;
	private errorCallback: ((error: Error) => void) | null = null;

	constructor(apiKey: string, voice = 'aura-2-asteria-en') {
		this.apiKey = apiKey;
		this.voice = voice;
	}

	connect(): void {
		if (this.ws) {
			return;
		}

		const url = `wss://api.deepgram.com/v1/speak?model=${this.voice}&encoding=linear16&sample_rate=24000&container=none`;
		this.ws = new WebSocket(url, ['token', this.apiKey]);
		this.ws.binaryType = 'blob';

		this.ws.onmessage = async (event: MessageEvent) => {
			if (event.data instanceof Blob) {
				const buffer = await event.data.arrayBuffer();
				this.audioChunkCallback?.(buffer);
			} else if (typeof event.data === 'string') {
				try {
					const msg = JSON.parse(event.data);
					if (msg.type === 'Flushed') {
						this.turnAudioDoneCallback?.();
					}
				} catch {
					// ignore non-JSON text frames
				}
			}
		};

		this.ws.onerror = () => {
			this.errorCallback?.(new Error('TTS WebSocket error'));
		};

		this.ws.onclose = () => {
			this.ws = null;
		};
	}

	disconnect(): void {
		if (!this.ws) return;
		this.send({ type: 'Close' });
		this.ws.close();
		this.ws = null;
	}

	speak(text: string): void {
		this.send({ type: 'Speak', text });
	}

	flush(): void {
		this.send({ type: 'Flush' });
	}

	clear(): void {
		this.send({ type: 'Clear' });
	}

	onAudioChunk(cb: (pcm: ArrayBuffer) => void): void {
		this.audioChunkCallback = cb;
	}

	onTurnAudioDone(cb: () => void): void {
		this.turnAudioDoneCallback = cb;
	}

	onError(cb: (error: Error) => void): void {
		this.errorCallback = cb;
	}

	private send(msg: object): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}
}
