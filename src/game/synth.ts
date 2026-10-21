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
 * Rifleman: half, then 25%, 10% and 15% lower than first made (about -10.8 dB).
 * The music has its own level (MUSIC_LEVEL in sound.ts), so this doesn't move it.
 */
export const SFX_LEVEL = 0.286875;

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

// ---------------------------------------------------------------- footsteps
// One running footstep, by what the ground is. Each is a soft footfall (a low thud)
// plus the sound of the surface; short, so a fast run stays clear.

/** A clip of `seconds`, filled sample by sample by `voice(t, noise)`, then soft-clipped and finished. */
export function render(rate: number, seed: number, seconds: number, voice: (t: number, noise: number, rand: () => number) => number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(Math.floor(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.tanh(voice(i / rate, rand() * 2 - 1, rand) * 1.3);
  return finish(out, rate);
}

/** A band of noise between two frequencies (two one-pole filters), kept per clip. */
export function band(lowHz: number, highHz: number, rate: number) {
  const aLow = lowpass(lowHz, rate), aHigh = lowpass(highHz, rate);
  let under = 0, inBand = 0;
  return (noise: number) => {
    under += aLow * (noise - under);
    inBand += aHigh * (noise - under - inBand);
    return inBand;
  };
}

/** Grass (plains): a soft thud and a brushing swish. */
export function stepGrass(rate: number, seed: number) {
  const thud = band(40, 380, rate), swish = band(900, 3500, rate);
  const lag = 0.004 + seeded(seed)() * 0.004;
  return render(rate, seed, 0.12, (t, n) => {
    const brush = swish(n); // (filtered every sample, heard from just after the footfall)
    const d = t - lag;
    return thud(n) * Math.exp(-t * 50) * 4 * Math.min(1, t / 0.002)
      + (d > 0 ? brush * Math.min(1, d / 0.01) * Math.exp(-d * 38) * 0.35 : 0);
  });
}

/** Leaves and twigs (forest): a thud under a dry, crunchy crackle. */
export function stepLeaves(rate: number, seed: number) {
  const thud = band(40, 350, rate), crunch = band(2200, 8000, rate);
  const r = seeded(seed + 99);
  const snaps = Array.from({ length: 14 }, () => 0.003 + Math.pow(r(), 1.4) * 0.09);
  return render(rate, seed, 0.13, (t, n) => {
    let crackle = 0;
    for (const at of snaps) { const d = t - at; if (d >= 0 && d < 0.004) crackle += Math.exp(-d * 1400); }
    return thud(n) * Math.exp(-t * 60) * 2.6 * Math.min(1, t / 0.002) + crunch(n) * (0.25 + crackle * 1.6) * Math.exp(-t * 22);
  });
}

/** Gravel and rock (mountains): a heavier thud, a gritty crunch, and a pebble click. */
export function stepGravel(rate: number, seed: number) {
  const thud = band(35, 420, rate), grit = band(1200, 6000, rate);
  const r = seeded(seed + 7);
  const grains = Array.from({ length: 34 }, () => 0.002 + r() * 0.1);
  const pebbleAt = 0.05 + r() * 0.04, pebbleHz = 2600 + r() * 900;
  return render(rate, seed, 0.15, (t, n) => {
    let crunch = 0;
    for (const at of grains) { const d = t - at; if (d >= 0 && d < 0.003) crunch += Math.exp(-d * 2000); }
    const dp = t - pebbleAt;
    const pebble = dp >= 0 ? Math.sin(2 * Math.PI * pebbleHz * dp) * Math.exp(-dp * 180) * 0.35 : 0;
    return thud(n) * Math.exp(-t * 45) * 3.2 * Math.min(1, t / 0.002) + grit(n) * (0.35 + crunch * 1.2) * Math.exp(-t * 18) + pebble;
  });
}

/** Hard ground (roads, towns, bases): a crisp boot tap. */
export function stepHard(rate: number, seed: number) {
  const knock = band(250, 900, rate), tick = band(2500, 7000, rate);
  const r = seeded(seed + 3);
  const heelHz = 380 + r() * 80;
  return render(rate, seed, 0.09, (t, n) =>
    (knock(n) * 2.4 + Math.sin(2 * Math.PI * heelHz * t) * 0.5) * Math.exp(-t * 70) * Math.min(1, t / 0.0008)
    + tick(n) * Math.exp(-t * 260) * 1.8);
}

/** Bridge: a hollow wooden thunk that rings briefly. */
export function stepBridge(rate: number, seed: number) {
  const hit = band(200, 3000, rate);
  const r = seeded(seed + 11);
  const modes = [170, 395, 690].map(hz => hz * (0.96 + r() * 0.08));
  return render(rate, seed, 0.18, (t, n) =>
    hit(n) * Math.exp(-t * 120) * 1.6 * Math.min(1, t / 0.001)
    + (Math.sin(2 * Math.PI * modes[0] * t) * 0.8 + Math.sin(2 * Math.PI * modes[1] * t) * 0.45 + Math.sin(2 * Math.PI * modes[2] * t) * 0.25)
      * Math.exp(-t * 26) * Math.min(1, t / 0.002));
}

/** Water (wading a river): a splash and a quick bubble. */
export function stepWater(rate: number, seed: number) {
  const low = band(300, 1400, rate), high = band(1400, 5000, rate);
  const r = seeded(seed + 5);
  const bubbleAt = 0.04 + r() * 0.03;
  let phase = 0;
  return render(rate, seed, 0.2, (t, n) => {
    // The splash moves from a low slap to a high spray.
    const slap = low(n) * Math.exp(-t * 35) * 2.2;
    const spray = high(n) * Math.min(1, t / 0.015) * Math.exp(-t * 20) * 1.4;
    // A bubble: a short rising chirp.
    const db = t - bubbleAt;
    if (db >= 0) phase += (2 * Math.PI * (500 + 1600 * Math.min(1, db / 0.03))) / rate;
    const bubble = db >= 0 && db < 0.04 ? Math.sin(phase) * Math.sin((Math.PI * db) / 0.04) * 0.35 : 0;
    return (slap + spray) * Math.min(1, t / 0.002) + bubble;
  });
}

// ---------------------------------------------------------------- capture hops
// Infantry hop twice on a building they're capturing. Playful, not heavy: a springy
// rising "bwip" as they leave the ground and a soft, bouncy "bup" as they land, each
// on its own cue so both stay in step with the animation. Pure tones with gentle
// attacks (no noise bursts), so nothing thumps or clicks.

/** A soft tone gliding from `fromHz` to `toHz`, with a gentle rise and a springy wobble. */
function bounce(rate: number, seconds: number, opts: { fromHz: number; toHz: number; glide: number; attack: number; decay: number; wobble: number }) {
  const out = new Float32Array(Math.floor(rate * seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const glide = Math.min(1, t / opts.glide);
    const eased = 1 - (1 - glide) * (1 - glide); // fast at first, settling at the end
    // The wobble: a quick pitch flutter that dies away, like a spring settling.
    const hz = (opts.fromHz + (opts.toHz - opts.fromHz) * eased) * (1 + opts.wobble * Math.sin(2 * Math.PI * 22 * t) * Math.exp(-t * 30));
    phase += (2 * Math.PI * hz) / rate;
    const env = Math.sin((Math.PI / 2) * Math.min(1, t / opts.attack)) ** 2 * Math.exp(-t * opts.decay);
    // A little second and third harmonic make it round and toy-like rather than a test tone.
    out[i] = (Math.sin(phase) + Math.sin(2 * phase) * 0.18 + Math.sin(3 * phase) * 0.05) * env;
  }
  return finish(out, rate);
}

/** Leaving the ground: a quick, springy rising "bwip". */
export function hopUp(rate: number, seed: number) {
  const r = seeded(seed + 31);
  const base = 300 + r() * 40;
  return bounce(rate, 0.11, { fromHz: base, toHz: base * 2.2, glide: 0.07, attack: 0.008, decay: 28, wobble: 0 });
}

/** Landing: a soft, round "bup" that drops in pitch and wobbles a little, like a bounce. */
export function hopLand(rate: number, seed: number) {
  const r = seeded(seed + 17);
  const base = 470 + r() * 50;
  return bounce(rate, 0.14, { fromHz: base, toHz: base * 0.55, glide: 0.06, attack: 0.006, decay: 30, wobble: 0.06 });
}

// ---------------------------------------------------------------- vehicles
// Engine loops for vehicles, aircraft and ships on the move. Each is one second long
// and loops seamlessly (the engine fades it in and out around a move), so anything
// rhythmic repeats a whole number of times per second. Unit types share a loop and
// differ by playback speed (a Heavy Tank is a slower, deeper Light Tank).

/** How long each loop is (seconds). */
const LOOP_SECONDS = 1;

/**
 * A seamless loop filled by `voice(t, noise)`, soft-clipped and scaled to the shared peak.
 * The noise repeats every loop and the clip is rendered twice, keeping the second lap:
 * by then every filter has settled into the loop, so its end runs exactly into its start.
 */
function renderLoop(rate: number, seed: number, voice: (t: number, noise: number) => number): Float32Array {
  const rand = seeded(seed);
  const n = Math.floor(rate * LOOP_SECONDS);
  const noise = Float32Array.from({ length: n }, () => rand() * 2 - 1);
  const out = new Float32Array(n);
  for (let i = 0; i < 2 * n; i++) {
    const v = voice(i / rate, noise[i % n]);
    if (i >= n) out[i - n] = Math.tanh(v * 1.3);
  }
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] *= CLIP_PEAK / max; // (no end fade: it would dip at every loop)
  return out;
}

/** Time since the last of `perSecond` evenly spaced beats (repeats exactly every loop). */
const sinceBeat = (t: number, perSecond: number) => (t * perSecond - Math.floor(t * perSecond)) / perSecond;

/** Tracked vehicles (tanks, carrier, artillery, flak): a diesel chug and the clank of the treads. */
export function driveTreads(rate: number, seed: number) {
  const rumble = band(30, 220, rate), chug = band(60, 400, rate), clank = band(1500, 5000, rate), squeal = band(2200, 3800, rate);
  const r = seeded(seed + 21);
  // Tread links slap down 10 times a second, each a little differently.
  const links = Array.from({ length: 10 }, () => ({ gain: 0.6 + r() * 0.4, hz: 820 + r() * 260 }));
  const fire = 30 + (seed % 2) * 4; // engine firing rate (whole number: loops cleanly)
  return renderLoop(rate, seed, (t, n) => {
    const df = sinceBeat(t, fire);
    const engine = chug(n) * Math.exp(-df * 90) * 3.2 + Math.sin(2 * Math.PI * fire * 2 * t) * 0.25;
    const k = Math.floor(t * 10) % 10, dl = sinceBeat(t, 10), link = links[k];
    const slap = (clank(n) * 2.2 + Math.sin(2 * Math.PI * link.hz * dl) * 0.6) * Math.exp(-dl * 160) * link.gain;
    const whine = squeal(n) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) * 0.12;
    return rumble(n) * 1.6 + engine + slap * 0.55 + whine;
  });
}

/** Wheeled vehicles (scout car, rocket and missile trucks): a smoother engine and tire roar. */
export function driveTires(rate: number, seed: number) {
  const roar = band(120, 900, rate), hiss = band(1500, 4500, rate), chug = band(80, 500, rate);
  const fire = 52 + (seed % 2) * 6;
  return renderLoop(rate, seed, (t, n) => {
    const df = sinceBeat(t, fire);
    const engine = chug(n) * Math.exp(-df * 140) * 1.6
      + (Math.sin(2 * Math.PI * fire * t) * 0.35 + Math.sin(2 * Math.PI * fire * 2 * t) * 0.2 + Math.sin(2 * Math.PI * fire * 3 * t) * 0.1);
    // Tires hum on the road, swelling gently over bumps (twice a second).
    const swell = 0.8 + 0.2 * Math.sin(2 * Math.PI * 2 * t + seed);
    return engine + roar(n) * 1.3 * swell + hiss(n) * 0.18 * swell;
  });
}

/** Jets (interceptor, bomber): a broad roar, an airy hiss, and a turbine whine. */
export function flyJet(rate: number, seed: number) {
  const roar = band(150, 1400, rate), hiss = band(3000, 9000, rate), low = band(40, 200, rate);
  const whineHz = 2300 + (seed % 2) * 260;
  let phase = 0;
  return renderLoop(rate, seed, (t, n) => {
    // The whine wavers slightly (2 times a second) so it doesn't sound like a test tone.
    phase += (2 * Math.PI * whineHz * (1 + 0.012 * Math.sin(2 * Math.PI * 2 * t))) / rate;
    const whine = Math.sin(phase) * 0.07 + Math.sin(phase * 1.5) * 0.035;
    return roar(n) * 1.5 + hiss(n) * 0.5 + low(n) * 1.2 + whine;
  });
}

/** Helicopters (gunship, airlift): the "wop" of the rotor blades over a turbine whine. */
export function flyRotor(rate: number, seed: number) {
  const wop = band(50, 450, rate), air = band(1500, 5000, rate);
  const blades = 13 + (seed % 2); // blade passes per second
  const whineHz = 1750 + (seed % 2) * 150;
  return renderLoop(rate, seed, (t, n) => {
    const d = sinceBeat(t, blades);
    const chop = wop(n) * Math.min(1, d / 0.004) * Math.exp(-d * 55) * 5;
    const swish = air(n) * (0.3 + Math.exp(-d * 30) * 0.7) * 0.25;
    return chop + swish + Math.sin(2 * Math.PI * whineHz * t) * 0.05;
  });
}

/** Ships (cruiser, battleship, lander): the wash of the bow wave over a low engine hum. */
export function sail(rate: number, seed: number) {
  const wash = band(150, 1100, rate), spray = band(1500, 5000, rate), hum = band(25, 120, rate);
  const humHz = 36 + (seed % 2) * 4;
  return renderLoop(rate, seed, (t, n) => {
    // Waves rise and fall slowly (once and three times a second, so they loop cleanly).
    const surge = 0.6 + 0.25 * Math.sin(2 * Math.PI * t + seed) + 0.15 * Math.sin(2 * Math.PI * 3 * t);
    const sprayLevel = Math.max(0, Math.sin(2 * Math.PI * t + seed + 0.6));
    return wash(n) * 1.8 * surge + spray(n) * 0.35 * sprayLevel * sprayLevel
      + hum(n) * 1.4 + Math.sin(2 * Math.PI * humHz * t) * 0.18;
  });
}

// ---------------------------------------------------------------- weapons, hits, explosions
// The rest of the battle: a sound per weapon style (units sharing a style play it at
// their own pitch), a hit as each shot lands, an explosion when a unit is destroyed,
// and a jingle when a building is captured. Punchy but rounded: every one ends with
// a gentle high cut, so nothing is harsh or fizzy.

/** A sine whose pitch can change every sample (for booms and whistles that glide). */
function glider(rate: number) {
  let phase = 0;
  return (hz: number) => Math.sin((phase += (2 * Math.PI * hz) / rate));
}

/** A pitch gliding from `from` to `to` Hz, `speed` per second (exponential, like a drum). */
const drop = (t: number, from: number, to: number, speed: number) => to + (from - to) * Math.exp(-t * speed);

/** Rise in `attack` seconds (no click), then die away at `decay` per second. */
const env = (t: number, attack: number, decay: number) => Math.min(1, t / attack) * Math.exp(-t * decay);

/**
 * A clip filled by `voice` like render(), plus optional echoes (delayed, darker copies:
 * distance) and a two-pole high cut at `cutHz` that keeps it round. Ends with finish().
 */
function shape(rate: number, seed: number, seconds: number, cutHz: number, voice: (t: number, noise: number) => number,
  echoes: [delay: number, gain: number][] = []): Float32Array {
  const rand = seeded(seed);
  const n = Math.floor(rate * seconds);
  const dry = new Float32Array(n);
  for (let i = 0; i < n; i++) dry[i] = Math.tanh(voice(i / rate, rand() * 2 - 1) * 1.3);
  const out = dry.slice();
  for (const [delay, gain] of echoes) {
    const d = Math.floor(rate * delay), a = lowpass(cutHz * 0.4, rate);
    let lp = 0;
    for (let i = d; i < n; i++) out[i] += (lp += a * (dry[i - d] - lp)) * gain;
  }
  const a = lowpass(cutHz, rate);
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) out[i] = p2 += a * ((p1 += a * (out[i] - p1)) - p2);
  return finish(out, rate);
}

