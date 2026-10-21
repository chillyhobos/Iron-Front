// Map-editing logic (pure, no graphics): an editable grid, brushes with
// optional symmetry, flood fill, resize, validation and turn-order setup.

import { BLOCKED, TERRAIN, UNITS, type TerrainId, type UnitType } from './data';
import { MODES, TEAMS_3V3, TURN_ORDER_3V3, mapMode, type MapDef, type MapMode, type MapUnit } from './maps';

export const MIN_SIZE = 8;
export const MAX_SIZE = 40;

/** Mutable working copy of a map. owner: 0 = neutral, 1–6 = start slot. */
export interface EditGrid {
  id: string;
  name: string;
  /** Standard (2–4 players) or 3 vs 3 (six slots, fixed teams). Missing = standard. */
  mode?: MapMode;
  width: number;
  height: number;
  terrain: TerrainId[];
  owner: number[];
  units: MapUnit[];
}

export type Symmetry = 'none' | 'mirror-x' | 'mirror-y' | 'quad' | 'rotate';

export type Brush =
  | { kind: 'terrain'; terrain: TerrainId }
  | { kind: 'building'; terrain: TerrainId; slot: number }
  | { kind: 'unit'; unitType: UnitType; slot: number }
  | { kind: 'eraseUnit' };

const CHAR_TERRAIN = Object.fromEntries(
  (Object.keys(TERRAIN) as TerrainId[]).map(id => [TERRAIN[id].char, id]),
) as Record<string, TerrainId>;

// ---------------------------------------------------------------- conversion

export function blankGrid(width: number, height: number, name = 'New map'): EditGrid {
  return {
    id: `custom-${Date.now().toString(36)}`,
    name,
    width,
    height,
    terrain: new Array(width * height).fill('plain'),
    owner: new Array(width * height).fill(0),
    units: [],
  };
}

export function toGrid(map: MapDef): EditGrid {
  const height = map.terrain.length;
  const width = map.terrain[0]?.length ?? 0;
  const g = blankGrid(width, height, map.name);
  g.id = map.id;
  g.mode = mapMode(map);
  const maxSlot = MODES[g.mode].slots.length;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      g.terrain[i] = CHAR_TERRAIN[map.terrain[y][x]] ?? 'plain';
      const slot = Number(map.owners?.[y]?.[x]);
      g.owner[i] = slot >= 1 && slot <= maxSlot && TERRAIN[g.terrain[i]].property ? slot : 0;
    }
  }
  g.units = (map.units ?? []).filter(u => u.x >= 0 && u.y >= 0 && u.x < width && u.y < height && UNITS[u.type]);
  return g;
}

export function fromGrid(g: EditGrid): MapDef {
  const terrain: string[] = [];
  const owners: string[] = [];
  for (let y = 0; y < g.height; y++) {
    let tr = '';
    let ow = '';
    for (let x = 0; x < g.width; x++) {
      const i = y * g.width + x;
      tr += TERRAIN[g.terrain[i]].char;
      ow += g.owner[i] ? String(g.owner[i]) : '.';
    }
    terrain.push(tr);
    owners.push(ow);
  }
  const slots = validateGrid(g).slots;
  const mode = mapMode(g);
  return {
    id: g.id,
    name: g.name.trim() || 'Untitled map',
    ...(mode === '3v3' ? { mode, teams: { ...TEAMS_3V3 } } : {}),
    maxPlayers: slots.length,
    slotsByPlayerCount: turnOrders(g, slots),
    terrain,
    owners,
    units: g.units.map(u => ({ ...u })),
  };
}

// ---------------------------------------------------------------- symmetry

// How start slots swap when a tile is mirrored.
// Standard layout: 1 top-left, 2 top-right, 3 bottom-left, 4 bottom-right.
// 3 vs 3 layout: west column 1 (top), 2 (middle), 3 (bottom); east column 4, 5, 6.
const SWAPS: Record<MapMode, { x: number[]; y: number[]; xy: number[] }> = {
  standard: { x: [0, 2, 1, 4, 3], y: [0, 3, 4, 1, 2], xy: [0, 4, 3, 2, 1] },
  '3v3': { x: [0, 4, 5, 6, 1, 2, 3], y: [0, 3, 2, 1, 6, 5, 4], xy: [0, 6, 5, 4, 3, 2, 1] },
};

