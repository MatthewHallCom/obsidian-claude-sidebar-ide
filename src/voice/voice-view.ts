import type VoiceController from './voice-controller';
import OrbVisualizer from './orb-visualizer';
import TranscriptDisplay from './transcript-display';
import type { VoicePhase, TranscriptEntry } from './types';

const PHASE_LABELS: Record<VoicePhase, string> = {
  idle:       '',
  connecting: 'Connecting...',
  listening:  'Listening...',
  processing: 'Thinking...',
  speaking:   'Speaking...',
};

const ERROR_DISPLAY_MS = 3000;

export default class VoiceView {
  private overlay: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private phaseLabel: HTMLElement;
  private orbContainer: HTMLElement;
  private transcriptContainer: HTMLElement;

  private orb: OrbVisualizer;
  private transcript: TranscriptDisplay;

  private controller: VoiceController;
  private rafId: number | null = null;
  private visible = false;

  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private savedPhaseLabel = '';

  constructor(container: HTMLElement, controller: VoiceController) {
    this.controller = controller;

    // Overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'voice-overlay';
    this.overlay.style.cssText = `
      position: absolute;
      inset: 0;
      z-index: 1000;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      background: rgba(0, 0, 0, 0.82);
      padding: 16px;
      box-sizing: border-box;
    `;

    // Close button
    this.closeBtn = document.createElement('button');
    this.closeBtn.className = 'voice-close-btn';
    this.closeBtn.setAttribute('aria-label', 'Close voice mode');
    this.closeBtn.style.cssText = `
      position: absolute;
      top: 12px;
      right: 12px;
      width: 44px;
      height: 44px;
      border: none;
      background: rgba(255, 255, 255, 0.12);
      color: rgba(255, 255, 255, 0.8);
      border-radius: 50%;
      cursor: pointer;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    `;
    this.closeBtn.textContent = '×';
    this.closeBtn.addEventListener('click', () => {
      this.controller.deactivate();
      this.hide();
    });

    // Phase label
    this.phaseLabel = document.createElement('div');
    this.phaseLabel.className = 'voice-phase-label';
    this.phaseLabel.style.cssText = `
      margin-top: 64px;
      margin-bottom: 24px;
      color: rgba(255, 255, 255, 0.85);
      font-size: 16px;
      font-weight: 500;
      letter-spacing: 0.03em;
      min-height: 22px;
      text-align: center;
    `;

    // Orb container
    this.orbContainer = document.createElement('div');
    this.orbContainer.className = 'voice-orb-container';
    this.orbContainer.style.cssText = `
      width: 200px;
      height: 200px;
      flex-shrink: 0;
      margin-bottom: 24px;
    `;

    // Transcript container
    this.transcriptContainer = document.createElement('div');
    this.transcriptContainer.className = 'voice-transcript-container';
    this.transcriptContainer.style.cssText = `
      width: 100%;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;

    // Assemble
    this.overlay.appendChild(this.closeBtn);
    this.overlay.appendChild(this.phaseLabel);
    this.overlay.appendChild(this.orbContainer);
    this.overlay.appendChild(this.transcriptContainer);
    container.appendChild(this.overlay);

    // Sub-components
    this.orb = new OrbVisualizer(this.orbContainer);
    this.transcript = new TranscriptDisplay(this.transcriptContainer);

    // Wire controller callbacks
    this.controller.onPhaseChange((phase: VoicePhase) => {
      this.orb.setPhase(phase);
      this.setPhaseLabel(PHASE_LABELS[phase]);
    });

    this.controller.onTranscriptUpdate((entries: TranscriptEntry[]) => {
      this.transcript.update(entries);
    });

    this.controller.onError((err: Error) => {
      if (err.message === 'silence_prompt') {
        this.showTemporaryLabel('Still there? Say something...', ERROR_DISPLAY_MS);
      } else {
        this.showTemporaryLabel(`Error: ${err.message}`, ERROR_DISPLAY_MS);
      }
    });
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.overlay.style.display = 'flex';
    this.controller.activate();
    this.startAnimationLoop();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.stopAnimationLoop();
    this.overlay.style.display = 'none';
  }

  destroy(): void {
    this.hide();
    this.orb.destroy();
    this.transcript.destroy();
    if (this.errorTimer !== null) {
      clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
    this.overlay.remove();
  }

  // ---------------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------------

  private startAnimationLoop(): void {
    const tick = () => {
      if (!this.visible) return;

      const phase = this.controller.phase;
      let level = 0;
      if (phase === 'listening') {
        level = this.controller.getMicLevel();
      } else if (phase === 'speaking') {
        level = this.controller.getPlaybackLevel();
      }
      this.orb.setAudioLevel(level);

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopAnimationLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Phase label helpers
  // ---------------------------------------------------------------------------

  private setPhaseLabel(text: string): void {
    this.savedPhaseLabel = text;
    // Only update if no temporary error message is showing
    if (this.errorTimer === null) {
      this.phaseLabel.textContent = text;
    }
  }

  private showTemporaryLabel(text: string, durationMs: number): void {
    if (this.errorTimer !== null) {
      clearTimeout(this.errorTimer);
    }
    this.phaseLabel.textContent = text;
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      this.phaseLabel.textContent = this.savedPhaseLabel;
    }, durationMs);
  }
}