/** Sniper: one full, sharp crack that echoes away across the battlefield. */
export function sniperShot(rate: number, seed: number) {
  const crack = band(1500, 6000, rate), body = band(100, 900, rate), pop = glider(rate);
  return shape(rate, seed, 0.55, 6500, (t, n) =>
    crack(n) * env(t, 0.0006, 120) * 2.2 + body(n) * env(t, 0.001, 30) * 1.8
    + pop(drop(t, 220, 70, 30)) * env(t, 0.001, 25) * 0.6,
  [[0.09, 0.4], [0.2, 0.2], [0.33, 0.1]]);
}

/** Bazooka: an ignition pop and the "fwoomp" of the rocket leaving the tube. */
export function bazookaShot(rate: number, seed: number) {
  const pop = band(80, 600, rate), whoosh = band(400, 2400, rate), hiss = band(2000, 5000, rate);
  return shape(rate, seed, 0.4, 3000, (t, n) => {
    const swell = Math.min(1, t / 0.04) * Math.exp(-Math.max(0, t - 0.04) * 9);
    return pop(n) * env(t, 0.001, 40) * 2.4 + whoosh(n) * swell * 1.5 + hiss(n) * swell * 0.15;
  });
}

/** Tank cannon: a punchy boom with a short crack and a rolling tail (pitched per tank). */
export function cannonShot(rate: number, seed: number) {
  const blast = band(60, 1200, rate), crack = band(1500, 5000, rate), rumble = band(30, 200, rate), pop = glider(rate);
  return shape(rate, seed, 0.65, 5000, (t, n) =>
    pop(drop(t, 140, 45, 14)) * env(t, 0.001, 14) + blast(n) * env(t, 0.001, 18) * 2.5
    + crack(n) * env(t, 0.0006, 90) + rumble(n) * env(t, 0.01, 5) * 1.4,
  [[0.12, 0.25]]);
}

