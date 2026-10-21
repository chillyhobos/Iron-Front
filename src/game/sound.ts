// Sound: plays effects on the game's cues, in step with what's on screen, offline and
// online alike. Clips are made once by the recipes in synth.ts (a few variants each)
// when sound starts; after that each shot just replays a ready clip with a slight
// change of pitch and loudness, which is about the cheapest thing Web Audio can do.
//
// Browsers only allow sound after the player clicks or presses a key, so the engine
// starts on the first one. Volume and mute are remembered in this browser.

import { onCue, type Cue } from './cues';
import { RECIPES, seeded, SFX_LEVEL, type SoundName } from './synth';

const PREFS_KEY = 'iron-front.sound';
/** More overlapping sounds than this are dropped (keeps big battles cheap and clear). */
const MAX_VOICES = 16;

/** Which sound each unit's shots make. Units not listed are silent for now. */
const FIRE_SOUNDS: Partial<Record<string, SoundName>> = {
  rifle: 'rifle-shot',
};

type Prefs = { volume: number; muted: boolean };

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private clips = new Map<SoundName, AudioBuffer[]>();
  private voices = 0;
  private listeners = new Set<() => void>();
  private rand = seeded(Date.now());
  /** 0–1, as on the slider. */
  volume = 0.6;
  muted = false;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Prefs | null;
      if (saved) {
        this.volume = Math.min(1, Math.max(0, Number(saved.volume) || 0));
        this.muted = !!saved.muted;
      }
    } catch {
      // Defaults then.
    }
    // Start on the first click or key press (the browser's rule for sound).
    const start = () => this.start();
    window.addEventListener('pointerdown', start, { capture: true });
    window.addEventListener('keydown', start, { capture: true });
    onCue((c, detail) => this.onCue(c, detail));
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.volume > 0) this.muted = false;
    this.changed();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.changed();
  }

  /** Called whenever volume or mute changes (to update buttons). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: this.volume, muted: this.muted } satisfies Prefs));
    } catch {
      // Just not remembered.
    }
    this.applyVolume();
    for (const l of this.listeners) l();
  }

  private applyVolume() {
    if (!this.master || !this.ctx) return;
    // The slider feels even when loudness follows its square.
    const gain = this.muted ? 0 : this.volume * this.volume;
    this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.015);
  }

  private start() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return; // No Web Audio: the game just stays silent.
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
      this.applyVolume();
      // Make every clip now, once, so nothing is computed mid-battle.
      for (const name of Object.keys(RECIPES) as SoundName[]) {
        const { make, variants } = RECIPES[name];
        const clips: AudioBuffer[] = [];
        for (let v = 0; v < variants; v++) {
          const data = make(this.ctx.sampleRate, v + 1);
          const buffer = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
          buffer.getChannelData(0).set(data);
          clips.push(buffer);
        }
        this.clips.set(name, clips);
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private onCue(c: Cue, detail?: string) {
    if (c === 'fire' && detail) {
      const name = FIRE_SOUNDS[detail];
      if (name) this.play(name);
    }
  }

  /** Play one of a sound's variants, slightly varied so repeats don't sound robotic. */
  play(name: SoundName) {
    const ctx = this.ctx;
    const clips = this.clips.get(name);
    if (!ctx || !this.master || !clips || this.muted || this.volume === 0 || document.hidden) return;
    if (ctx.state !== 'running' || this.voices >= MAX_VOICES) return;
    const source = ctx.createBufferSource();
    source.buffer = clips[Math.floor(this.rand() * clips.length)];
    source.playbackRate.value = 0.96 + this.rand() * 0.08;
    const gain = ctx.createGain();
    gain.gain.value = SFX_LEVEL * (0.85 + this.rand() * 0.15); // every sound at the same level
    source.connect(gain).connect(this.master);
    this.voices++;
    source.onended = () => {
      this.voices--;
      source.disconnect();
      gain.disconnect();
    };
    source.start();
  }
}

/** The game's one sound engine (made when the game loads). */
export const sound = new SoundEngine();
