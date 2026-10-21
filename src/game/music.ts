// Background music: calm electronic music, made in code as it plays (original, like
// everything else). When units attack it picks up into a faster battle groove, with an
// accent on each attack, and eases back to calm a few bars after the fighting stops.
//
// A small step sequencer: every 50 ms it schedules the next fraction of a second of
// 16th-note steps on the audio clock, so the beat stays steady even when the game is
// busy. Instruments are plain Web Audio oscillators and filters, plus a few drum hits
// made once; a shared reverb and an echo give it space. It pauses while the tab is
// hidden and does no work at all while the music is turned down to zero.

import { band, render, seeded } from './synth';

type Mode = 'calm' | 'battle';
type Drum = 'hat' | 'open' | 'clap' | 'shaker' | 'crash';
type Chord = { bass: number; notes: number[] }; // MIDI note numbers

const BPM: Record<Mode, number> = { calm: 84, battle: 100 };

/** The chords of each part (A minor throughout), and how many bars each lasts. */
const SECTIONS: Record<Mode, { barsPerChord: number; chords: Chord[] }> = {
  calm: {
    barsPerChord: 2,
    chords: [
      { bass: 45, notes: [60, 64, 67, 71] }, // Am9
      { bass: 41, notes: [57, 60, 64, 67] }, // Fmaj9
      { bass: 48, notes: [55, 59, 62, 64] }, // Cmaj9
      { bass: 43, notes: [59, 62, 64, 69] }, // G6/9
    ],
  },
  battle: {
    barsPerChord: 1,
    chords: [
      { bass: 45, notes: [57, 60, 64, 71] }, // Am(add9)
      { bass: 41, notes: [53, 57, 60, 67] }, // F(add9)
      { bass: 43, notes: [55, 59, 62, 69] }, // G(add9)
      { bass: 40, notes: [52, 55, 59, 62] }, // Em7
    ],
  },
};

/** Calm arpeggio: [16th step, chord note] pairs, two patterns taking turns by bar. */
const CALM_ARP: [number, number][][] = [
  [[0, 0], [3, 2], [6, 3], [8, 1], [11, 2], [14, 3]],
  [[0, 1], [4, 3], [7, 2], [10, 0], [12, 2], [14, 1]],
];
/** Battle arpeggio: a chord note on every 16th, up and down. */
const BATTLE_ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2];