/** Rapid guns (scout car, flak, interceptor, cruiser): one quick, solid "dut" per round. */
export function gunBurst(rate: number, seed: number) {
  const bark = band(400, 2500, rate), tick = band(2500, 6000, rate), pop = glider(rate);
  return shape(rate, seed, 0.09, 7000, (t, n) =>
    pop(drop(t, 220, 90, 60)) * env(t, 0.0008, 60) * 0.6 + bark(n) * env(t, 0.0008, 70) * 2 + tick(n) * env(t, 0.0005, 200) * 0.8);
}

/** Artillery and battleship guns: a deep "thoom", then the shell whistling down. */
export function shellShot(rate: number, seed: number) {
  const blast = band(50, 900, rate), rumble = band(30, 180, rate), pop = glider(rate), whistle = glider(rate);
  return shape(rate, seed, 0.5, 5000, (t, n) => {
    const w = t > 0.12 && t < 0.42 ? Math.sin((Math.PI * (t - 0.12)) / 0.3) : 0;
    return pop(drop(t, 110, 40, 10)) * env(t, 0.001, 10) + blast(n) * env(t, 0.001, 12) * 2.6
      + rumble(n) * env(t, 0.01, 6) * 1.2 + whistle(2200 - 1300 * Math.min(1, Math.max(0, t - 0.12) / 0.3)) * w * w * 0.16;
  });
}

