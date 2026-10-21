// Unit art: original, code-drawn vector sprites in the owner's colour. Every unit is
// drawn facing right around (0, 0) inside a 40×40 tile (about ±19 across); Pen mirrors
// it for armies that face left.

import Phaser from 'phaser';
import { UNITS, type UnitType } from '../core/data';

const OUTLINE = 0x161616;
const METAL = 0x5d646e;
const METAL_DARK = 0x3a3f46;
const TREAD = 0x262626;
const SKIN = 0xf0c08a;
const GLASS = 0xa9dcff;
const WOOD = 0x6b4a2b;

/** Lighten (f > 1) or darken (f < 1) a colour. */
export function shade(color: number, f: number): number {
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((color >> shift) & 0xff) * f)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

type Pt = [number, number];

/** Draws in "facing right" coordinates; mirrors x when the unit faces left. */
class Pen {
  constructor(private g: Phaser.GameObjects.Graphics, private f: 1 | -1) {}
  private X(x: number) { return x * this.f; }

  /** Filled shape with the standard dark outline (pass stroke = false for details). */
  rect(x: number, y: number, w: number, h: number, color: number, r = 0, stroke = true) {
    const X = this.f === 1 ? x : -(x + w);
    this.g.fillStyle(color);
    if (r) this.g.fillRoundedRect(X, y, w, h, r); else this.g.fillRect(X, y, w, h);
    if (stroke) {
      this.g.lineStyle(1.5, OUTLINE, 1);
      if (r) this.g.strokeRoundedRect(X, y, w, h, r); else this.g.strokeRect(X, y, w, h);
    }
    return this;
  }
  circle(x: number, y: number, r: number, color: number, stroke = true) {
    this.g.fillStyle(color).fillCircle(this.X(x), y, r);
    if (stroke) this.g.lineStyle(1.5, OUTLINE, 1).strokeCircle(this.X(x), y, r);
    return this;
  }
  ellipse(x: number, y: number, w: number, h: number, color: number, stroke = true) {
    this.g.fillStyle(color).fillEllipse(this.X(x), y, w, h);
    if (stroke) this.g.lineStyle(1.5, OUTLINE, 1).strokeEllipse(this.X(x), y, w, h);
    return this;
  }
  poly(pts: Pt[], color: number, stroke = true) {
    const p = pts.map(([x, y]) => ({ x: this.X(x), y }));
    this.g.fillStyle(color).fillPoints(p, true);
    if (stroke) this.g.lineStyle(1.5, OUTLINE, 1).strokePoints(p, true);
    return this;
  }
  /** A thick bar (gun barrels, rifles, rotor blades): outline first, then colour on top. */
  bar(x1: number, y1: number, x2: number, y2: number, width: number, color: number, stroke = true) {
    if (stroke) this.g.lineStyle(width + 2, OUTLINE, 1).lineBetween(this.X(x1), y1, this.X(x2), y2);
    this.g.lineStyle(width, color, 1).lineBetween(this.X(x1), y1, this.X(x2), y2);
    return this;
  }
}

// ---------------------------------------------------------------- shared parts

/** Tracks with road wheels, from x to x + w, top at y. */
function treads(p: Pen, x: number, y: number, w: number, h: number) {
  p.rect(x, y, w, h, TREAD, h / 2);
  const n = Math.max(3, Math.round(w / 8));
  for (let i = 0; i < n; i++) p.circle(x + h / 2 + ((w - h) * i) / (n - 1), y + h / 2, h / 2 - 1.8, METAL, false);
}

function wheel(p: Pen, x: number, y: number, r = 4.5) {
  p.circle(x, y, r, TREAD).circle(x, y, r / 2.2, METAL, false);
}

