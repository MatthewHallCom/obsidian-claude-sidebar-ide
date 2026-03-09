import { VoicePhase } from './types';

interface OrbColor {
  h: number;
  s: number;
  l: number;
}

interface OrbState {
  radius: number;
  glowRadius: number;
  opacity: number;
  color: OrbColor;
  rotation: number;
}

const PHASE_COLORS: Record<VoicePhase, OrbColor> = {
  idle:       { h: 30,  s: 60,  l: 40 },
  connecting: { h: 30,  s: 90,  l: 55 },
  listening:  { h: 30,  s: 100, l: 60 },
  processing: { h: 220, s: 80,  l: 60 },
  speaking:   { h: 20,  s: 100, l: 65 },
};

const PHASE_OPACITY: Record<VoicePhase, number> = {
  idle:       0.35,
  connecting: 0.75,
  listening:  0.90,
  processing: 0.90,
  speaking:   0.95,
};

const BASE_RADIUS = 60;
const CANVAS_SIZE = 200;

function lerpColor(a: OrbColor, b: OrbColor, t: number): OrbColor {
  return {
    h: a.h + (b.h - a.h) * t,
    s: a.s + (b.s - a.s) * t,
    l: a.l + (b.l - a.l) * t,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

export default class OrbVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rafId: number | null = null;

  private phase: VoicePhase = 'idle';
  private audioLevel: number = 0;

  // Animation time
  private startTime: number = 0;
  private now: number = 0;

  // Transition state
  private fromState: OrbState;
  private targetState: OrbState;
  private transitionStart: number = 0;
  private readonly TRANSITION_MS = 300;

  // Connecting phase: dot ring
  private readonly NUM_DOTS = 8;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.canvas.style.cssText = `
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 50%;
    `;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;

    container.appendChild(this.canvas);

    const initial = this.buildTargetForPhase('idle', 0);
    this.fromState = { ...initial };
    this.targetState = { ...initial };

    this.startTime = performance.now();
    this.scheduleFrame();
  }

  setPhase(phase: VoicePhase): void {
    if (phase === this.phase) return;
    this.phase = phase;

    // Snapshot current interpolated state as the new "from"
    const t = this.now;
    this.fromState = this.interpolateState(t);
    this.targetState = this.buildTargetForPhase(phase, t);
    this.transitionStart = t;
  }

  setAudioLevel(level: number): void {
    this.audioLevel = Math.max(0, Math.min(1, level));
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.canvas.remove();
  }

  // ----- Private -----

  private buildTargetForPhase(phase: VoicePhase, _t: number): OrbState {
    return {
      radius: BASE_RADIUS,
      glowRadius: BASE_RADIUS * 1.5,
      opacity: PHASE_OPACITY[phase],
      color: { ...PHASE_COLORS[phase] },
      rotation: 0,
    };
  }

  private interpolateState(t: number): OrbState {
    const elapsed = t - this.transitionStart;
    const raw = Math.min(elapsed / this.TRANSITION_MS, 1);
    const ease = easeInOut(raw);

    return {
      radius:     lerp(this.fromState.radius,     this.targetState.radius,     ease),
      glowRadius: lerp(this.fromState.glowRadius, this.targetState.glowRadius, ease),
      opacity:    lerp(this.fromState.opacity,     this.targetState.opacity,    ease),
      color:      lerpColor(this.fromState.color,  this.targetState.color,      ease),
      rotation:   lerp(this.fromState.rotation,    this.targetState.rotation,   ease),
    };
  }

  private scheduleFrame(): void {
    this.rafId = requestAnimationFrame((ts) => {
      this.now = ts - this.startTime;
      this.draw(this.now);
      this.scheduleFrame();
    });
  }

  private draw(t: number): void {
    const { ctx } = this;
    const cx = CANVAS_SIZE / 2;
    const cy = CANVAS_SIZE / 2;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const base = this.interpolateState(t);

    // Phase-specific dynamic radius modulation
    const dynRadius = this.computeDynamicRadius(base.radius, t);
    const dynGlow   = dynRadius * 1.55;

    const { h, s, l } = base.color;
    const opacity = base.opacity;

    // Outer glow layer
    this.drawGlow(cx, cy, dynGlow, h, s, l, opacity * 0.35);

    // Mid glow
    this.drawGlow(cx, cy, dynRadius * 1.18, h, s, l + 10, opacity * 0.5);

    // Core orb
    this.drawOrb(cx, cy, dynRadius, h, s, l, opacity);

    // Bright center highlight
    this.drawHighlight(cx, cy, dynRadius, opacity);

    // Phase overlays
    if (this.phase === 'connecting') {
      this.drawConnectingRing(cx, cy, dynRadius, t, h, s, l, base.opacity);
    } else if (this.phase === 'processing') {
      this.drawProcessingArc(cx, cy, dynRadius, t, h, s, l, opacity);
    }
  }

  private computeDynamicRadius(base: number, t: number): number {
    const secs = t / 1000;

    switch (this.phase) {
      case 'idle': {
        // Very slow, subtle breathe
        const breathe = Math.sin(secs * 0.8) * 2;
        return base + breathe;
      }
      case 'connecting': {
        // Moderate pulse
        const pulse = Math.sin(secs * 3) * 4;
        return base + pulse;
      }
      case 'listening': {
        // Breathe + strong audio response
        const breathe = Math.sin(secs * 1.4) * 3;
        const audio   = this.audioLevel * 22;
        return base + breathe + audio;
      }
      case 'processing': {
        // Gentle morph — slightly elongated feel via radius flicker
        const morph = Math.sin(secs * 5) * 3 + Math.sin(secs * 3.3) * 2;
        return base + morph;
      }
      case 'speaking': {
        // Fast pulse driven by audio level
        const breathe = Math.sin(secs * 2) * 2;
        const audio   = this.audioLevel * 25;
        const flutter = Math.sin(secs * 12) * this.audioLevel * 4;
        return base + breathe + audio + flutter;
      }
      default:
        return base;
    }
  }

  private drawGlow(
    cx: number, cy: number, r: number,
    h: number, s: number, l: number,
    alpha: number,
  ): void {
    const grad = this.ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0,   `hsla(${h},${s}%,${l + 15}%,${alpha})`);
    grad.addColorStop(0.5, `hsla(${h},${s}%,${l}%,${alpha * 0.5})`);
    grad.addColorStop(1,   `hsla(${h},${s}%,${l}%,0)`);

    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.fillStyle = grad;
    this.ctx.fill();
  }

  private drawOrb(
    cx: number, cy: number, r: number,
    h: number, s: number, l: number,
    opacity: number,
  ): void {
    const grad = this.ctx.createRadialGradient(
      cx - r * 0.25, cy - r * 0.25, r * 0.05,
      cx, cy, r,
    );
    grad.addColorStop(0,    `hsla(${h},${s}%,${Math.min(l + 30, 95)}%,${opacity})`);
    grad.addColorStop(0.35, `hsla(${h},${s}%,${l + 10}%,${opacity})`);
    grad.addColorStop(0.75, `hsla(${h},${s}%,${l}%,${opacity})`);
    grad.addColorStop(1,    `hsla(${h},${s}%,${Math.max(l - 20, 10)}%,${opacity * 0.8})`);

    this.ctx.beginPath();
    this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
    this.ctx.fillStyle = grad;
    this.ctx.fill();
  }

  private drawHighlight(cx: number, cy: number, r: number, opacity: number): void {
    const hx = cx - r * 0.28;
    const hy = cy - r * 0.28;
    const hr = r * 0.38;

    const grad = this.ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
    grad.addColorStop(0,   `rgba(255,255,255,${opacity * 0.55})`);
    grad.addColorStop(0.5, `rgba(255,255,255,${opacity * 0.15})`);
    grad.addColorStop(1,   `rgba(255,255,255,0)`);

    this.ctx.beginPath();
    this.ctx.arc(hx, hy, hr, 0, Math.PI * 2);
    this.ctx.fillStyle = grad;
    this.ctx.fill();
  }

  private drawConnectingRing(
    cx: number, cy: number, orbR: number, t: number,
    h: number, s: number, l: number, opacity: number,
  ): void {
    const secs = t / 1000;
    const ringR = orbR + 18;
    const dotR  = 4;
    const spin  = secs * 1.8; // radians per second

    for (let i = 0; i < this.NUM_DOTS; i++) {
      const angle = spin + (i / this.NUM_DOTS) * Math.PI * 2;
      const dx = cx + Math.cos(angle) * ringR;
      const dy = cy + Math.sin(angle) * ringR;

      // Each dot pulses offset in phase
      const phaseOff = (i / this.NUM_DOTS) * Math.PI * 2;
      const dotOpacity = opacity * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(secs * 4 + phaseOff)));

      this.ctx.beginPath();
      this.ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
      this.ctx.fillStyle = `hsla(${h},${s}%,${l + 10}%,${dotOpacity})`;
      this.ctx.fill();
    }
  }

  private drawProcessingArc(
    cx: number, cy: number, orbR: number, t: number,
    h: number, s: number, l: number, opacity: number,
  ): void {
    const secs = t / 1000;
    const arcR  = orbR + 12;
    const speed = secs * 2.5;

    // Two counter-rotating arcs for a dynamic feel
    for (let i = 0; i < 2; i++) {
      const dir   = i === 0 ? 1 : -1;
      const start = speed * dir;
      const end   = start + Math.PI * 1.1;

      const arcOpacity = opacity * 0.7;
      const hShift = h + i * 15;

      this.ctx.beginPath();
      this.ctx.arc(cx, cy, arcR, start, end);
      this.ctx.strokeStyle = `hsla(${hShift},${s}%,${l + 15}%,${arcOpacity})`;
      this.ctx.lineWidth = 2.5;
      this.ctx.lineCap = 'round';
      this.ctx.stroke();
    }

    // A trailing glow dot at the arc head
    const headAngle = speed * 2.5;
    const gx = cx + Math.cos(headAngle) * arcR;
    const gy = cy + Math.sin(headAngle) * arcR;
    const dotGrad = this.ctx.createRadialGradient(gx, gy, 0, gx, gy, 7);
    dotGrad.addColorStop(0,   `hsla(${h},${s}%,${l + 20}%,${opacity})`);
    dotGrad.addColorStop(1,   `hsla(${h},${s}%,${l}%,0)`);
    this.ctx.beginPath();
    this.ctx.arc(gx, gy, 7, 0, Math.PI * 2);
    this.ctx.fillStyle = dotGrad;
    this.ctx.fill();
  }
}