/** Rocket launcher: an ignition pop and a hissing "fssshh" as each rocket streaks off. */
export function rocketShot(rate: number, seed: number) {
  const pop = band(100, 700, rate), whoosh = band(500, 2600, rate), hiss = band(2500, 6000, rate);
  return shape(rate, seed, 0.45, 3000, (t, n) =>
    pop(n) * env(t, 0.001, 50) * 1.8 + whoosh(n) * env(t, 0.02, 6) * 1.4 + hiss(n) * env(t, 0.03, 7) * 0.06);
}

/** Missile launcher: a heavier launch roar with a low thump underneath. */
export function missileShot(rate: number, seed: number) {
  const roar = band(150, 1500, rate), hiss = band(2000, 6000, rate), pop = glider(rate);
  return shape(rate, seed, 0.7, 6000, (t, n) =>
    roar(n) * env(t, 0.04, 3.5) * 1.6 + hiss(n) * env(t, 0.05, 4) * 0.35 + pop(drop(t, 90, 50, 20)) * env(t, 0.002, 20) * 0.8);
}

/** Gunship rocket pods: a quick "fwip". */
export function airMissileShot(rate: number, seed: number) {
  const fwip = band(700, 3200, rate), pop = glider(rate);
  return shape(rate, seed, 0.25, 4000, (t, n) => fwip(n) * env(t, 0.006, 18) * 1.5 + pop(drop(t, 300, 120, 50)) * env(t, 0.001, 50) * 0.5);
}