/** The tile itself plus its mirror images, each with how the owner slot maps. */
export function mirrorPoints(g: EditGrid, x: number, y: number, sym: Symmetry) {
  const mx = g.width - 1 - x;
  const my = g.height - 1 - y;
  const swap = SWAPS[mapMode(g)];
  const pts: Array<{ x: number; y: number; slot: (s: number) => number }> = [{ x, y, slot: s => s }];
  if (sym === 'mirror-x' || sym === 'quad') pts.push({ x: mx, y, slot: s => swap.x[s] });
  if (sym === 'mirror-y' || sym === 'quad') pts.push({ x, y: my, slot: s => swap.y[s] });
  if (sym === 'rotate' || sym === 'quad') pts.push({ x: mx, y: my, slot: s => swap.xy[s] });
  const seen = new Set<string>();
  return pts.filter(p => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- painting

export function unitIndexAt(g: EditGrid, x: number, y: number) {
  return g.units.findIndex(u => u.x === x && u.y === y);
}

function canStand(type: UnitType, terrain: TerrainId) {
  return TERRAIN[terrain].cost[UNITS[type].moveType] < BLOCKED;
}

/** Paint one brush stroke at (x, y) and its mirror images. Returns true if anything changed. */
export function applyBrush(g: EditGrid, x: number, y: number, brush: Brush, sym: Symmetry): boolean {
  const before = snapshot(g);
  for (const p of mirrorPoints(g, x, y, sym)) paintOne(g, p.x, p.y, brush, p.slot);
  return snapshot(g) !== before;
}

function paintOne(g: EditGrid, x: number, y: number, brush: Brush, mapSlot: (s: number) => number) {
  const i = y * g.width + x;
  switch (brush.kind) {
    case 'terrain':
      g.terrain[i] = brush.terrain;
      g.owner[i] = 0;
      break;
    case 'building': {
      const slot = mapSlot(brush.slot);
      if (brush.terrain === 'hq') {
        if (!slot) return; // an HQ always belongs to a player
        // One HQ per player: an older one becomes a city.
        g.terrain.forEach((t, j) => {
          if (t === 'hq' && g.owner[j] === slot && j !== i) g.terrain[j] = 'city';
        });
      }
      g.terrain[i] = brush.terrain;
      g.owner[i] = slot;
      break;
    }
    case 'unit': {
      const slot = mapSlot(brush.slot);
      if (!slot || !canStand(brush.unitType, g.terrain[i])) return;
      const existing = unitIndexAt(g, x, y);
      if (existing !== -1) g.units.splice(existing, 1);
      g.units.push({ type: brush.unitType, slot, x, y });
      return;
    }
    case 'eraseUnit': {
      const existing = unitIndexAt(g, x, y);
      if (existing !== -1) g.units.splice(existing, 1);
      return;
    }
  }
  // Terrain changed: drop a unit that can no longer stand here.
  const u = unitIndexAt(g, x, y);
  if (u !== -1 && !canStand(g.units[u].type, g.terrain[i])) g.units.splice(u, 1);
}

/** Flood-fill the connected area of matching terrain (and its mirror images). */
export function floodFill(g: EditGrid, x: number, y: number, terrain: TerrainId, sym: Symmetry): boolean {
  const before = snapshot(g);
  for (const p of mirrorPoints(g, x, y, sym)) {
    const start = p.y * g.width + p.x;
    const from = g.terrain[start];
    if (from === terrain) continue;
    const stack = [start];
    const seen = new Set<number>([start]);
    while (stack.length) {
      const i = stack.pop()!;
      paintOne(g, i % g.width, Math.floor(i / g.width), { kind: 'terrain', terrain }, s => s);
      const cx = i % g.width;
      const cy = Math.floor(i / g.width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= g.width || ny >= g.height) continue;
        const n = ny * g.width + nx;
        if (!seen.has(n) && g.terrain[n] === from) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
  }
  return snapshot(g) !== before;
}

/** Resize, keeping the top-left corner. New space is plains. */
export function resizeGrid(g: EditGrid, width: number, height: number): EditGrid {
  width = clampSize(width);
  height = clampSize(height);
  const out = blankGrid(width, height, g.name);
  out.id = g.id;
  out.mode = g.mode;
  for (let y = 0; y < Math.min(height, g.height); y++) {
    for (let x = 0; x < Math.min(width, g.width); x++) {
      out.terrain[y * width + x] = g.terrain[y * g.width + x];
      out.owner[y * width + x] = g.owner[y * g.width + x];
    }
  }
  out.units = g.units.filter(u => u.x < width && u.y < height).map(u => ({ ...u }));
  return out;
}

export const clampSize = (n: number) => Math.max(MIN_SIZE, Math.min(MAX_SIZE, Math.round(n) || MIN_SIZE));

export function snapshot(g: EditGrid): string {
  return JSON.stringify(g);
}

// ---------------------------------------------------------------- validation

export interface Validation {
  errors: string[];
  warnings: string[];
  /** Start slots that have an HQ — the players this map supports. */
  slots: number[];
}

export function validateGrid(g: EditGrid): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const slots: number[] = [];
  const mode = mapMode(g);
  const allSlots = MODES[mode].slots;

  // Anything owned by a slot this map type doesn't have (e.g. slot 5 on a standard map).
  const maxSlot = allSlots.length;
  if (g.owner.some(o => o > maxSlot) || g.units.some(u => u.slot > maxSlot)) {
    errors.push(`Standard maps only have players 1–${maxSlot}. Switch the map type to 3 vs 3 or remove players 5–6.`);
  }

  for (const slot of allSlots) {
    const owned = g.owner.map((o, i) => (o === slot ? i : -1)).filter(i => i >= 0);
    const hqs = owned.filter(i => g.terrain[i] === 'hq').length;
    // Any unit-producing building counts (factory, port or airfield).
    const factories = owned.filter(i => TERRAIN[g.terrain[i]].builds).length;
    const units = g.units.filter(u => u.slot === slot).length;
    if (hqs > 1) errors.push(`Player ${slot} has ${hqs} HQs — keep only one.`);
    if (hqs === 1) {
      slots.push(slot);
      if (!factories && !units) warnings.push(`Player ${slot} has no factory, port or airfield and no starting units, so they can't do anything.`);
    } else if (owned.length || units) {
      errors.push(`Player ${slot} has buildings or units but no HQ.`);
    }
  }
  // Ports need water next to them, or ships built there can never leave.
  const landlocked = g.terrain.reduce((n, t, i) => {
    if (t !== 'port') return n;
    const x = i % g.width;
    const y = Math.floor(i / g.width);
    const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < g.width && ny < g.height && g.terrain[ny * g.width + nx] === 'sea';
    });
    return wet ? n : n + 1;
  }, 0);
  if (landlocked) warnings.push(`${landlocked} port${landlocked > 1 ? 's have' : ' has'} no sea next to it — ships built there can't sail anywhere.`);

  if (mode === '3v3') {
    const missing = allSlots.filter(s => !slots.includes(s));
    if (missing.length) errors.push(`3 vs 3 maps need an HQ for all six players (missing: ${missing.map(s => `Player ${s}`).join(', ')}).`);
  } else if (slots.length < 2) {
    errors.push('Place HQs for at least 2 players.');
  }
  return { errors, warnings, slots };
}