/** How far ahead notes are scheduled (seconds), and how often the scheduler wakes. */
const LOOKAHEAD = 0.2;
const TICK_MS = 50;
/** The battle groove keeps going this many bars after the last attack. */
const BATTLE_HOLD_BARS = 4;
/** At most one attack accent (a crash and a chord stab) this often (seconds): attacks fire several shots. */
const ACCENT_GAP = 1.2;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Music {
  private ctx: AudioContext;
  /** Everything, dry; then the music slider and fades. */
  private bus: GainNode;
  private out: GainNode;
  private verb: GainNode;   // send into the reverb
  private echo: DelayNode;
  private echoIn: GainNode; // send into the echo
  private drums: Record<Drum, AudioBuffer>;
  private level = 0;
  private timer: number;

  private mode: Mode = 'calm';
  private step = 0;          // 16th within the bar
  private bar = 0;           // bar within the current part
  private nextTime = 0;      // when the next step plays (0: stopped)
  private chord: Chord = SECTIONS.calm.chords[0];
  private freshPart = true;  // the next bar starts a part from its first chord
  private battleBarsLeft = 0;
  private wantBattle = false;
  private wantAccent = false;
  private lastAccent = -Infinity;
  private pad: { gain: GainNode; end: number } | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);
    this.bus = ctx.createGain();
    this.bus.connect(this.out);

    // Reverb: a soft, dark, 2.6 s room made from decaying noise.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.roomImpulse();
    const verbReturn = ctx.createGain();
    verbReturn.gain.value = 0.55;
    this.verb = ctx.createGain();
    this.verb.connect(reverb).connect(verbReturn).connect(this.out);

    // Echo: dotted-eighth repeats that get darker as they fade.
    this.echo = ctx.createDelay(2);
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const darken = ctx.createBiquadFilter();
    darken.type = 'lowpass';
    darken.frequency.value = 2200;
    this.echoIn = ctx.createGain();
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.5;
    this.echoIn.connect(this.echo);
    this.echo.connect(darken).connect(feedback).connect(this.echo);
    this.echo.connect(echoOut);
    echoOut.connect(this.bus);
    echoOut.connect(this.verb);
    this.setEchoTime(ctx.currentTime);

    const rate = ctx.sampleRate;
    const buffer = (data: Float32Array) => {
      const b = ctx.createBuffer(1, data.length, rate);
      b.getChannelData(0).set(data);
      return b;
    };
    const hiss = band(7000, 14000, rate), hissOpen = band(6000, 13000, rate), shake = band(4000, 10000, rate);
    const clapBand = band(900, 3500, rate), crashBand = band(3000, 12000, rate);
    this.drums = {
      hat: buffer(render(rate, 1, 0.06, (t, n) => hiss(n) * Math.exp(-t * 90))),
      open: buffer(render(rate, 2, 0.35, (t, n) => hissOpen(n) * Math.exp(-t * 12))),
      shaker: buffer(render(rate, 3, 0.1, (t, n) => shake(n) * Math.min(1, t / 0.012) * Math.exp(-t * 45))),
      // A clap: three quick slaps, then a short tail.
      clap: buffer(render(rate, 4, 0.3, (t, n) => {
        const slaps = [0, 0.011, 0.022].reduce((s, at) => s + (t >= at ? Math.exp(-(t - at) * 300) : 0), 0);
        return clapBand(n) * (slaps + Math.exp(-t * 16) * 0.5) * 2;
      })),
      crash: buffer(render(rate, 5, 1.6, (t, n) => crashBand(n) * Math.min(1, t / 0.004) * Math.exp(-t * 2.4))),
    };

    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    document.addEventListener('visibilitychange', () => this.applyLevel());
  }

  /** The music's loudness (0 = off). */
  setLevel(gain: number) {
    this.level = gain;
    this.applyLevel();
  }

  /** A unit attacked: switch to (or stay in) the battle groove, with an accent. */
  attack() {
    if (this.level === 0) return;
    this.wantBattle = true;
    this.battleBarsLeft = BATTLE_HOLD_BARS;
    if (this.ctx.currentTime - this.lastAccent > ACCENT_GAP) this.wantAccent = true;
  }

  /** Which part is playing (for testing). */
  get playing(): Mode | null {
    return this.nextTime ? this.mode : null;
  }

  stop() {
    window.clearInterval(this.timer);
    this.out.disconnect();
  }

  private applyLevel() {
    this.out.gain.setTargetAtTime(document.hidden ? 0 : this.level, this.ctx.currentTime, 0.25);
  }

  private stepTime() {
    return 60 / BPM[this.mode] / 4;
  }

  private setEchoTime(at: number) {
    this.echo.delayTime.setTargetAtTime(this.stepTime() * 3, at, 0.05);
  }

  // ------------------------------------------------------------- sequencing

  private tick() {
    const now = this.ctx.currentTime;
    if (document.hidden || this.level === 0 || this.ctx.state !== 'running') {
      this.nextTime = 0; // stopped; starts again from the top of a bar
      return;
    }
    if (!this.nextTime || this.nextTime < now - 0.1) {
      this.nextTime = now + 0.05;
      this.step = 0;
      this.pad = null;
    }
    while (this.nextTime < now + LOOKAHEAD) {
      this.playStep(this.nextTime);
      this.nextTime += this.stepTime();
      this.step = (this.step + 1) % 16;
    }
  }

  private playStep(t: number) {
    // An attack brings the battle groove in on the next beat (its chords start at the next bar).
    if (this.wantBattle && this.step % 4 === 0) {
      this.wantBattle = false;
      if (this.mode === 'calm') {
        this.mode = 'battle';
        this.freshPart = true;
        this.setEchoTime(t);
      }
    }
    if (this.step === 0) this.startBar(t);
    if (this.wantAccent && this.mode === 'battle') {
      this.wantAccent = false;
      this.lastAccent = t;
      this.accent(t);
    }
    if (this.mode === 'calm') this.calmStep(t, this.step);
    else this.battleStep(t, this.step);
  }

  private startBar(t: number) {
    if (this.mode === 'battle' && !this.freshPart) {
      if (this.battleBarsLeft <= 0) {
        this.mode = 'calm';
        this.freshPart = true;
        this.setEchoTime(t);
      } else this.battleBarsLeft--;
    }
    if (this.freshPart) {
      this.freshPart = false;
      this.bar = 0;
    } else this.bar++;
    const part = SECTIONS[this.mode];
    this.chord = part.chords[Math.floor(this.bar / part.barsPerChord) % part.chords.length];
    if (this.bar % part.barsPerChord === 0 || !this.pad) this.playPad(t, this.chord.notes, part.barsPerChord * 16 * this.stepTime());
  }

  private calmStep(t: number, s: number) {
    const beat = this.stepTime() * 4;
    const { bass, notes } = this.chord;
    if (s === 0) this.kick(t, 0.5);
    if (s === 10) this.kick(t, 0.28);
    if (s % 4 === 2) this.hit('shaker', t, s === 10 ? 0.14 : 0.1, 0.25);
    if (s === 12) this.hit('clap', t, 0.1, -0.1, 0.5);
    if (s === 0) this.bass(t, bass, beat * 1.6, 0.5, false);
    if (s === 10) this.bass(t, bass, beat * 0.5, 0.3, false);
    for (const [at, k] of CALM_ARP[this.bar % 2]) {
      if (at === s) this.pluck(t, notes[k] + 12, 0.16, 0.45, s % 8 < 4 ? -0.3 : 0.3);
    }
  }

  private battleStep(t: number, s: number) {
    const step = this.stepTime();
    const { bass, notes } = this.chord;
    const fillBar = this.bar % 4 === 3;
    if (s % 4 === 0 || (fillBar && s === 14)) this.kick(t, 0.65);
    if (s === 4 || s === 12) this.hit('clap', t, 0.42, 0, 0.25);
    if (fillBar && (s === 13 || s === 15)) this.hit('clap', t, 0.22, 0.15, 0.2);
    if (s === 14) this.hit('open', t, 0.16, 0.2);
    else this.hit('hat', t, s % 4 === 2 ? 0.22 : 0.09, 0.2);
    // Driving bass: eighths, the root with an octave jump on the off-beats.
    if (s % 2 === 0) this.bass(t, bass + (s % 4 === 2 ? 12 : 0), step * 1.6, 0.42, true);
    this.pluck(t, notes[BATTLE_ARP[s]] + 12, s % 4 === 0 ? 0.11 : 0.08, 0.18, s % 2 ? 0.35 : -0.35);
  }

  // ------------------------------------------------------------- instruments

  /** Disconnect a voice's nodes once its source has finished. */
  private cleanUp(source: AudioScheduledSourceNode, ...nodes: AudioNode[]) {
    source.onended = () => {
      source.disconnect();
      for (const n of nodes) n.disconnect();
    };
  }

  private panner(pan: number) {
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    return p;
  }

  /** A soft electronic kick: a sine dropping quickly from 130 Hz to 45 Hz. */
  private kick(t: number, gain: number) {
    const osc = this.ctx.createOscillator();
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(env).connect(this.bus);
    osc.start(t);
    osc.stop(t + 0.42);
    this.cleanUp(osc, env);
  }

  private hit(name: Drum, t: number, gain: number, pan = 0, verb = 0.1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.drums[name];
    const env = this.ctx.createGain();
    env.gain.value = gain;
    const p = this.panner(pan);
    src.connect(env).connect(p).connect(this.bus);
    if (verb) {
      const send = this.ctx.createGain();
      send.gain.value = verb;
      p.connect(send).connect(this.verb);
      this.cleanUp(src, env, p, send);
    } else this.cleanUp(src, env, p);
    src.start(t);
  }

  /** Bass: a round sine sub when calm, a filtered saw that pulses in battle. */
  private bass(t: number, midi: number, dur: number, gain: number, battle: boolean) {
    const osc = this.ctx.createOscillator();
    osc.type = battle ? 'sawtooth' : 'triangle';
    osc.frequency.value = hz(midi);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = battle ? 3 : 0.7;
    filter.frequency.setValueAtTime(battle ? 900 : 380, t);
    if (battle) filter.frequency.exponentialRampToValueAtTime(240, t + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + (battle ? 0.006 : 0.03));
    env.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.25);
    osc.connect(filter).connect(env).connect(this.bus);
    osc.start(t);
    osc.stop(t + dur + 0.3);
    this.cleanUp(osc, filter, env);
  }

  /** A soft pluck (triangle with a quiet octave above) into the echo and reverb. */
  private pluck(t: number, midi: number, gain: number, decay: number, pan: number) {
    const a = this.ctx.createOscillator(), b = this.ctx.createOscillator();
    a.type = 'triangle';
    a.frequency.value = hz(midi);
    b.frequency.value = hz(midi + 12);
    const mixB = this.ctx.createGain();
    mixB.gain.value = 0.25;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = this.panner(pan);
    a.connect(env);
    b.connect(mixB).connect(env);
    env.connect(p);
    p.connect(this.bus);
    p.connect(this.echoIn);
    p.connect(this.verb);
    for (const o of [a, b]) {
      o.start(t);
      o.stop(t + decay + 0.05);
    }
    this.cleanUp(a, mixB, env, p);
    this.cleanUp(b);
  }

  /** A warm pad: two slightly detuned saws per note, spread left and right, softly filtered. */
  private playPad(t: number, notes: number[], dur: number) {
    // Let the previous chord fade under the new one.
    if (this.pad && this.pad.end > t) {
      this.pad.gain.gain.cancelScheduledValues(t);
      this.pad.gain.gain.setTargetAtTime(0, t, 0.3);
    }
    const battle = this.mode === 'battle';
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.6;
    const cut = battle ? 1400 : 800;
    // The filter slowly opens and closes over the chord: gentle movement.
    filter.frequency.setValueAtTime(cut * 0.7, t);
    filter.frequency.linearRampToValueAtTime(cut * 1.3, t + dur / 2);
    filter.frequency.linearRampToValueAtTime(cut * 0.8, t + dur);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.setTargetAtTime(1, t, battle ? 0.12 : 0.45);
    gain.gain.setTargetAtTime(0, t + dur, 0.45);
    filter.connect(gain);
    gain.connect(this.bus);
    const send = this.ctx.createGain();
    send.gain.value = 0.7;
    gain.connect(send).connect(this.verb);
    const stopAt = t + dur + 3;
    const oscs: OscillatorNode[] = [];
    for (const note of notes) {
      for (const side of [-1, 1]) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz(note);
        osc.detune.value = side * 8;
        const level = this.ctx.createGain();
        level.gain.value = 0.045;
        const p = this.panner(side * 0.5);
        osc.connect(level).connect(p).connect(filter);
        osc.start(t);
        osc.stop(stopAt);
        this.cleanUp(osc, level, p);
        oscs.push(osc);
      }
    }
    // The shared nodes go once the last oscillator has stopped.
    oscs[oscs.length - 1].addEventListener('ended', () => {
      filter.disconnect();
      gain.disconnect();
      send.disconnect();
    });
    this.pad = { gain, end: t + dur };
  }

  /** An attack's accent: a crash and a bright chord stab that echoes away. */
  private accent(t: number) {
    this.hit('crash', t, 0.22, 0, 0.5);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(3000, t);
    filter.frequency.exponentialRampToValueAtTime(500, t + 0.35);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.5, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    filter.connect(env);
    env.connect(this.bus);
    env.connect(this.echoIn);
    const oscs = this.chord.notes.map(note => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz(note + 12);
      const level = this.ctx.createGain();
      level.gain.value = 0.06;
      osc.connect(level).connect(filter);
      osc.start(t);
      osc.stop(t + 0.45);
      this.cleanUp(osc, level);
      return osc;
    });
    oscs[0].addEventListener('ended', () => {
      filter.disconnect();
      env.disconnect();
    });
  }

  /** A stereo room: noise that dies away over 2.6 s, getting darker as it goes. */
  private roomImpulse(): AudioBuffer {
    const rate = this.ctx.sampleRate, length = Math.floor(rate * 2.6);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const rand = seeded(77 + ch), data = impulse.getChannelData(ch);
      let smooth = 0;
      for (let i = 0; i < length; i++) {
        const t = i / rate;
        const a = 1 - Math.exp((-2 * Math.PI * (6000 * Math.exp(-t * 1.2) + 800)) / rate);
        smooth += a * (rand() * 2 - 1 - smooth);
        data[i] = smooth * Math.exp(-t * 2.6) * Math.min(1, t / 0.01);
      }
    }
    return impulse;
  }
}