/** Bomber: the clunk of the bomb rack, then a falling whistle. */
export function bombDrop(rate: number, seed: number) {
  const clunk = band(300, 1500, rate), whistle = glider(rate);
  return shape(rate, seed, 0.32, 6000, (t, n) => {
    const w = t > 0.03 ? Math.sin((Math.PI * (t - 0.03)) / 0.29) : 0;
    return (clunk(n) * 1.2 + Math.sin(2 * Math.PI * 180 * t) * 0.6) * env(t, 0.001, 60)
      + whistle(1800 - 1100 * Math.max(0, t - 0.03) / 0.29) * w * 0.3;
  });
}

/** A bullet landing: a soft, dusty "pff-tk". */
export function impactLight(rate: number, seed: number) {
  const dust = band(150, 1200, rate), tick = band(1500, 4000, rate);
  return shape(rate, seed, 0.12, 4500, (t, n) => dust(n) * env(t, 0.001, 45) * 2 + tick(n) * env(t, 0.0008, 120) * 0.4);
}

/** A shell, rocket or bomb landing: a rounded boom with a little debris. */
export function impactHeavy(rate: number, seed: number) {
  const blast = band(40, 700, rate), debris = band(1500, 5000, rate), boom = glider(rate);
  const r = seeded(seed + 61);
  const bits = Array.from({ length: 12 }, () => 0.03 + r() * 0.35);
  return shape(rate, seed, 0.6, 4000, (t, n) => {
    let crackle = 0;
    for (const at of bits) { const d = t - at; if (d >= 0 && d < 0.005) crackle += Math.exp(-d * 900); }
    return boom(drop(t, 90, 40, 12)) * env(t, 0.002, 12) + blast(n) * env(t, 0.002, 9) * 3 + debris(n) * crackle * 0.5 * Math.exp(-t * 4);
  });
}

