import MicCapture from './mic-capture';
import SttService from './stt-service';
import TtsService from './tts-service';
import AudioPlayer from './audio-player';
import { initialState, transition } from './voice-state';
import type { VoiceState } from './voice-state';
import type { VoiceEvent, VoiceAction, VoicePhase, TranscriptEntry, ClaudeBridge } from './types';

const SILENCE_TIMEOUT_MS = 30_000;

interface VoiceControllerOpts {
  apiKey: string;
  ttsVoice?: string;
  vadSensitivity?: number;
  bridge: ClaudeBridge;
}

export default class VoiceController {
  private mic: MicCapture;
  private stt: SttService;
  private tts: TtsService;
  private player: AudioPlayer;
  private bridge: ClaudeBridge;

  private state: VoiceState;
  private transcriptEntries: TranscriptEntry[] = [];
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  // Latency tracking
  private speechEndTime = 0;
  private firstClaudeDeltaTime = 0;
  private firstTtsAudioTime = 0;
  private waitingForFirstDelta = false;
  private waitingForFirstAudio = false;

  // UI callbacks
  private phaseChangeCb: ((phase: VoicePhase) => void) | null = null;
  private transcriptUpdateCb: ((transcript: TranscriptEntry[]) => void) | null = null;
  private errorCb: ((error: Error) => void) | null = null;

