import { TranscriptEntry } from './types';

export default class TranscriptDisplay {
  private container: HTMLElement;
  private scrollEl: HTMLElement;
  private entryEls: HTMLElement[] = [];
  private userScrolled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'voice-transcript';
    this.container.appendChild(this.scrollEl);

    this.scrollEl.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
      this.userScrolled = scrollTop + clientHeight < scrollHeight - 8;
    });
  }

  update(entries: TranscriptEntry[]): void {
    // Add or update nodes; remove excess
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (i < this.entryEls.length) {
        this.applyEntry(this.entryEls[i], entry);
      } else {
        const el = document.createElement('div');
        this.applyEntry(el, entry);
        this.scrollEl.appendChild(el);
        this.entryEls.push(el);
      }
    }

    // Remove extra nodes if entries shrank
    while (this.entryEls.length > entries.length) {
      const el = this.entryEls.pop()!;
      el.remove();
    }

    if (!this.userScrolled) {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    }
  }

  private applyEntry(el: HTMLElement, entry: TranscriptEntry): void {
    el.className = [
      'voice-transcript-entry',
      `voice-transcript-${entry.role}`,
      entry.interim ? 'voice-transcript-interim' : '',
    ]
      .filter(Boolean)
      .join(' ');

    if (el.textContent !== entry.text) {
      el.textContent = entry.text;
    }
  }

  destroy(): void {
    this.scrollEl.remove();
    this.entryEls = [];
  }
}
