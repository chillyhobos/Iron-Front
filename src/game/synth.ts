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

/** Every sound the game can play: its recipe and how many variants to make of it. */
export const RECIPES = {
  'rifle-shot': { make: rifleShot, variants: 4 },
} satisfies Record<string, { make: (rate: number, seed: number) => Float32Array; variants: number }>;

export type SoundName = keyof typeof RECIPES;
