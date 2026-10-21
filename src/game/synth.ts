// Sound effects made from scratch, like the art: each recipe computes a short clip,
// sample by sample. Plain math with no browser APIs, so clips can be rendered ahead
// of time (and tested). Everything here is original.
//
// Loudness rule: every sound is equally loud. Each recipe ends with finish(), which
// scales the clip to the same peak (CLIP_PEAK), and the engine plays every sound at
// the same level (SFX_LEVEL). New sounds follow the rule by ending with finish().

/** The peak every clip is scaled to. */
export const CLIP_PEAK = 0.9;

/**
 * How loud every sound plays (before the player's volume slider). Set by ear on the
 * Rifleman: half, then 25% and 10% lower than first made (about -9.4 dB).
 */
export const SFX_LEVEL = 0.3375;

/** Small, fast, repeatable random numbers (mulberry32), so each variant sounds the same every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass coefficient for a cutoff frequency. */
const lowpass = (hz: number, rate: number) => 1 - Math.exp((-2 * Math.PI * hz) / rate);

/** Scale a clip to the shared peak and fade the last few milliseconds (no click at the end). */
function finish(out: Float32Array, rate: number, peak = CLIP_PEAK) {
  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
  const k = max > 0 ? peak / max : 0;
  const fade = Math.floor(rate * 0.008);
  for (let i = 0; i < out.length; i++) {
    const tail = out.length - 1 - i;
    out[i] *= k * (tail < fade ? tail / fade : 1);
  }
  return out;
}

/**
 * The Rifleman's shot: a punchy automatic-rifle round with a sci-fi edge. Layers:
 * a deep "pop" whose pitch drops fast, a gritty mid-range body, a sharp high crack,
 * a quick downward zing, and a short metallic ring; then soft clipping for punch and
 * a gentle high cut.
 */
export function rifleShot(rate: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(Math.floor(rate * 0.2));
  const aBody = lowpass(1200, rate);
  const aCrackLow = lowpass(2000, rate);
  const aCrackHigh = lowpass(6500, rate);
  // Each variant is a little different: pitch of the pop, grit, ring.
  const popHz = 150 + rand() * 25;
  const ringA = 1820 + rand() * 120, ringB = 2900 + rand() * 160;
  const aOut = lowpass(7500, rate);
  let phase = 0, zingPhase = 0, body = 0, under = 0, crackBand = 0, out1 = 0, out2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.0012);
    // Deep pop: a sine sweeping from ~160 Hz down to 55 Hz.
    phase += (2 * Math.PI * (55 + (popHz - 55) * Math.exp(-t * 45))) / rate;
    const pop = Math.sin(phase) * Math.exp(-t * 26) * 0.6;
    // Noise, shaped two ways: a low, gritty bark, and a crack between ~2 and 6.5 kHz
    // (high enough to snap, low enough not to fizz).
    const noise = rand() * 2 - 1;
    body += aBody * (noise - body);
    under += aCrackLow * (noise - under);
    crackBand += aCrackHigh * (noise - under - crackBand);
    const grit = body * Math.exp(-t * 34) * 2.4;
    const crack = crackBand * Math.exp(-t * 100) * 2.4;
    // Sci-fi zing: a quick chirp from 3.2 kHz down to 1.4 kHz.
    zingPhase += (2 * Math.PI * (1400 + 1800 * Math.exp(-t * 90))) / rate;
    const zing = Math.sin(zingPhase) * Math.exp(-t * 60) * 0.16;
    // Metallic ring: a few out-of-tune partials that die away fast.
    const ring = (Math.sin(2 * Math.PI * ringA * t) * 0.5 + Math.sin(2 * Math.PI * ringB * t) * 0.35
      + Math.sin(2 * Math.PI * 4410 * t) * 0.2) * Math.exp(-t * 30) * 0.12;
    // Soft clipping for punch, then a gentle high cut so the clipping doesn't fizz.
    out1 += aOut * (Math.tanh(attack * (pop + grit + crack + zing + ring) * 1.7) - out1);
    out2 += aOut * (out1 - out2);
    out[i] = out2;
  }
  return finish(out, rate);
}

/**
 * The Engineer's SMG: lighter and faster than the Rifleman's rifle. A higher, thinner
 * "tak" with little bass, a raspy mid-range bark, a crisp top, and the mechanical
 * clack of the bolt cycling; short, so rapid shots stay distinct.
 */
