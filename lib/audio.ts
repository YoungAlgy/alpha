"use client";

// Lightweight Web Audio synth for Alpha's nostalgic UI sounds.
// No audio files — every chime is generated in-browser at run time.
// Tuned to feel like a soft Kirby / Animal Crossing / Game Boy sound palette.

const STORAGE_KEY = "alpha-audio";

let _ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (_ctx) return _ctx;
  try {
    const AC = (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    _ctx = new AC();
    return _ctx;
  } catch {
    return null;
  }
}

export function isAudioEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const v = localStorage.getItem(STORAGE_KEY);
  // Default: ON. Users can turn it off; we remember.
  return v !== "off";
}

export function setAudioEnabled(on: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
}

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  release?: number;
}

function tone(
  freq: number,
  duration: number,
  { type = "sine", gain = 0.13, attack = 0.012, release = 0.06 }: ToneOptions = {}
): void {
  const ctx = getCtx();
  if (!ctx) return;
  // Browsers suspend the context until first user gesture.
  if (ctx.state === "suspended") ctx.resume().catch(() => undefined);

  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.linearRampToValueAtTime(gain * 0.7, t + duration - release);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function play(fn: () => void) {
  if (!isAudioEnabled()) return;
  try {
    fn();
  } catch {
    // Ignore — audio is decorative.
  }
}

// === Sound palette ===

// Tiny tactile "pop" — single selection / tap.
export function tap(): void {
  play(() => tone(880, 0.08, { type: "triangle", gain: 0.09 }));
}

// Soft confirmation chime — Continue / submit.
export function confirm(): void {
  play(() => {
    tone(660, 0.1, { type: "sine", gain: 0.12 });
    setTimeout(() => tone(990, 0.14, { type: "sine", gain: 0.1 }), 70);
  });
}

// Gentle picker chime — theme switch / topic add.
export function chime(): void {
  play(() => tone(1320, 0.16, { type: "sine", gain: 0.09 }));
}

// Negative deselect — topic remove.
export function unselect(): void {
  play(() => tone(330, 0.09, { type: "triangle", gain: 0.08 }));
}

// Step-complete chime in the /writing page — climbing notes.
export function stepDone(index = 0): void {
  play(() => {
    const base = [523, 587, 659, 698, 784]; // C5 D5 E5 F5 G5
    tone(base[index % base.length], 0.14, { type: "sine", gain: 0.1 });
  });
}

// Kirby-style fanfare — "your letter is ready," subscribe success.
export function fanfare(): void {
  play(() => {
    const notes = [523, 659, 784, 1047, 1319]; // C5 E5 G5 C6 E6
    notes.forEach((f, i) => {
      setTimeout(() => tone(f, 0.22, { type: "triangle", gain: 0.13 }), i * 90);
    });
  });
}