  constructor(opts: VoiceControllerOpts) {
    this.bridge = opts.bridge;
    this.mic = new MicCapture();
    this.stt = new SttService(opts.apiKey, opts.vadSensitivity);
    this.tts = new TtsService(opts.apiKey, opts.ttsVoice);
    this.player = new AudioPlayer();
    this.state = initialState();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  activate(): void {
    this.dispatch({ type: 'activate' });
  }

  deactivate(): void {
    this.dispatch({ type: 'deactivate' });
  }

  get phase(): VoicePhase {
    return this.state.phase;
  }

  get transcript(): TranscriptEntry[] {
    return this.transcriptEntries;
  }

  getMicLevel(): number {
    return this.mic.getAudioLevel();
  }

  getPlaybackLevel(): number {
    return this.player.getAudioLevel();
  }

  onPhaseChange(cb: (phase: VoicePhase) => void): void {
    this.phaseChangeCb = cb;
  }

  onTranscriptUpdate(cb: (transcript: TranscriptEntry[]) => void): void {
    this.transcriptUpdateCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb;
  }

  // ---------------------------------------------------------------------------
  // State machine dispatch
  // ---------------------------------------------------------------------------

  private dispatch(event: VoiceEvent): void {
    const prevPhase = this.state.phase;
    const { state, actions } = transition(this.state, event);
    this.state = state;

    if (state.phase !== prevPhase) {
      this.phaseChangeCb?.(state.phase);
    }

    for (const action of actions) {
      this.execute(action);
    }
  }

  // ---------------------------------------------------------------------------
  // Action execution
  // ---------------------------------------------------------------------------

  private execute(action: VoiceAction): void {
    switch (action.type) {
      case 'connect_services':
        this.connectServices();
        break;

      case 'start_listening':
        this.waitingForFirstDelta = false;
        this.waitingForFirstAudio = false;
        this.startSilenceTimer();
        break;

      case 'send_to_claude':
        this.speechEndTime = Date.now();
        this.waitingForFirstDelta = true;
        this.waitingForFirstAudio = true;
        this.clearSilenceTimer();
        this.bridge.sendMessage(action.transcript);
        break;

      case 'discard_claude_output':
        this.clearSilenceTimer();
        this.bridge.cancel();
        break;

      case 'speak_to_tts':
        this.tts.speak(action.text);
        break;

      case 'flush_tts':
        this.tts.flush();
        break;

      case 'clear_tts':
        this.tts.clear();
        break;

      case 'stop_playback':
        this.player.stop();
        break;

      case 'update_transcript':
        this.updateTranscript(action.role, action.text, action.interim);
        break;

      case 'show_error':
        this.errorCb?.(action.error);
        break;

      case 'show_silence_prompt':
        // Notify UI — reuse error callback with a recognisable sentinel or
        // call phaseChangeCb without state change; simplest: fire error-cb
        // with a typed message so the UI can distinguish it.
        this.errorCb?.(new Error('silence_prompt'));
        break;

      case 'cleanup':
        this.cleanup();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Service wiring
  // ---------------------------------------------------------------------------

  private async connectServices(): Promise<void> {
    try {
      // Register callbacks before connecting so no events are missed.
      this.mic.onAudioData((pcm) => {
        this.stt.sendAudio(pcm);
      });

      this.stt.onSpeechStart(() => {
        this.dispatch({ type: 'speech_start' });
      });

      this.stt.onSpeechEnd((transcript) => {
        this.dispatch({ type: 'speech_end', transcript });
      });

      this.stt.onTranscript((text, _isFinal) => {
        // Interim transcript — update UI without going through state machine.
        const interim: TranscriptEntry[] = [
          ...this.transcriptEntries,
          { role: 'user', text, interim: true },
        ];
        this.transcriptUpdateCb?.(interim);
      });

      this.stt.onError((err) => {
        this.dispatch({ type: 'error', error: err });
      });

      this.bridge.onTextDelta((text) => {
        if (this.waitingForFirstDelta) {
          this.firstClaudeDeltaTime = Date.now();
          this.waitingForFirstDelta = false;
        }
        this.dispatch({ type: 'claude_delta', text });
      });

      this.bridge.onComplete((fullText) => {
        this.dispatch({ type: 'claude_done', fullText });
      });

      this.bridge.onError((err) => {
        this.dispatch({ type: 'error', error: err });
      });

      this.tts.onAudioChunk((pcm) => {
        if (this.waitingForFirstAudio) {
          this.firstTtsAudioTime = Date.now();
          this.waitingForFirstAudio = false;
          const ttfa = this.firstTtsAudioTime - this.speechEndTime;
          console.debug(`[VoiceController] TTFA: ${ttfa}ms (Claude latency: ${this.firstClaudeDeltaTime - this.speechEndTime}ms)`);
        }
        this.player.enqueue(pcm);
      });

      this.tts.onTurnAudioDone(() => {
        // Nothing — playback_done comes from the player when the queue drains.
      });

      this.tts.onError((err) => {
        this.dispatch({ type: 'error', error: err });
      });

      this.player.onPlaybackDone(() => {
        this.dispatch({ type: 'playback_done' });
      });

      // Now actually start everything.
      this.stt.connect();
      this.tts.connect();
      await this.mic.start();
      await this.bridge.start();

      this.dispatch({ type: 'connected' });
    } catch (err) {
      this.dispatch({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  // ---------------------------------------------------------------------------
  // Transcript management
  // ---------------------------------------------------------------------------

  private updateTranscript(role: 'user' | 'assistant', text: string, interim?: boolean): void {
    if (interim) {
      // Append or extend the last interim entry for this role.
      const last = this.transcriptEntries[this.transcriptEntries.length - 1];
      if (last && last.role === role && last.interim) {
        last.text += text;
      } else {
        this.transcriptEntries.push({ role, text, interim: true });
      }
    } else {
      // Finalise: replace trailing interim entries of the same role.
      const last = this.transcriptEntries[this.transcriptEntries.length - 1];
      if (last && last.role === role && last.interim) {
        last.text = text;
        last.interim = false;
      } else {
        this.transcriptEntries.push({ role, text });
      }
    }
    this.transcriptUpdateCb?.([...this.transcriptEntries]);
  }

  // ---------------------------------------------------------------------------
  // Silence timer
  // ---------------------------------------------------------------------------

  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.dispatch({ type: 'silence_timeout' });
    }, SILENCE_TIMEOUT_MS);
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    this.clearSilenceTimer();
    this.mic.stop();
    this.stt.disconnect();
    this.tts.disconnect();
    this.player.destroy();
    this.bridge.destroy();
  }
}