export function smgShot(rate: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(Math.floor(rate * 0.12));
  const aBarkLow = lowpass(1300, rate), aBarkHigh = lowpass(4800, rate);
  const aCrackLow = lowpass(3000, rate), aCrackHigh = lowpass(7500, rate);
  const aOut = lowpass(8500, rate);
  const popHz = 240 + rand() * 40;
  const clackHz = 1150 + rand() * 120;
  let phase = 0, barkLow = 0, bark = 0, crackLow = 0, crack = 0, out1 = 0, out2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.0008);
    // A small, high pop (~260 Hz falling to 110 Hz): punch without a big-gun boom.
    phase += (2 * Math.PI * (110 + (popHz - 110) * Math.exp(-t * 70))) / rate;
    const pop = Math.sin(phase) * Math.exp(-t * 45) * 0.22;
    // Raspy bark: noise between ~1.3 and 4.8 kHz (tinny, not boomy).
    const noise = rand() * 2 - 1;
    barkLow += aBarkLow * (noise - barkLow);
    bark += aBarkHigh * (noise - barkLow - bark);
    const rasp = bark * Math.exp(-t * 55) * 2.2;
    // Crisp top: noise between ~3 and 7.5 kHz, gone in a few milliseconds.
    crackLow += aCrackLow * (noise - crackLow);
    crack += aCrackHigh * (noise - crackLow - crack);
    const snap = crack * Math.exp(-t * 140) * 3.4;
    // Bolt clack: a hard, square-ish click a moment after the shot.
    const tc = t - 0.012;
    const clack = tc > 0 ? Math.sign(Math.sin(2 * Math.PI * clackHz * tc)) * Math.exp(-tc * 260) * 0.22 : 0;
    out1 += aOut * (Math.tanh(attack * (pop + rasp + snap + clack) * 1.8) - out1);
    out2 += aOut * (out1 - out2);
    out[i] = out2;
  }
  return finish(out, rate);
}

/**
 * The Engineer's demolition charge: short and crisp. A sharp crack and a quick, punchy
 * thump, a burst of bright debris crackle, and only a brief low tail (no long rumble).
 */
export function demolition(rate: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(Math.floor(rate * 0.45));
  const aCrackLow = lowpass(1800, rate), aCrackHigh = lowpass(9000, rate);
  const aBody = lowpass(500, rate);
  const aOut = lowpass(10000, rate);
  let phase = 0, crackLow = 0, crack = 0, body = 0, out1 = 0, out2 = 0;
  // Debris: a scatter of tiny clicks, mostly early.
  const debris: number[] = [];
  for (let k = 0; k < 26; k++) debris.push(0.01 + Math.pow(rand(), 1.8) * 0.3);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const attack = Math.min(1, t / 0.0006);
    const noise = rand() * 2 - 1;
    // The crack: a bright blast of noise (~1.8–9 kHz), very fast.
    crackLow += aCrackLow * (noise - crackLow);
    crack += aCrackHigh * (noise - crackLow - crack);
    const blast = crack * Math.exp(-t * 38) * 2.6;
    // The thump: a low sweep 130 → 45 Hz, plus a little low noise, both short.
    phase += (2 * Math.PI * (45 + 85 * Math.exp(-t * 22))) / rate;
    body += aBody * (noise - body);
    const thump = Math.sin(phase) * Math.exp(-t * 14) * 0.9 + body * Math.exp(-t * 18) * 1.4;
    // Debris crackle.
    let crackle = 0;
    for (const at of debris) {
      const d = t - at;
      if (d >= 0 && d < 0.006) crackle += (rand() * 2 - 1) * Math.exp(-d * 900) * 0.6;
    }
    out1 += aOut * (Math.tanh(attack * (blast + thump + crackle) * 1.5) - out1);
    out2 += aOut * (out1 - out2);
    out[i] = out2;
  }
  return finish(out, rate);
}

/**
 * Fixing a bridge: a quick wrench ratchet (six small clicks), then two clanks of a
 * tool on steel, each ringing briefly with out-of-tune metallic partials.
 */
export function bridgeRepair(rate: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(Math.floor(rate * 0.75));
  const aClick = lowpass(3200, rate);
  const aOut = lowpass(9000, rate);
  const ratchet = [0, 1, 2, 3, 4, 5].map(k => 0.01 + k * 0.032 + rand() * 0.004);
  const clanks = [{ at: 0.27, gain: 1 }, { at: 0.47, gain: 0.8 }];
  const partials = [523, 1291, 2384, 3517].map(hz => hz * (0.97 + rand() * 0.06));
  let click = 0, out1 = 0, out2 = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const noise = rand() * 2 - 1;
    click += aClick * (noise - click);
    let s = 0;
    // Ratchet clicks: tiny bursts of high noise with a hint of a 2.2 kHz tick.
    for (const at of ratchet) {
      const d = t - at;
      if (d >= 0 && d < 0.012) s += ((noise - click) * 1.4 + Math.sin(2 * Math.PI * 2200 * d) * 0.5) * Math.exp(-d * 650) * 0.45;
    }
    // Clanks: a hit transient, then the metal rings for a moment.
    for (const { at, gain } of clanks) {
      const d = t - at;
      if (d < 0) continue;
      const hit = noise * Math.exp(-d * 400) * 0.8;
      let ring = 0;
      partials.forEach((hz, k) => { ring += Math.sin(2 * Math.PI * hz * d) * Math.exp(-d * (9 + k * 5)) * (0.5 / (k + 1)); });
      s += (hit + ring) * gain;
    }
    out1 += aOut * (Math.tanh(s * 1.4) - out1);
    out2 += aOut * (out1 - out2);
    out[i] = out2;
  }
  return finish(out, rate);
}

/** Every sound the game can play: its recipe and how many variants to make of it. */
export const RECIPES = {
  'rifle-shot': { make: rifleShot, variants: 4 },
  'smg-shot': { make: smgShot, variants: 4 },
  'demolition': { make: demolition, variants: 2 },
  'bridge-repair': { make: bridgeRepair, variants: 2 },
} satisfies Record<string, { make: (rate: number, seed: number) => Float32Array; variants: number }>;

export type SoundName = keyof typeof RECIPES;
