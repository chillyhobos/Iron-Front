// Maps live in src/data/maps.json as full grids:
//   terrain: one letter per tile (see "char" in terrain.json)
//            .  plains   f  forest   m  mountain   -  road   ~  sea   r  river   =  bridge
//            c  city     b  factory  h  HQ       p  port   a  airfield
//   owners:  which start slot (1–6) owns a building, "." for neutral
// slotsByPlayerCount says which slots are used for each player count (in
// turn order). Buildings of unused slots become neutral; an unused HQ
// becomes a city.
//
// mode: "standard" maps (the default) are for 2–4 player games with any
// teams. "3v3" maps are for the 3 vs 3 mode only: six slots with fixed
// teams (slots 1–3 = west, 4–6 = east), listed in "teams".

import mapsJson from '../data/maps.json';
import { CAPTURE_POINTS, fullSupplies, maxHpOf, PLAYER_COLORS, TERRAIN, UNITS, type TerrainId, type UnitType } from './data';
import type { Difficulty, GameState, Player, Tile, Unit } from './state';
import { applyUnitSet, type UnitSetData } from './unitSets';

export interface MapUnit {
  type: UnitType;
  /** Start slot (1–6) that owns this unit. */
  slot: number;
  x: number;
  y: number;
}

export type MapMode = 'standard' | '3v3';

export interface ModeDef {
  name: string;
  slots: number[];
  /** Funds per turn by building type, where this mode differs from INCOME_PER_PROPERTY. */
  income?: Partial<Record<TerrainId, number>>;
}

export const MODES: Record<MapMode, ModeDef> = {
  standard: { name: 'Standard (2–4 players)', slots: [1, 2, 3, 4] },
  // Six armies share the map's cities, so each one pays a little less.
  '3v3': { name: '3 vs 3 (6 players)', slots: [1, 2, 3, 4, 5, 6], income: { city: 800 } },
};

/** 3 vs 3: slots 1–3 are the west team, 4–6 the east team; turns alternate between teams. */
export const TEAMS_3V3: Record<string, number> = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2 };
export const TURN_ORDER_3V3 = [1, 4, 2, 5, 3, 6];

export const mapMode = (m: { mode?: MapMode }): MapMode => m.mode ?? 'standard';

export interface MapDef {
  id: string;
  name: string;
  /** Which game mode this map is for (standard if missing). */
  mode?: MapMode;
  /** Fixed teams by slot (3v3 maps). */
  teams?: Record<string, number>;
  maxPlayers: number;
  slotsByPlayerCount: Record<string, number[]>;
  terrain: string[];
  owners: string[];
  /** Units on the map at the start of the game. */
  units?: MapUnit[];
}

/** Maps that ship with the game. Custom maps are stored separately (see ui/mapStore.ts). */
export const BUILTIN_MAPS = mapsJson as unknown as MapDef[];

export interface PlayerSetup {
  name: string;
  team: number;
  ai?: boolean;
  difficulty?: Difficulty;
  /** Commander id from commanders.json. */
  commander?: string;
  /**
   * Index (into the setups list) of the human who commands this army, when one
   * person plays several armies on the same team. Omit for "their own human".
   */
  controller?: number;
}

/** Start slots used by this map for a given player count, in turn order. */
export function slotsFor(map: MapDef, playerCount: number): number[] {
  return map.slotsByPlayerCount[String(playerCount)] ?? [];
}

const CHAR_TERRAIN = Object.fromEntries(
  (Object.keys(TERRAIN) as TerrainId[]).map(id => [TERRAIN[id].char, id]),
) as Record<string, TerrainId>;

export function newStats() {
  return { built: 0, lost: 0, destroyed: 0, captured: 0, spent: 0, damageDealt: 0 };
}

export interface GameOptions {
  /** Fog of war: players only see what their team can see. */
  fog?: boolean;
  /** Custom unit set (missing = Standard). */
  unitSet?: UnitSetData;
}

/** Note: makes the game's unit set the live unit data (see applyUnitSet). */
export function createGame(mapOrId: MapDef | string, setups: PlayerSetup[], options: GameOptions = {}): GameState {
  applyUnitSet(options.unitSet);
  const map = typeof mapOrId === 'string'
    ? BUILTIN_MAPS.find(m => m.id === mapOrId) ?? BUILTIN_MAPS[0]
    : mapOrId;
  const height = map.terrain.length;
  const width = map.terrain[0].length;

  const slots = slotsFor(map, setups.length);
  if (!slots.length) throw new Error(`${map.name} doesn't support ${setups.length} players`);

  const players: Player[] = setups.map((s, i) => ({
    id: i,
    name: s.name,
    // Maps with fixed teams (3 vs 3) decide teams by start position.
    team: map.teams?.[String(slots[i])] ?? s.team,
    ...(s.controller !== undefined && s.controller !== i && !s.ai ? { controller: s.controller } : {}),
    color: PLAYER_COLORS[slots[i] - 1],
    funds: 0,
    alive: true,
    ai: !!s.ai,
    difficulty: s.difficulty ?? 'medium',
    stats: newStats(),
    commander: s.commander,
    meter: 0,
    powerActive: false,
  }));

  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let terrain = CHAR_TERRAIN[map.terrain[y][x]] ?? 'plain';
      const slot = Number(map.owners[y]?.[x]);
      let owner: number | null = null;
      if (slot && TERRAIN[terrain].property) {
        const idx = slots.indexOf(slot);
        owner = idx === -1 ? null : idx;
        if (owner === null && terrain === 'hq') terrain = 'city';
      }
      tiles.push({ terrain, owner, capture: CAPTURE_POINTS });
    }
  }

  // Starting units for the slots that are in play.
  const units: Unit[] = [];
  for (const mu of map.units ?? []) {
    const owner = slots.indexOf(mu.slot);
    if (owner === -1 || !UNITS[mu.type] || mu.x >= width || mu.y >= height) continue;
    units.push({ id: units.length + 1, type: mu.type, owner, x: mu.x, y: mu.y, hp: maxHpOf(mu.type), acted: false, ...fullSupplies(mu.type) });
  }

  return {
    width,
    height,
    tiles,
    units,
    players,
    current: 0,
    day: 1,
    nextUnitId: units.length + 1,
    winnerTeam: null,
    log: options.unitSet ? [`Playing with the custom “${options.unitSet.name}” unit set.`] : [],
    mapName: map.name,
    mode: mapMode(map),
    fog: !!options.fog,
    ...(options.unitSet ? { unitSet: options.unitSet } : {}),
  };
}
