// Commanders: data from src/data/commanders.json plus the helpers the rules
// use to apply a player's passive and (when active) power bonuses.

import commandersJson from '../data/commanders.json';
import { familyOf, UNITS, type UnitType } from './data';
import type { GameState } from './state';

/** Group bonuses: { all: 10, tank: 20, scout: 1, ... } — see the _help text in commanders.json. */
export type GroupBonus = Partial<Record<string, number>>;

export interface Mods {
  attack?: GroupBonus;
  defense?: GroupBonus;
  move?: GroupBonus;
  range?: GroupBonus;
  vision?: GroupBonus;
  cost?: GroupBonus;
  /** % faster capturing. */
  capture?: number;
  seeForests?: boolean;
  /** Under fog, the whole map is visible to this player's team. */
  revealAll?: boolean;
}

export interface CommanderDef {
  name: string;
  style: string;
  passive: Mods & { description: string };
  power: Mods & {
    name: string;
    description: string;
    /** Meter needed to fire the power. */
    charge: number;
    /** HP (0–100 scale) restored to every unit when fired. */
    heal?: number;
  };
}

const { _help: _commanderHelp, ...commandersOnly } = commandersJson;
export const COMMANDERS = commandersOnly as unknown as Record<string, CommanderDef>;
export const COMMANDER_IDS = Object.keys(COMMANDERS);

export const commanderOf = (s: GameState, playerId: number): CommanderDef | undefined => {
  const id = s.players[playerId]?.commander;
  return id ? COMMANDERS[id] : undefined;
};

/** Every group a unit type belongs to. */
export function groupsOf(type: UnitType): string[] {
  const def = UNITS[type];
  // Family: infantry, vehicle (ground vehicles only), air or naval.
  const groups = ['all', type, familyOf(type), def.minRange > 1 ? 'indirect' : 'direct'];
  if (type === 'ltank' || type === 'htank') groups.push('tank');
  return groups;
}

function activeMods(s: GameState, playerId: number): Mods[] {
  const c = commanderOf(s, playerId);
  if (!c) return [];
  return s.players[playerId].powerActive ? [c.passive, c.power] : [c.passive];
}

type Stat = 'attack' | 'defense' | 'move' | 'range' | 'vision' | 'cost';

/** Total bonus from a player's commander for one stat of one unit type. */
export function bonus(s: GameState, playerId: number, type: UnitType, stat: Stat): number {
  const groups = groupsOf(type);
  let total = 0;
  for (const m of activeMods(s, playerId)) {
    const table = m[stat];
    if (!table) continue;
    for (const g of groups) total += table[g] ?? 0;
  }
  return total;
}

export function captureBonus(s: GameState, playerId: number): number {
  return activeMods(s, playerId).reduce((sum, m) => sum + (m.capture ?? 0), 0);
}

export function seesIntoForests(s: GameState, playerId: number): boolean {
  return activeMods(s, playerId).some(m => m.seeForests);
}

export function revealsAll(s: GameState, playerId: number): boolean {
  return activeMods(s, playerId).some(m => m.revealAll);
}

/** Price of a unit for this player (commander discounts included). */
export function unitCost(s: GameState, playerId: number, type: UnitType): number {
  return Math.round((UNITS[type].cost * (100 + bonus(s, playerId, type, 'cost'))) / 100);
}

/** Each use makes the next one cost this much more (20%), so powers stay special in long games. */
const CHARGE_GROWTH = 0.2;

export function powerCharge(s: GameState, playerId: number): { meter: number; needed: number } {
  const c = commanderOf(s, playerId);
  const p = s.players[playerId];
  const needed = c ? Math.round(c.power.charge * (1 + CHARGE_GROWTH * (p.powerUses ?? 0))) : Infinity;
  return { meter: p.meter ?? 0, needed };
}

export function canUsePower(s: GameState, playerId: number): boolean {
  const p = s.players[playerId];
  const { meter, needed } = powerCharge(s, playerId);
  return !!commanderOf(s, playerId) && !p.powerActive && meter >= needed;
}
