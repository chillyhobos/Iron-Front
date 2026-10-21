// Map and unit drawing shared by the game and the map editor (unit art lives in sprites.ts).

import Phaser from 'phaser';
import { CAPTURE_POINTS, maxHpOf, TERRAIN, UNITS } from '../core/data';
import { displayHp, inBounds, tileAt } from '../core/rules';
import type { GameState, Tile, Unit } from '../core/state';
import { drawUnit, shade } from './sprites';

export const TILE = 40;
const T = TILE;

/** Fuel warning: about 3 days of fuel left (aircraft, ships), or not enough for a full move (vehicles). */
export function isLowFuel(u: Unit): boolean {
  const def = UNITS[u.type];
  return u.fuel !== undefined && u.fuel <= Math.max((def.fuelPerDay ?? 0) * 3 + 6, def.move);
}

export function drawTerrain(g: Phaser.GameObjects.Graphics, s: GameState) {
  g.clear();
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) drawTile(g, s, x, y, tileAt(s, x, y));
  }
}

function isRoadLike(s: GameState, x: number, y: number) {
  if (!inBounds(s, x, y)) return false;
  const t = tileAt(s, x, y).terrain;
  return t === 'road' || t === 'bridge' || TERRAIN[t].property;
}

/** Rivers join up with other river tiles (bridges included) and flow into the sea and ports. */
function isWaterLike(s: GameState, x: number, y: number) {
  if (!inBounds(s, x, y)) return false;
  const t = tileAt(s, x, y).terrain;
  return t === 'river' || t === 'bridge' || t === 'sea' || t === 'port';
}

/** A steady pseudo-random number in [0, 1) for a tile, so decoration varies but never flickers. */
function tileNoise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Sand and surf where the sea meets land. */
function drawShore(g: Phaser.GameObjects.Graphics, s: GameState, x: number, y: number) {
  const px = x * T;
  const py = y * T;
  const land = (dx: number, dy: number) => inBounds(s, x + dx, y + dy) && !isWaterLike(s, x + dx, y + dy);
  const edges: Array<[boolean, number, number, number, number]> = [
    [land(0, -1), 0, 0, T, 4], [land(0, 1), 0, T - 4, T, 4], [land(-1, 0), 0, 0, 4, T], [land(1, 0), T - 4, 0, 4, T],
  ];
  for (const [on, ex, ey, ew, eh] of edges) {
    if (!on) continue;
    g.fillStyle(0xe6d59a).fillRect(px + ex, py + ey, ew, eh);
    g.fillStyle(0xffffff, 0.75).fillRect(px + ex + (ew > eh ? 0 : ex ? -2 : 4), py + ey + (ew > eh ? (ey ? -2 : 4) : 0), ew > eh ? ew : 2, ew > eh ? 2 : eh);
  }
}

/** A channel wider than a road, with muddy banks and ripples. */
function drawRiver(g: Phaser.GameObjects.Graphics, s: GameState, x: number, y: number) {
  const px = x * T;
  const py = y * T;
  const w = 28;
  const c = (T - w) / 2;
  const links = [[-1, 0], [1, 0], [0, -1], [0, 1]].filter(([dx, dy]) => isWaterLike(s, x + dx, y + dy));
  const channel = (col: number, inset: number) => {
    const cw = w - inset * 2;
    const cc = c + inset;
    g.fillStyle(col).fillRect(px + cc, py + cc, cw, cw);
    for (const [dx, dy] of links) {
      if (dx < 0) g.fillRect(px, py + cc, cc, cw);
      if (dx > 0) g.fillRect(px + cc + cw, py + cc, cc, cw);
      if (dy < 0) g.fillRect(px + cc, py, cw, cc);
      if (dy > 0) g.fillRect(px + cc, py + cc + cw, cw, cc);
    }
  };
  channel(0x9c7b4f, 0);
  channel(0x4a97df, 3);
  g.lineStyle(2, 0xa9d4f5, 0.8);
  const across = links.some(([dx]) => dx !== 0) && !links.some(([, dy]) => dy !== 0);
  for (const o of [-5, 5]) {
    g.beginPath();
    if (across) { g.moveTo(px + 12 + o, py + 20 + o / 2); g.lineTo(px + 16 + o, py + 17 + o / 2); g.lineTo(px + 20 + o, py + 20 + o / 2); }
    else { g.moveTo(px + 17 + o / 2, py + 14 + o); g.lineTo(px + 20 + o / 2, py + 11 + o); g.lineTo(px + 23 + o / 2, py + 14 + o); }
    g.strokePath();
  }
}