/** A unit destroyed: a big, soft, rolling explosion (deep and rounded, never harsh). */
export function explosion(rate: number, seed: number) {
  const low = band(30, 600, rate), mid = band(300, 2000, rate), debris = band(1500, 5000, rate), boom = glider(rate);
  const r = seeded(seed + 83);
  const bits = Array.from({ length: 22 }, () => 0.05 + Math.pow(r(), 1.5) * 0.6);
  return shape(rate, seed, 1, 3500, (t, n) => {
    let crackle = 0;
    for (const at of bits) { const d = t - at; if (d >= 0 && d < 0.006) crackle += Math.exp(-d * 800); }
    return boom(drop(t, 80, 35, 7)) * env(t, 0.004, 6) * 1.2 + low(n) * env(t, 0.004, 4.5) * 3.5
      + mid(n) * env(t, 0.003, 10) * 1.2 + debris(n) * crackle * 0.5 * Math.exp(-t * 3);
  }, [[0.15, 0.2]]);
}

/** A building captured: a short, cheerful rising jingle (G, C, E, G), the last note ringing. */
export function captureJingle(rate: number, seed: number) {
  const notes = [67, 72, 76, 79].map(m => 440 * 2 ** ((m - 69) / 12));
  const lift = 1 + (seed - 1) * 0.004; // variants a hair apart in tuning
  return shape(rate, seed, 0.75, 8000, t => {
    let s = 0;
    notes.forEach((hz, k) => {
      const d = t - k * 0.075;
      if (d < 0) return;
      const last = k === notes.length - 1;
      const f = hz * lift * (last ? 1 + 0.004 * Math.sin(2 * Math.PI * 6 * d) : 1); // a little shimmer on the last note
      const p = 2 * Math.PI * f * d;
      s += (Math.sin(p) + Math.sin(2 * p) * 0.18 + Math.sin(3 * p) * 0.05) * env(d, 0.005, last ? 5 : 14) * 0.55;
    });
    return s;
  });
}

