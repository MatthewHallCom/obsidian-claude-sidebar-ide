import type { VoicePhase, VoiceEvent, VoiceAction } from './types';

export interface VoiceState {
  phase: VoicePhase;
  claudeDone: boolean;
}

export interface Transition {
  state: VoiceState;
  actions: VoiceAction[];
}

export function initialState(): VoiceState {
  return { phase: 'idle', claudeDone: false };
}

export function transition(state: VoiceState, event: VoiceEvent): Transition {
  const { phase, claudeDone } = state;

  switch (phase) {
    case 'idle':
      if (event.type === 'activate') {
        return { state: { phase: 'connecting', claudeDone: false }, actions: [{ type: 'connect_services' }] };
      }
      if (event.type === 'error') {
        return { state: { phase: 'idle', claudeDone: false }, actions: [{ type: 'show_error', error: event.error }, { type: 'cleanup' }] };
      }
      break;

    case 'connecting':
      if (event.type === 'connected') {
        return { state: { phase: 'listening', claudeDone: false }, actions: [{ type: 'start_listening' }] };
      }
      if (event.type === 'error') {
        return { state: { phase: 'idle', claudeDone: false }, actions: [{ type: 'show_error', error: event.error }, { type: 'cleanup' }] };
      }
      if (event.type === 'deactivate') {
        return { state: { phase: 'idle', claudeDone: false }, actions: [{ type: 'cleanup' }] };
      }
      break;

    case 'listening':
      if (event.type === 'speech_end') {
        return {
          state: { phase: 'processing', claudeDone: false },
          actions: [
            { type: 'send_to_claude', transcript: event.transcript },
            { type: 'update_transcript', role: 'user', text: event.transcript },
          ],
        };
      }
      if (event.type === 'silence_timeout') {
        return { state: { phase: 'listening', claudeDone: false }, actions: [{ type: 'show_silence_prompt' }] };
      }
      if (event.type === 'deactivate') {
        return { state: { phase: 'idle', claudeDone: false }, actions: [{ type: 'cleanup' }] };
      }
      break;

    case 'processing':
      if (event.type === 'claude_delta') {
        return {
          state: { phase: 'speaking', claudeDone: false },
          actions: [
            { type: 'speak_to_tts', text: event.text },
            { type: 'update_transcript', role: 'assistant', text: event.text, interim: true },
          ],
        };
      }
      if (event.type === 'speech_start') {
        return { state: { phase: 'listening', claudeDone: false }, actions: [{ type: 'discard_claude_output' }] };
      }
      if (event.type === 'deactivate') {
        return { state: { phase: 'idle', claudeDone: false }, actions: [{ type: 'cleanup' }] };
      }
      if (event.type === 'error') {
        return { state: { phase: 'listening', claudeDone: false }, actions: [{ type: 'show_error', error: event.error }] };
      }
      break;

    case 'speaking':
      if (event.type === 'claude_delta') {
        return {
          state: { phase: 'speaking', claudeDone },
          actions: [
            { type: 'speak_to_tts', text: event.text },
            { type: 'update_transcript', role: 'assistant', text: event.text, interim: true },
          ],
        };
      }
      if (event.type === 'claude_done') {
        return { state: { phase: 'speaking', claudeDone: true }, actions: [{ type: 'flush_tts' }] };
      }
      if (event.type === 'playback_done') {
        if (claudeDone) {
          return { state: { phase: 'listening', claudeDone: false }, actions: [{ type: 'start_listening' }] };
        }
        return { state: { phase: 'speaking', claudeDone }, actions: [] };
      }
      if (event.type === 'speech_start') {
        return {
          state: { phase: 'listening', claudeDone: false },
          actions: [{ type: 'discard_claude_output' }, { type: 'clear_tts' }, { type: 'stop_playback' }],
        };
      }
      if (event.type === 'deactivate') {
        return {
          state: { phase: 'idle', claudeDone: false },
          actions: [{ type: 'clear_tts' }, { type: 'stop_playback' }, { type: 'cleanup' }],
        };
      }
      if (event.type === 'error') {
        return {
          state: { phase: 'listening', claudeDone: false },
          actions: [{ type: 'clear_tts' }, { type: 'stop_playback' }, { type: 'show_error', error: event.error }],
        };
      }
      break;
  }

  return { state, actions: [] };
}