function drawTile(g: Phaser.GameObjects.Graphics, s: GameState, x: number, y: number, t: Tile) {
  const px = x * T;
  const py = y * T;

  const r = tileNoise(x, y);
  if (t.terrain === 'sea') {
    g.fillStyle(0x3a78c4).fillRect(px, py, T, T);
    g.fillStyle(0x346db3).fillRect(px, py + T / 2, T, T / 2); // a touch deeper lower down
    g.lineStyle(2, 0x8dbcef, 0.7);
    for (const [ox, oy] of [[4 + r * 6, 12], [16 + r * 4, 27]]) {
      g.beginPath();
      g.moveTo(px + ox, py + oy);
      g.lineTo(px + ox + 7, py + oy - 4);
      g.lineTo(px + ox + 14, py + oy);
      g.strokePath();
    }
    drawShore(g, s, x, y);
  } else {
    // Grass, very slightly varied from tile to tile so big fields don't look tiled.
    g.fillStyle(r < 0.33 ? 0x8cc152 : r < 0.66 ? 0x88bd4f : 0x90c556).fillRect(px, py, T, T);
  }

  switch (t.terrain) {
    case 'plain': {
      // Grass tufts and the odd flower, placed differently on every tile.
      const tuft = (ox: number, oy: number) => {
        g.lineStyle(1.5, 0x5f9a35, 1);
        g.lineBetween(px + ox, py + oy, px + ox - 2, py + oy - 4);
        g.lineBetween(px + ox, py + oy, px + ox, py + oy - 5);
        g.lineBetween(px + ox, py + oy, px + ox + 2, py + oy - 4);
      };
      tuft(6 + r * 8, 12 + r * 4);
      tuft(26 - r * 6, 22 + r * 6);
      tuft(14 + r * 10, 34 - r * 4);
      if (r > 0.7) g.fillStyle(0xfff3a0).fillCircle(px + 30 - r * 10, py + 10 + r * 6, 1.6);
      break;
    }
    case 'forest':
      for (const [ox, oy, sz] of [[11, 4, 1], [28, 6, 0.9], [19, 17, 1.1], [7 + r * 4, 19, 0.75]]) {
        const w = 9 * sz;
        const h = 17 * sz;
        g.fillStyle(0x000000, 0.18).fillEllipse(px + ox + 2, py + oy + h + 3, w * 1.6, 4);
        g.fillStyle(0x5b3a1e).fillRect(px + ox - 1.5, py + oy + h - 3, 3, 5);
        g.fillStyle(0x2e6b2e).fillTriangle(px + ox, py + oy, px + ox - w, py + oy + h, px + ox + w, py + oy + h);
        g.fillStyle(0x3f8a3a).fillTriangle(px + ox, py + oy, px + ox - w, py + oy + h, px + ox - w * 0.1, py + oy + h);
        g.fillStyle(0x245624).fillTriangle(px + ox, py + oy + h * 0.35, px + ox - w * 0.8, py + oy + h * 0.75, px + ox + w * 0.8, py + oy + h * 0.75);
      }
      break;
    case 'mountain':
      // A smaller peak behind and a tall one in front, lit from the left, with snow caps.
      g.fillStyle(0x7d6145).fillTriangle(px + 18, py + 34, px + 29, py + 9, px + 39, py + 34);
      g.fillStyle(0x654c34).fillTriangle(px + 29, py + 9, px + 39, py + 34, px + 31, py + 34);
      g.fillStyle(0xeef3f6).fillTriangle(px + 26, py + 15, px + 29, py + 9, px + 32, py + 15);
      g.fillStyle(0x9a7a56).fillTriangle(px + 1, py + 36, px + 17, py + 4, px + 32, py + 36);
      g.fillStyle(0x76593c).fillTriangle(px + 17, py + 4, px + 32, py + 36, px + 20, py + 36);
      g.fillStyle(0xf7fafc).fillTriangle(px + 12, py + 14, px + 17, py + 4, px + 22, py + 14);
      g.fillStyle(0xd5e1ea).fillTriangle(px + 17, py + 4, px + 22, py + 14, px + 18, py + 14);
      g.lineStyle(1, 0x4a3726, 0.6).lineBetween(px + 8, py + 30, px + 13, py + 24);
      break;
    case 'road': {
      const w = 14;
      const c = (T - w) / 2;
      const strip = (col: number, inset: number) => {
        const ww = w - inset * 2;
        const cc = c + inset;
        g.fillStyle(col).fillRect(px + cc, py + cc, ww, ww);
        if (isRoadLike(s, x - 1, y)) g.fillRect(px, py + cc, cc, ww);
        if (isRoadLike(s, x + 1, y)) g.fillRect(px + cc + ww, py + cc, cc, ww);
        if (isRoadLike(s, x, y - 1)) g.fillRect(px + cc, py, ww, cc);
        if (isRoadLike(s, x, y + 1)) g.fillRect(px + cc, py + cc + ww, ww, cc);
      };
      strip(0xa89a6e, 0); // packed-earth edges
      strip(0xd2c59b, 2);
      break;
    }
    case 'river':
      drawRiver(g, s, x, y);
      break;
    case 'bridge': {
      drawRiver(g, s, x, y);
      // Wooden deck running across the river: east-west unless the river flows that way.
      const flowsAcross = (isWaterLike(s, x - 1, y) || isWaterLike(s, x + 1, y)) && !isWaterLike(s, x, y - 1) && !isWaterLike(s, x, y + 1);
      const deckAcross = !flowsAcross || isRoadLike(s, x - 1, y) || isRoadLike(s, x + 1, y);
      const d = 18;
      const c = (T - d) / 2;
      const dark = 0x5e4426;
      if (deckAcross) {
        g.fillStyle(0xa07a48).fillRect(px, py + c, T, d);
        g.fillStyle(dark);
        for (let i = 4; i < T; i += 7) g.fillRect(px + i, py + c, 1.5, d);
        g.fillRect(px, py + c - 2, T, 2).fillRect(px, py + c + d, T, 2);
      } else {
        g.fillStyle(0xa07a48).fillRect(px + c, py, d, T);
        g.fillStyle(dark);
        for (let i = 4; i < T; i += 7) g.fillRect(px + c, py + i, d, 1.5);
        g.fillRect(px + c - 2, py, 2, T).fillRect(px + c + d, py, 2, T);
      }
      if (t.damage) {
        // Shelled: jagged cracks across the deck and a scorched hole.
        g.fillStyle(0x2b1d10, 0.85).fillCircle(px + 22, py + 19, 3.5);
        g.lineStyle(2, 0x1a1108, 1);
        for (const crack of [[[8, 14], [14, 20], [12, 24], [19, 27]], [[22, 19], [27, 15], [31, 21], [35, 18]], [[22, 19], [20, 12], [24, 9]]]) {
          g.beginPath();
          crack.forEach(([cx, cy], i) => (i ? g.lineTo(px + cx, py + cy) : g.moveTo(px + cx, py + cy)));
          g.strokePath();
        }
      }
      break;
    }
    case 'city':
    case 'factory':
    case 'hq':
      drawBuilding(g, s, px, py, t);
      break;
    case 'port':
      drawPort(g, s, px, py, t);
      break;
    case 'airfield':
      drawAirfield(g, s, px, py, t);
      break;
  }

  if (t.capture < CAPTURE_POINTS) {
    g.fillStyle(0x000000, 0.6).fillRect(px + 4, py + T - 6, T - 8, 4);
    g.fillStyle(0xffffff).fillRect(px + 4, py + T - 6, (T - 8) * (1 - t.capture / CAPTURE_POINTS), 4);
  }
  g.lineStyle(1, 0x000000, 0.12).strokeRect(px, py, T, T);
}