/** A soldier standing at x, in the team colour, holding nothing (weapons are added on top). */
function soldier(p: Pen, color: number, opts: { x?: number; helmet?: number; crouch?: boolean } = {}) {
  const x = opts.x ?? -2;
  const dark = shade(color, 0.55);
  const top = opts.crouch ? 2 : 0;
  // Legs and boots.
  p.rect(x - 5, 6 + top, 4, 9 - top, dark, 1).rect(x + 1, 6 + top, 4, 9 - top, dark, 1);
  p.rect(x - 6, 13, 6, 3, 0x1b1b1b, 1, false).rect(x + 1, 13, 6, 3, 0x1b1b1b, 1, false);
  // Body, belt, head and helmet.
  p.rect(x - 6, -6 + top, 12, 13, color, 3);
  p.rect(x - 6, 4 + top, 12, 2, dark, 0, false);
  p.circle(x, -11 + top, 5, SKIN);
  p.poly([[x - 6.5, -12 + top], [x - 5, -17 + top], [x + 3, -18 + top], [x + 6.5, -13 + top], [x + 6.5, -11 + top], [x - 6.5, -11 + top]], opts.helmet ?? dark);
}

// ---------------------------------------------------------------- the units

type Drawer = (p: Pen, color: number) => void;

const DRAW: Partial<Record<UnitType, Drawer>> = {
  rifle(p, c) {
    soldier(p, c);
    p.bar(-6, 2, 13, -3, 2.5, WOOD).bar(6, -2, 16, -4.5, 1.6, METAL_DARK, false);
    p.circle(4, 0, 2.2, SKIN); // hand on the stock
  },

  bazooka(p, c) {
    p.rect(-11, -5, 6, 10, shade(c, 0.45), 2); // backpack with spare rockets
    soldier(p, c);
    // Launcher tube over the shoulder, with a flared muzzle and a red-tipped round.
    p.bar(-13, -6, 15, -9, 5, 0x4f5a2a);
    p.poly([[14, -12], [19, -13], [19, -5], [14, -6]], 0x3d4620);
    p.circle(20, -9, 2, 0xd94a3a, false);
    p.circle(3, -4, 2.2, SKIN);
  },

  sniper(p, c) {
    soldier(p, c, { crouch: true, helmet: 0x3d5a2a });
    // Ghillie hood: leafy fringe over helmet and shoulders.
    for (const [x, y] of [[-8, -11], [-5, -16], [0, -17], [4, -14], [-8, -4], [5, -4]] as Pt[]) {
      p.poly([[x - 3, y + 3], [x, y - 3], [x + 3, y + 3]], 0x4a6b2f, false);
    }
    // Long rifle with a scope and bipod.
    p.bar(-5, 3, 19, -2, 2, 0x2f2a24).rect(4, -6, 7, 3, METAL_DARK, 1);
    p.bar(15, -1, 17, 6, 1, METAL_DARK, false).bar(15, -1, 13, 6, 1, METAL_DARK, false);
  },

  engineer(p, c) {
    soldier(p, c, { helmet: 0xf2c230 });
    p.rect(-6, -2, 12, 2.5, 0xff9f1c, 0, false); // hi-vis stripe
    p.rect(-9, -16, 15, 2, 0xd9a91a, 1, false); // hard-hat brim
    // Wrench in hand and a toolbox at the feet.
    p.bar(4, 2, 13, -8, 2.2, 0xb8bec6);
    p.circle(13.5, -9, 2.6, 0xb8bec6);
    p.rect(7, 8, 10, 7, 0xc0392b, 1).rect(10, 6, 4, 2, METAL_DARK, 0, false);
  },

  scout(p, c) {
    const dark = shade(c, 0.6);
    p.poly([[-16, 6], [-16, -1], [-8, -2], [-4, -8], [6, -8], [11, -2], [17, 0], [17, 6]], c);
    p.poly([[-3, -7], [5, -7], [9, -2], [-3, -2]], GLASS, false);
    p.rect(-16, 3, 33, 2, dark, 0, false);
    p.bar(-1, -9, -1, -13, 2, METAL_DARK, false).bar(-2, -13, 11, -15, 2.2, METAL_DARK); // roof gun
    wheel(p, -9, 8, 5);
    wheel(p, 10, 8, 5);
  },

  apc(p, c) {
    const dark = shade(c, 0.6);
    treads(p, -18, 6, 35, 9);
    p.poly([[-17, 7], [-17, -6], [6, -6], [16, 0], [17, 7]], c);
    p.rect(-14, -9, 9, 3, dark, 1); // hatch
    p.rect(-15, 0, 20, 2.5, dark, 0, false);
    p.rect(-2, -4, 4, 3, GLASS, 0, false).rect(4, -4, 4, 3, GLASS, 0, false);
    p.bar(-11, -9, -13, -17, 1, METAL_DARK, false); // antenna
  },

  ltank(p, c) {
    const light = shade(c, 1.2);
    treads(p, -17, 5, 34, 10);
    p.poly([[-16, 6], [-15, -1], [14, -1], [17, 6]], c);
    p.rect(-9, -9, 16, 9, light, 4);
    p.bar(6, -5, 19, -6, 3.2, METAL_DARK);
    p.circle(-3, -10, 2, shade(c, 0.6), false); // commander's hatch
  },

  htank(p, c) {
    const light = shade(c, 1.2);
    const dark = shade(c, 0.6);
    treads(p, -19, 4, 38, 12);
    p.poly([[-18, 5], [-17, -3], [15, -3], [19, 5]], c);
    p.rect(-18, 1, 37, 2, dark, 0, false);
    p.rect(-11, -13, 20, 11, light, 4);
    p.bar(8, -8, 20, -8, 4.5, METAL_DARK).rect(17, -11, 4, 6, METAL_DARK, 1); // big gun with muzzle brake
    p.rect(-8, -16, 6, 3, dark, 1); // cupola
  },

  artillery(p, c) {
    const dark = shade(c, 0.6);
    treads(p, -16, 6, 30, 9);
    p.poly([[-15, 7], [-14, 0], [12, 0], [14, 7]], c);
    p.bar(-3, -3, 17, -16, 4, METAL_DARK); // long barrel raised for indirect fire
    p.poly([[-9, 0], [-7, -8], [3, -8], [6, 0]], dark); // gun shield / cradle
    p.circle(-2, -4, 3, METAL);
  },

  rocket(p, c) {
    const dark = shade(c, 0.6);
    p.rect(-17, 1, 34, 5, dark, 1); // chassis
    p.poly([[8, 1], [8, -9], [14, -9], [18, -3], [18, 1]], c); // cab
    p.poly([[10, -8], [13, -8], [16, -3], [10, -3]], GLASS, false);
    // Long launch box raised toward the front, rocket tubes showing at its front end.
    p.poly([[-12, 1], [-7, -3], [-3, 1]], dark); // lifting arm
    p.poly([[-17, -2], [1, -14], [5, -9], [-13, 3]], c);
    p.poly([[1, -14], [5, -9], [3, -8], [-1, -13]], dark, false); // front face
    for (const [x, y] of [[1.2, -12.2], [3.2, -9.6]] as Pt[]) p.circle(x, y, 1.3, 0xd94a3a, false);
    p.bar(-14, -3, 0, -12, 1, shade(c, 0.75), false); // panel line
    wheel(p, -12, 8); wheel(p, -3, 8); wheel(p, 12, 8);
  },

  missile(p, c) {
    const dark = shade(c, 0.6);
    p.rect(-17, 1, 34, 5, dark, 1);
    p.poly([[8, 1], [8, -9], [14, -9], [18, -3], [18, 1]], c);
    p.poly([[10, -8], [13, -8], [16, -3], [10, -3]], GLASS, false);
    p.poly([[-13, 1], [-9, -4], [-2, -2], [-6, 2]], c); // launcher cradle
    // Two big white surface-to-air missiles pointing steeply up.
    for (const dx of [-11, -5]) {
      p.poly([[dx - 2, -1], [dx + 6, -15], [dx + 9, -14], [dx + 1, 0]], 0xf2f2f2);
      p.poly([[dx + 6, -15], [dx + 9, -19], [dx + 9, -14]], 0xd94a3a, false);
    }
    wheel(p, -12, 8); wheel(p, -3, 8); wheel(p, 12, 8);
  },

  flak(p, c) {
    const light = shade(c, 1.2);
    treads(p, -17, 5, 34, 10);
    p.poly([[-16, 6], [-15, -1], [14, -1], [17, 6]], c);
    p.rect(-9, -8, 15, 8, light, 3);
    // Twin quick-firing cannons angled up at aircraft, and a small radar.
    p.bar(-1, -6, 11, -17, 2.4, METAL_DARK).bar(3, -5, 15, -16, 2.4, METAL_DARK);
    p.bar(-7, -8, -7, -13, 1, METAL_DARK, false);
    p.ellipse(-7, -14, 7, 3, METAL);
  },

  gunship(p, c) {
    const dark = shade(c, 0.6);
    p.rect(-21, -5, 16, 4, c, 2); // tail boom
    p.poly([[-22, -10], [-17, -10], [-17, -1], [-22, -3]], dark); // tail fin
    p.circle(-21, -6, 3, METAL, false);
    p.ellipse(1, -2, 26, 13, c);
    p.ellipse(7, -4, 10, 7, GLASS, false);
    p.rect(-6, 2, 10, 3, dark, 1); // stub wing
    p.rect(-4, 5, 8, 3, METAL_DARK, 1); // rocket pod
    p.bar(13, 1, 17, 3, 2, METAL_DARK, false); // chin gun
    p.bar(-1, 4, -1, 9, 1.4, METAL_DARK, false).bar(-8, 9, 10, 9, 1.6, METAL_DARK, false); // skid
    p.bar(1, -9, 1, -12, 2, METAL_DARK, false).bar(-18, -12, 19, -12, 2, 0x333333); // rotor
  },

  airlift(p, c) {
    const dark = shade(c, 0.6);
    p.rect(-18, -7, 36, 13, c, 6);
    p.poly([[13, -7], [18, -4], [18, 2], [13, 0]], GLASS, false);
    for (const x of [-11, -5, 1, 7]) p.rect(x, -3, 3, 3, GLASS, 0, false);
    p.rect(-18, 3, 36, 3, dark, 0, false);
    p.bar(-6, 7, -6, 10, 1.4, METAL_DARK, false).bar(6, 7, 6, 10, 1.4, METAL_DARK, false);
    // Two rotors, front and back.
    for (const x of [-11, 11]) p.bar(x, -7, x, -11, 2, METAL_DARK, false).bar(x - 10, -12, x + 10, -12, 2, 0x333333);
  },

  fighter(p, c) {
    const dark = shade(c, 0.6);
    p.poly([[-14, -3], [-19, -13], [-13, -13], [-7, -3]], dark); // tail fin
    p.poly([[-18, -3], [10, -4], [20, 0], [10, 3], [-18, 2]], c); // fuselage
    p.poly([[2, -4], [7, -8], [11, -4]], GLASS, false); // canopy
    p.poly([[-6, 0], [4, 1], [-12, 10], [-16, 10]], dark); // swept wing
    p.poly([[-21, -2], [-18, -2], [-18, 1], [-21, 1]], 0xff9a3c, false); // afterburner
    p.bar(6, 4, 0, 5, 1.6, METAL_DARK, false); // missile under the wing
  },

  bomber(p, c) {
    const dark = shade(c, 0.6);
    p.poly([[-14, -4], [-20, -14], [-14, -14], [-8, -4]], dark);
    p.poly([[-20, -4], [12, -6], [20, -1], [13, 4], [-20, 3]], c);
    p.poly([[10, -6], [15, -9], [18, -4]], GLASS, false);
    p.poly([[-8, 0], [6, 0], [-4, 12], [-14, 12]], dark); // big wing
    p.ellipse(-3, 5, 8, 4, METAL).ellipse(-9, 9, 8, 4, METAL); // engines
    p.rect(-6, 3, 6, 2, 0x222222, 0, false); // bomb bay
  },

  cruiser(p, c) {
    const dark = shade(c, 0.6);
    p.poly([[-19, 0], [14, 0], [20, -3], [16, 8], [-17, 8]], c);
    p.rect(-19, 4, 37, 2, dark, 0, false);
    p.rect(-9, -7, 12, 7, shade(c, 1.15), 1); // superstructure
    p.rect(-6, -11, 5, 4, shade(c, 1.15), 1);
    p.bar(-4, -11, -4, -17, 1.2, METAL_DARK, false).bar(-7, -15, -1, -15, 1.2, METAL_DARK, false); // mast
    p.rect(5, -4, 6, 4, METAL, 2).bar(9, -3, 15, -5, 1.8, METAL_DARK); // forward gun
    p.rect(-16, -4, 5, 4, METAL, 1); // missile cells
    p.bar(-19, 9, -13, 9, 1.2, 0xffffff, false).bar(14, 9, 18, 9, 1.2, 0xffffff, false); // wake
  },

  battleship(p, c) {
    const dark = shade(c, 0.6);
    const light = shade(c, 1.15);
    p.poly([[-20, -1], [14, -1], [21, -4], [17, 9], [-18, 9]], c);
    p.rect(-20, 5, 38, 2, dark, 0, false);
    p.rect(-5, -11, 9, 10, light, 1); // bridge tower
    p.rect(-3, -15, 5, 4, light, 1);
    p.rect(-11, -8, 4, 7, METAL_DARK, 1); // funnel
    // Two big turrets with long guns.
    p.rect(6, -5, 8, 4, METAL, 2).bar(12, -4, 21, -6, 2.4, METAL_DARK);
    p.rect(-17, -5, 8, 4, METAL, 2).bar(-11, -4, -3, -7, 2.4, METAL_DARK);
    p.bar(-20, 10, -14, 10, 1.2, 0xffffff, false).bar(15, 10, 20, 10, 1.2, 0xffffff, false);
  },

  lander(p, c) {
    const dark = shade(c, 0.6);
    p.poly([[-19, -3], [12, -3], [19, 2], [19, 8], [-18, 8]], c);
    p.poly([[12, -3], [19, -8], [20, -6], [19, 2]], dark); // bow ramp, half open
    p.rect(-6, -2, 17, 3, shade(c, 0.4), 0, false); // open cargo well
    p.rect(-18, -11, 10, 9, shade(c, 1.15), 1); // bridge at the stern
    p.rect(-16, -9, 6, 2.5, GLASS, 0, false);
    p.bar(-19, 9, -13, 9, 1.2, 0xffffff, false);
  },
};

/** Fallback for unit types without art: a plain silhouette by move type. */
function generic(p: Pen, c: number, type: UnitType) {
  const m = UNITS[type]?.moveType;
  if (m === 'foot' || m === 'boot') soldier(p, c);
  else if (m === 'air') p.ellipse(0, -2, 34, 12, c);
  else if (m === 'ship') p.poly([[-18, -1], [14, -1], [19, 4], [14, 9], [-16, 9]], c);
  else { treads(p, -16, 5, 32, 10); p.rect(-14, -6, 28, 11, c, 3); }
}

/** Draw a unit's sprite centred on (0, 0). facing: 1 = right, -1 = left. */
export function drawUnit(g: Phaser.GameObjects.Graphics, type: UnitType, color: number, facing: 1 | -1 = 1) {
  const p = new Pen(g, facing);
  (DRAW[type] ?? ((pen, c) => generic(pen, c, type)))(p, color);
}
