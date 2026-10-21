// Game state types. Everything here is plain JSON so it can be saved,
// sent over the network, or run on a server later for online play.

import type { TerrainId, UnitType } from './data';
import type { UnitSetData } from './unitSets';

export interface Pos { x: number; y: number }

export interface Tile {
  terrain: TerrainId;
  /** Owning player id, or null for neutral / non-property tiles. */
  owner: number | null;
  /** Remaining capture points (counts down while being captured). */
  capture: number;
  /** Bridges only: damage taken so far (cracked when above 0). */
  damage?: number;
}

export interface Unit {
  id: number;
  type: UnitType;
  owner: number;
  x: number;
  y: number;
  /** 0–100 internally; shown to players as 1–10. */
  hp: number;
  acted: boolean;
  /** Aircraft and ships only: remaining fuel. */
  fuel?: number;
  /** Units with limited ammo only: shots left. */
  ammo?: number;
  /** Transports only: units riding inside (not on the map while carried). */
  cargo?: Unit[];
  /** Engineers only: bridge kits left (one builds or demolishes a bridge). */
  kits?: number;
}

export interface Player {
  id: number;
  name: string;
  team: number;
  color: number;
  funds: number;
  alive: boolean;
  /** Controlled by the computer. */
  ai: boolean;
  /**
   * Player id of the human commanding this army, when one person plays
   * several armies on a team (3 vs 3). Missing = this army's own human.
   */
  controller?: number;
  difficulty: Difficulty;
  stats: PlayerStats;
  /** Commander id from commanders.json (none in older saves). */
  commander?: string;
  /** Power meter progress. */
  meter?: number;
  /** Power is active from when it's fired until this player's next turn. */
  powerActive?: boolean;
  /** Times the power has been used (each use raises the next charge needed). */
  powerUses?: number;
}

export interface PlayerStats {
  built: number;
  lost: number;
  destroyed: number;
  captured: number;
  spent: number;
  /** Total damage dealt, in % of a full-health unit (100 = one unit's worth). */
  damageDealt: number;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface GameState {
  width: number;
  height: number;
  tiles: Tile[];
  units: Unit[];
  players: Player[];
  /** Index into players of whoever's turn it is. */
  current: number;
  day: number;
  nextUnitId: number;
  /** Winning team number once the game is over. */
  winnerTeam: number | null;
  log: string[];
  mapName: string;
  /** Game mode of the map (decides e.g. building income). Missing in older saves. */
  mode?: 'standard' | '3v3';
  /** Fog of war: players only see what their team's units and buildings can see. */
  fog?: boolean;
  /** Custom unit stats and damage for this game (missing = Standard). Apply with applyUnitSet(). */
  unitSet?: UnitSetData;
}

export type Command =
  | { kind: 'wait' }
  | { kind: 'capture' }
  | { kind: 'attack'; targetId: number }
  /** Move onto a friendly transport and board it. */
  | { kind: 'load' }
  /** Transport drops carried units onto adjacent tiles. */
  | { kind: 'unload'; drops: Array<{ cargoId: number; x: number; y: number }> }
  /** Engineer standing in a river: build a bridge on that tile (uses a kit). */
  | { kind: 'bridge' }
  /** Engineer next to the bridge at (x, y): blow it up, leaving river (uses a kit). Anyone on it dies. */
  | { kind: 'demolish'; x: number; y: number }
  /** Engineer on the bank next to the cracked bridge at (x, y): fix it (uses a kit). */
  | { kind: 'repair'; x: number; y: number }
  /** Bomber, Artillery or Rockets: fire at the bridge on tile (x, y). */
  | { kind: 'strike'; x: number; y: number };

export type Action =
  | { type: 'act'; unitId: number; to: Pos; command: Command }
  | { type: 'build'; x: number; y: number; unitType: UnitType }
  /** Fire the current player's commander power (meter must be full). */
  | { type: 'power' }
  | { type: 'endTurn' };

export type GameEvent =
  | { kind: 'damage'; unitId: number; amount: number; x: number; y: number }
  | { kind: 'destroyed'; unitId: number; x: number; y: number }
  /** Fog of war: a moving unit bumped into a hidden enemy and had to stop. */
  | { kind: 'trapped'; unitId: number; x: number; y: number }
  | { kind: 'captured'; x: number; y: number; player: number }
  /** A bridge at x, y was built, cracked by gunfire, repaired, or destroyed. */
  | { kind: 'bridge'; x: number; y: number; change: 'built' | 'cracked' | 'repaired' | 'destroyed' }
  | { kind: 'eliminated'; player: number }
  | { kind: 'turn'; player: number; day: number }
  | { kind: 'power'; player: number }
  /** An aircraft ran out of fuel and crashed, or a ship ran dry and sank. */
  | { kind: 'crashed'; unitId: number; x: number; y: number }
  | { kind: 'gameover'; team: number };

export type ActionResult = { ok: true; events: GameEvent[] } | { ok: false; error: string };