function drawBuilding(g: Phaser.GameObjects.Graphics, s: GameState, px: number, py: number, t: Tile) {
  const col = t.owner === null ? 0xbdbdbd : s.players[t.owner].color;
  const side = shade(col, 0.72); // shaded right-hand walls
  const roof = shade(col, 0.55);
  const dark = 0x222222;
  g.fillStyle(0x000000, 0.2).fillEllipse(px + 21, py + 36, 34, 6);
  g.lineStyle(2, dark, 1).fillStyle(col);
  if (t.terrain === 'city') {
    g.fillRect(px + 6, py + 15, 12, 20).strokeRect(px + 6, py + 15, 12, 20);
    g.fillStyle(side).fillRect(px + 14, py + 16, 3, 18);
    g.fillStyle(roof).fillRect(px + 5, py + 13, 14, 3).strokeRect(px + 5, py + 13, 14, 3);
    g.fillStyle(col).fillRect(px + 20, py + 8, 14, 27).strokeRect(px + 20, py + 8, 14, 27);
    g.fillStyle(side).fillRect(px + 30, py + 9, 3, 25);
    g.fillStyle(roof).fillRect(px + 19, py + 6, 16, 3).strokeRect(px + 19, py + 6, 16, 3);
    g.fillStyle(0xfff3b0);
    for (const [wx, wy] of [[9, 19], [9, 26], [23, 12], [27, 12], [23, 20], [27, 20], [23, 27], [27, 27]]) {
      g.fillRect(px + wx, py + wy, 3, 4);
    }
    g.fillStyle(0x3a2a1a).fillRect(px + 10, py + 30, 4, 5); // door
  } else if (t.terrain === 'factory') {
    // Chimney smoke first, so the building sits in front of it.
    g.fillStyle(0xd9d9d9, 0.85).fillCircle(px + 31, py + 3, 3).fillCircle(px + 35, py + 1, 2.3);
    g.fillStyle(col).fillRect(px + 26, py + 5, 6, 14).strokeRect(px + 26, py + 5, 6, 14);
    g.fillStyle(roof).fillRect(px + 25, py + 5, 8, 3);
    g.fillStyle(col).fillRect(px + 5, py + 17, 30, 18).strokeRect(px + 5, py + 17, 30, 18);
    g.fillStyle(side).fillRect(px + 31, py + 18, 3, 16);
    g.fillStyle(roof).fillTriangle(px + 5, py + 17, px + 12, py + 11, px + 12, py + 17);
    g.fillTriangle(px + 13, py + 17, px + 20, py + 11, px + 20, py + 17);
    g.fillStyle(0xbfe6ff).fillRect(px + 7, py + 21, 5, 4).fillRect(px + 26, py + 21, 4, 4);
    g.fillStyle(dark).fillRect(px + 15, py + 25, 10, 10);
    g.lineStyle(1, 0x555555, 1);
    for (let yy = 27; yy < 35; yy += 2.5) g.lineBetween(px + 15, py + yy, px + 25, py + yy); // roller door
  } else {
    g.fillRect(px + 9, py + 16, 22, 19).strokeRect(px + 9, py + 16, 22, 19);
    g.fillStyle(side).fillRect(px + 27, py + 17, 3, 17);
    g.fillStyle(roof).fillTriangle(px + 6, py + 17, px + 20, py + 7, px + 34, py + 17);
    g.lineStyle(2, dark, 1).strokeTriangle(px + 6, py + 17, px + 20, py + 7, px + 34, py + 17);
    g.lineStyle(2, dark, 1).lineBetween(px + 20, py + 7, px + 20, py + 1);
    g.fillStyle(col).fillTriangle(px + 20, py + 1, px + 29, py + 3, px + 20, py + 6);
    g.fillStyle(0xfff3b0).fillRect(px + 17, py + 24, 6, 11);
    g.fillStyle(0xf0b429).fillCircle(px + 20, py + 20, 2);
  }
}

