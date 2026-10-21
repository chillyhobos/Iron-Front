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
  engineer: 'smg-shot',
};

/** Which footstep each terrain makes (infantry only; sea can't be walked on). */
const FOOTSTEP_SOUNDS: Partial<Record<string, SoundName>> = {
  plain: 'step-grass',
  forest: 'step-leaves',
  mountain: 'step-gravel',
  road: 'step-hard', city: 'step-hard', factory: 'step-hard', hq: 'step-hard', port: 'step-hard', airfield: 'step-hard',
  bridge: 'step-bridge',
  river: 'step-water',
};

/**
 * Which engine loop each vehicle, aircraft and ship makes while it moves, and how fast
 * it plays (slower is bigger and deeper). Infantry use footsteps instead.
 */
const DRIVE_SOUNDS: Partial<Record<string, [SoundName, number]>> = {
  ltank: ['drive-treads', 1.05], htank: ['drive-treads', 0.8], apc: ['drive-treads', 1.15],
  artillery: ['drive-treads', 0.95], flak: ['drive-treads', 1],
  scout: ['drive-tires', 1.15], rocket: ['drive-tires', 0.85], missile: ['drive-tires', 0.92],
  fighter: ['fly-jet', 1.1], bomber: ['fly-jet', 0.82],
  gunship: ['fly-rotor', 1], airlift: ['fly-rotor', 0.86],
  cruiser: ['sail', 1.05], battleship: ['sail', 0.85], lander: ['sail', 1],
};

/** An engine keeps running this long after its unit's last tile, then fades (a tile takes 70–90 ms). */
const ENGINE_HOLD_MS = 160;
/** How quickly an engine fades in and out (time constant, seconds). */
const ENGINE_FADE_IN = 0.02;
const ENGINE_FADE_OUT = 0.06;

type Prefs = { volume: number; muted: boolean };
type Engine = { type: string; source: AudioBufferSourceNode; gain: GainNode; hold: number };

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private clips = new Map<SoundName, AudioBuffer[]>();
  private voices = 0;
  private listeners = new Set<() => void>();
  private rand = seeded(Date.now());
  /** The moving vehicle's engine, while one is moving (one at a time, as moves are). */
  private engine: Engine | null = null;
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
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stopEngine(); });
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
    if (c === 'footstep' && detail) {
      const name = FOOTSTEP_SOUNDS[detail];
      if (name) this.play(name);
    }
    if (c === 'drive' && detail) this.drive(detail);
    // Engineers: blowing up a bridge, and fixing one (only Engineers repair bridges).
    if (c === 'bridge-destroyed' && detail === 'engineer') this.play('demolition');
    if (c === 'bridge-repaired') this.play('bridge-repair');
  }

  /** Whether sounds can play right now (started, audible, tab in view, voices to spare). */
  private canPlay(): boolean {
    return !!this.ctx && !!this.master && !this.muted && this.volume > 0 && !document.hidden
      && this.ctx.state === 'running' && this.voices < MAX_VOICES;
  }

  /**
   * A vehicle entered a tile: start its engine loop, or keep it running. It fades out
   * once tiles stop coming (the move ended, or the unit drove out of sight).
   */
  private drive(type: string) {
    const entry = DRIVE_SOUNDS[type];
    if (!entry) return;
    if (this.engine && this.engine.type !== type) this.stopEngine();
    if (!this.engine) {
      const clips = this.clips.get(entry[0]);
      if (!clips || !this.canPlay()) return;
      const ctx = this.ctx!;
      const source = ctx.createBufferSource();
      source.buffer = clips[Math.floor(this.rand() * clips.length)];
      source.loop = true;
      source.playbackRate.value = entry[1] * (0.97 + this.rand() * 0.06);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(SFX_LEVEL * (0.85 + this.rand() * 0.15), ctx.currentTime, ENGINE_FADE_IN); // same level as every sound
      source.connect(gain).connect(this.master!);
      this.track(source, gain);
      // Start somewhere in the loop, so back-to-back moves don't all begin alike.
      source.start(0, this.rand() * source.buffer.duration);
      this.engine = { type, source, gain, hold: 0 };
    }
    const engine = this.engine;
    clearTimeout(engine.hold);
    engine.hold = window.setTimeout(() => { if (this.engine === engine) this.stopEngine(); }, ENGINE_HOLD_MS);
  }

  private stopEngine() {
    const engine = this.engine;
    if (!engine || !this.ctx) return;
    this.engine = null;
    clearTimeout(engine.hold);
    const now = this.ctx.currentTime;
    engine.gain.gain.cancelScheduledValues(now);
    engine.gain.gain.setTargetAtTime(0, now, ENGINE_FADE_OUT);
    engine.source.stop(now + ENGINE_FADE_OUT * 6);
  }

  /** Count a voice while it plays, and let it go when it ends. */
  private track(source: AudioBufferSourceNode, gain: GainNode) {
    this.voices++;
    source.onended = () => {
      this.voices--;
      source.disconnect();
      gain.disconnect();
    };
  }

  /** Play one of a sound's variants, slightly varied so repeats don't sound robotic. */
  play(name: SoundName) {
    const ctx = this.ctx;
    const clips = this.clips.get(name);
    if (!ctx || !clips || !this.canPlay()) return;
    const source = ctx.createBufferSource();
    source.buffer = clips[Math.floor(this.rand() * clips.length)];
    source.playbackRate.value = 0.96 + this.rand() * 0.08;
    const gain = ctx.createGain();
    gain.gain.value = SFX_LEVEL * (0.85 + this.rand() * 0.15); // every sound at the same level
    source.connect(gain).connect(this.master!);
    this.track(source, gain);
    source.start();
  }
}

/** The game's one sound engine (made when the game loads). */
export const sound = new SoundEngine();
