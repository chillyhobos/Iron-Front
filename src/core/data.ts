// Static game data. The numbers live in src/data/*.json so they can be
// tweaked (and later edited in-game) without touching code; this file just
// gives them types.

import terrainJson from '../data/terrain.json';
import unitsJson from '../data/units.json';
import damageJson from '../data/damage.json';

export type TerrainId = Exclude<keyof typeof terrainJson, '_help'>;
export type MoveType = 'foot' | 'boot' | 'treads' | 'tires' | 'air' | 'ship';
/** Unit families: who repairs/resupplies where, which building builds them, what transports carry. */
export type UnitFamily = 'infantry' | 'vehicle' | 'air' | 'naval';
/** Families as buildings see them: ground = infantry + vehicles. */
export type SupplyClass = 'ground' | 'air' | 'naval';
export type UnitType = keyof typeof unitsJson;

/** Movement cost meaning "cannot enter". */
export const BLOCKED = 99;

export interface TerrainDef {
  name: string;
  /** Letter used for this terrain in maps.json. */
  char: string;
  /** Defense stars: each star cuts incoming damage by 8%. */
  defense: number;
  cost: Record<MoveType, number>;
  property: boolean;
  /** Unit classes that repair and refuel/rearm here at the start of the owner's turn. */
  supplies?: SupplyClass[];
  /** Building that produces units of this class (factory: ground, port: naval, airfield: air). */
  builds?: SupplyClass;
  /** Bridges: damage they take before collapsing back into river. */
  durability?: number;
}

export interface UnitDef {
  name: string;
  /** Short label drawn on the placeholder sprite. */
  label: string;
  cost: number;
  move: number;
  /** How many tiles away this unit can see under fog of war. */
  vision: number;
  moveType: MoveType;
  minRange: number;
  maxRange: number;
  canCapture: boolean;
  /** Tiles that count as cover for `precision` and `incomingDamage` (Sniper) and `coverDamage` (Engineer). */
  coverTerrain?: TerrainId[];
  /**
   * Dug in (Engineer): on `coverTerrain`, damage taken is multiplied by this instead of
   * terrain stars (0.3 = takes 30%). Out of cover, the usual stars (and `coverFactor`) apply.
   */
  coverDamage?: number;
  /**
   * Precision fire (Sniper): terrain defense stars don't apply. Damage comes from
   * `cover` when the target stands on `coverTerrain`, otherwise from `open`.
   * An `open` value of 100 or more always destroys the target.
   */
  precision?: {
    open: Partial<Record<UnitType, number>>;
    cover: Partial<Record<UnitType, number>>;
  };
  /**
   * Fixed damage this unit TAKES (Sniper), by attacker unit id or group
   * ("infantry" / "vehicle"), in the open or in cover. It scales with the
   * attacker's health, but terrain stars and commander bonuses don't change it.
   */
  incomingDamage?: {
    open: Partial<Record<string, number>>;
    cover: Partial<Record<string, number>>;
  };
  /** Under fog of war, enemies only see this unit from an adjacent tile. */
  camouflage?: boolean;
  /** Deals full damage no matter how damaged it is (most units weaken as they lose HP). */
  fullDamageAtAnyHp?: boolean;
  /** Aircraft and ships: fuel tank size. Moving uses 1 fuel per tile; empty = crash/sink. */
  fuel?: number;
  /** Fuel burned at the start of each of the owner's turns. */
  fuelPerDay?: number;
  /** Shots before needing to rearm (aircraft and ships with weapons). */
  ammo?: number;
  /** Can carry other units. */
  transport?: { capacity: number; carries: UnitFamily[] };
  /** Refuels and rearms adjacent friendly units at the start of each turn (APC). */
  resupplies?: boolean;
  /** Full health if not the usual 100 (Engineer: 50, so it also hits half as hard). */
  maxHp?: number;
  /** Share of terrain defense stars this unit benefits from (Engineer: 0.5). Default 1. */
  coverFactor?: number;
  /** Engineer: bridge kits carried. Building, repairing or demolishing a bridge uses one; rearm to refill. */
  bridgeKits?: number;
  /** Can fire at bridges (Bomber 2, Artillery/Rockets 1): damage per hit, against the bridge's durability. */
  bridgeDamage?: number;
}

const { _help: _terrainHelp, ...terrainOnly } = terrainJson;
const { _help: _damageHelp, ...damageOnly } = damageJson;

export const TERRAIN = terrainOnly as Record<TerrainId, TerrainDef>;
export const UNITS = unitsJson as unknown as Record<UnitType, UnitDef>;
/** Base damage (% of a full-health target) that a full-health attacker deals. 0 = cannot attack. */
export const DAMAGE = damageOnly as Record<UnitType, Record<UnitType, number>>;

export const UNIT_ORDER = Object.keys(UNITS) as UnitType[];

/** Which family a unit type belongs to. */
export function familyOf(type: UnitType): UnitFamily {
  const m = UNITS[type].moveType;
  if (m === 'air') return 'air';
  if (m === 'ship') return 'naval';
  return m === 'foot' || m === 'boot' ? 'infantry' : 'vehicle';
}

/** Full fuel, ammo and bridge kits for a newly built unit (only for unit types that use them). */
export function fullSupplies(type: UnitType): { fuel?: number; ammo?: number; kits?: number } {
  const d = UNITS[type];
  return {
    ...(d.fuel !== undefined ? { fuel: d.fuel } : {}),
    ...(d.ammo !== undefined ? { ammo: d.ammo } : {}),
    ...(d.bridgeKits !== undefined ? { kits: d.bridgeKits } : {}),
  };
}

/** A unit type's full health (100 for everything except the Engineer). */
export const maxHpOf = (type: UnitType) => UNITS[type].maxHp ?? MAX_HP;

/** Supply class used by buildings: infantry and vehicles are both "ground". */
export const supplyClassOf = (type: UnitType): SupplyClass => {
  const f = familyOf(type);
  return f === 'infantry' || f === 'vehicle' ? 'ground' : f;
};

export const INCOME_PER_PROPERTY = 1000;
export const CAPTURE_POINTS = 20;
export const MAX_HP = 100;
/** Most units one player may have on the map at once. */
export const MAX_UNITS = 50;

/** Colors by start slot (1–6 → index 0–5). Slots 5–6 only appear on 3 vs 3 maps. */
export const PLAYER_COLORS = [0xd94848, 0x3c6fd8, 0x3fa34d, 0xd9a520, 0x9b59d0, 0x2bb3a8];
export const PLAYER_COLOR_NAMES = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Teal'];
export const DEFAULT_FACTIONS = ['Crimson Legion', 'Azure Front', 'Verdant Corps', 'Amber Guard', 'Violet Order', 'Teal Vanguard'];