/** Harbour: water basin with a wooden pier and a crane in the owner's colour. */
function drawPort(g: Phaser.GameObjects.Graphics, s: GameState, px: number, py: number, t: Tile) {
  const col = t.owner === null ? 0xbdbdbd : s.players[t.owner].color;
  const dark = 0x222222;
  g.fillStyle(0x3d7cc9).fillRect(px + 2, py + 20, T - 4, T - 22);
  g.fillStyle(0x8a6a3f).fillRect(px + 4, py + 16, T - 8, 6).fillRect(px + 16, py + 22, 6, 14);
  g.lineStyle(2, dark, 1).fillStyle(col);
  g.fillRect(px + 7, py + 4, 5, 13).strokeRect(px + 7, py + 4, 5, 13);
  g.fillRect(px + 7, py + 3, 22, 4).strokeRect(px + 7, py + 3, 22, 4);
  g.lineStyle(1, dark, 1).lineBetween(px + 27, py + 7, px + 27, py + 14);
  g.fillStyle(col).fillRect(px + 24, py + 13, 7, 4);
}

/** Runway with centre dashes and a control tower in the owner's colour. */
function drawAirfield(g: Phaser.GameObjects.Graphics, s: GameState, px: number, py: number, t: Tile) {
  const col = t.owner === null ? 0xbdbdbd : s.players[t.owner].color;
  const dark = 0x222222;
  g.fillStyle(0x6f7680).fillRect(px + 3, py + 20, T - 6, 12);
  g.fillStyle(0xf2f2f2);
  for (let x = 6; x < T - 8; x += 9) g.fillRect(px + x, py + 25, 5, 2);
  g.lineStyle(2, dark, 1).fillStyle(col);
  g.fillRect(px + 25, py + 6, 8, 14).strokeRect(px + 25, py + 6, 8, 14);
  g.fillStyle(0xbfe6ff).fillRect(px + 24, py + 3, 10, 5);
  g.lineStyle(1, dark, 1).strokeRect(px + 24, py + 3, 10, 5);
}