/** Every sound the game can play: its recipe and how many variants to make of it. */
export const RECIPES = {
  'rifle-shot': { make: rifleShot, variants: 4 },
  'smg-shot': { make: smgShot, variants: 4 },
  'demolition': { make: demolition, variants: 2 },
  'bridge-repair': { make: bridgeRepair, variants: 2 },
  'step-grass': { make: stepGrass, variants: 4 },
  'step-leaves': { make: stepLeaves, variants: 4 },
  'step-gravel': { make: stepGravel, variants: 4 },
  'step-hard': { make: stepHard, variants: 4 },
  'step-bridge': { make: stepBridge, variants: 4 },
  'step-water': { make: stepWater, variants: 4 },
  'hop-up': { make: hopUp, variants: 4 },
  'hop-land': { make: hopLand, variants: 4 },
  'sniper-shot': { make: sniperShot, variants: 3 },
  'bazooka-shot': { make: bazookaShot, variants: 3 },
  'cannon-shot': { make: cannonShot, variants: 3 },
  'gun-burst': { make: gunBurst, variants: 4 },
  'shell-shot': { make: shellShot, variants: 2 },
  'rocket-shot': { make: rocketShot, variants: 3 },
  'missile-shot': { make: missileShot, variants: 2 },
  'air-missile-shot': { make: airMissileShot, variants: 3 },
  'bomb-drop': { make: bombDrop, variants: 2 },
  'impact-light': { make: impactLight, variants: 4 },
  'impact-heavy': { make: impactHeavy, variants: 3 },
  'explosion': { make: explosion, variants: 3 },
  'capture-jingle': { make: captureJingle, variants: 2 },
  'drive-treads': { make: driveTreads, variants: 2 },
  'drive-tires': { make: driveTires, variants: 2 },
  'fly-jet': { make: flyJet, variants: 2 },
  'fly-rotor': { make: flyRotor, variants: 2 },
  'sail': { make: sail, variants: 2 },
} satisfies Record<string, { make: (rate: number, seed: number) => Float32Array; variants: number }>;

export type SoundName = keyof typeof RECIPES;
