export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking';

export type VoiceEvent =
  | { type: 'activate' }
  | { type: 'connected' }
  | { type: 'deactivate' }
  | { type: 'speech_end'; transcript: string }
  | { type: 'speech_start' }
  | { type: 'claude_delta'; text: string }
  | { type: 'claude_done'; fullText: string }
  | { type: 'playback_done' }
  | { type: 'silence_timeout' }
  | { type: 'error'; error: Error };

export type VoiceAction =
  | { type: 'connect_services' }
  | { type: 'start_listening' }
  | { type: 'send_to_claude'; transcript: string }
  | { type: 'discard_claude_output' }
  | { type: 'speak_to_tts'; text: string }
  | { type: 'flush_tts' }
  | { type: 'clear_tts' }
  | { type: 'stop_playback' }
  | { type: 'update_transcript'; role: 'user' | 'assistant'; text: string; interim?: boolean }
  | { type: 'show_error'; error: Error }
  | { type: 'show_silence_prompt' }
  | { type: 'cleanup' };

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  interim?: boolean;
}

export interface VoiceSettings {
  deepgramApiKey: string;
  ttsVoice: string;
  vadSensitivity: number;
}

export interface ClaudeBridge {
  start(): Promise<void>;
  sendMessage(text: string): void;
  cancel(): void;
  onTextDelta(cb: (text: string) => void): void;
  onComplete(cb: (fullText: string) => void): void;
  onError(cb: (error: Error) => void): void;
  destroy(): void;
}

export interface LatencyMetrics {
  speechEndTime: number;
  firstClaudeDelta: number;
  firstTtsAudio: number;
  firstAudioPlay: number;
}