/**
 * Which slots play, in turn order, for each supported player count.
 * Turn order goes clockwise around the map from the left edge; 2-player games
 * use the two HQs that are farthest apart.
 */
export function turnOrders(g: EditGrid, slots: number[]): Record<string, number[]> {
  // 3 vs 3 is always six players, alternating west/east.
  if (mapMode(g) === '3v3') return slots.length === 6 ? { 6: [...TURN_ORDER_3V3] } : {};
  const hq = new Map<number, { x: number; y: number }>();
  g.terrain.forEach((t, i) => {
    if (t === 'hq' && slots.includes(g.owner[i])) hq.set(g.owner[i], { x: i % g.width, y: Math.floor(i / g.width) });
  });
  const cx = (g.width - 1) / 2;
  const cy = (g.height - 1) / 2;
  // Sweep clockwise starting from due west, so top-left HQs come first.
  const angle = (s: number) => {
    const p = hq.get(s)!;
    return (Math.atan2(p.y - cy, p.x - cx) + 3 * Math.PI) % (2 * Math.PI);
  };
  const clockwise = [...slots].sort((a, b) => angle(a) - angle(b) || a - b);

  const orders: Record<string, number[]> = {};
  for (let n = 2; n <= clockwise.length; n++) {
    if (n === 2 && clockwise.length > 2) {
      let best: [number, number] = [clockwise[0], clockwise[1]];
      let bestD = -1;
      for (const a of clockwise) for (const b of clockwise) {
        if (a >= b) continue;
        const pa = hq.get(a)!;
        const pb = hq.get(b)!;
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d > bestD) { bestD = d; best = [a, b]; }
      }
      orders['2'] = clockwise.filter(s => best.includes(s));
    } else {
      orders[String(n)] = clockwise.slice(0, n);
    }
  }
  return orders;
}

/** Returns a reason the map can't be played, or null if it's fine. */
export function checkMap(m: MapDef): string | null {
  if (!m || typeof m.name !== 'string' || !Array.isArray(m.terrain) || !Array.isArray(m.owners)) return 'Not a map.';
  const h = m.terrain.length;
  const w = m.terrain[0]?.length ?? 0;
  if (h < MIN_SIZE || w < MIN_SIZE || h > MAX_SIZE || w > MAX_SIZE) return `Maps must be ${MIN_SIZE}–${MAX_SIZE} tiles on each side.`;
  if (m.terrain.some(r => typeof r !== 'string' || r.length !== w) || m.owners.length !== h) return 'Map rows are uneven.';
  const v = validateGrid(toGrid(m));
  return v.errors[0] ?? null;
}