/** Units face the enemy: armies whose HQ is on the right half of the map face left. */
function facingOf(s: GameState, owner: number): 1 | -1 {
  const hq = s.tiles.findIndex(t => t.terrain === 'hq' && t.owner === owner);
  if (hq < 0) return 1;
  return hq % s.width >= s.width / 2 ? -1 : 1;
}

export function makeUnitSprite(scene: Phaser.Scene, s: GameState, u: Unit) {
  const def = UNITS[u.type];
  const color = s.players[u.owner].color;
  const c = scene.add.container(u.x * T + T / 2, u.y * T + T / 2);
  const g = scene.add.graphics();
  const air = def.moveType === 'air';
  const ship = def.moveType === 'ship';
  // Aircraft fly above a small, faint shadow; ships sit in the water.
  if (air) g.fillStyle(0x000000, 0.22).fillEllipse(0, 16, 24, 5);
  else if (!ship) g.fillStyle(0x000000, 0.28).fillEllipse(0, 15, 32, 7);
  drawUnit(g, u.type, color, facingOf(s, u.owner));
  if (air) g.setY(-2);
  c.add(g);

  const hp = displayHp(u.hp);
  if (hp < displayHp(maxHpOf(u.type))) {
    const hpText = scene.add.text(T / 2 - 3, T / 2 - 3, String(hp), {
      fontFamily: 'Arial', fontSize: '12px', fontStyle: 'bold', color: '#ffe066', stroke: '#000000', strokeThickness: 3,
    }).setOrigin(1, 1);
    c.add(hpText);
  }

  // Small status badges: passengers aboard (top-left), low fuel / no ammo / no bridge kit (top-right).
  const badge = (x: number, y: number, text: string, bg: string, origin: number) =>
    scene.add.text(x, y, text, {
      fontFamily: 'Arial', fontSize: '10px', fontStyle: 'bold', color: '#111111', backgroundColor: bg, padding: { x: 2, y: 0 },
    }).setOrigin(origin, 0);
  if (u.cargo?.length) c.add(badge(-T / 2 + 2, -T / 2 + 1, `▲${u.cargo.length}`, '#ffd76a', 0));
  const warnings = [
    ...(u.fuel !== undefined && isLowFuel(u) ? ['F'] : []),
    ...(def.ammo !== undefined && (u.ammo ?? 0) <= 0 ? ['A'] : []),
    ...(def.bridgeKits !== undefined && (u.kits ?? 0) <= 0 ? ['K'] : []),
  ];
  if (warnings.length) c.add(badge(T / 2 - 2, -T / 2 + 1, warnings.join(''), '#ff7b7b', 1));
  if (u.owner === s.current && u.acted) c.setAlpha(0.45);
  return c;
}
