// The rules engine. Pure logic, no graphics — the same code could run on a
// server to referee online games. All changes go through applyAction().

import {
  BLOCKED, CAPTURE_POINTS, DAMAGE, familyOf, fullSupplies, INCOME_PER_PROPERTY, MAX_HP, maxHpOf, MAX_UNITS, supplyClassOf,
  TERRAIN, UNITS, type UnitType,
} from './data';
import type { Action, ActionResult, Command, GameEvent, GameState, Pos, Tile, Unit } from './state';
import { MODES } from './maps';
import {
  bonus, canUsePower, captureBonus, commanderOf, powerCharge, revealsAll, seesIntoForests, unitCost,
} from './commanders';

export const posKey = (x: number, y: number) => `${x},${y}`;
export const displayHp = (hp: number) => Math.ceil(hp / 10);
export const dist = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export function inBounds(s: GameState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < s.width && y < s.height;
}

export function tileAt(s: GameState, x: number, y: number): Tile {
  return s.tiles[y * s.width + x];
}

export function unitAt(s: GameState, x: number, y: number): Unit | undefined {
  return s.units.find(u => u.x === x && u.y === y);
}

export function unitById(s: GameState, id: number): Unit | undefined {
  return s.units.find(u => u.id === id);
}

export function areAllies(s: GameState, a: number, b: number): boolean {
  return s.players[a].team === s.players[b].team;
}

export function currentPlayer(s: GameState) {
  return s.players[s.current];
}

/** All of a player's units, including ones riding inside transports. */
export function allUnitsOf(s: GameState, playerId: number): Unit[] {
  const out: Unit[] = [];
  for (const u of s.units) {
    if (u.owner !== playerId) continue;
    out.push(u);
    if (u.cargo) out.push(...u.cargo);
  }
  return out;
}

export function atUnitCap(s: GameState, playerId: number): boolean {
  return allUnitsOf(s, playerId).length >= MAX_UNITS;
}

/** Can `u` board this transport right now? (Same owner, right kind of unit, room left.) */
export function canBoard(transport: Unit, u: Unit): boolean {
  const t = UNITS[transport.type].transport;
  if (!t || transport.id === u.id || transport.owner !== u.owner) return false;
  if ((transport.cargo?.length ?? 0) >= t.capacity) return false;
  // A loaded transport can't itself be carried.
  if (u.cargo?.length) return false;
  return t.carries.includes(familyOf(u.type));
}

/** Units with limited ammo can't fire when empty. */
export const outOfAmmo = (u: Unit) => UNITS[u.type].ammo !== undefined && (u.ammo ?? 0) <= 0;

export const teamOf = (s: GameState, playerId: number) => s.players[playerId].team;

/** Riflemen, Bazookas and Snipers (foot soldiers); everything else is a vehicle. */
export const isInfantry = (type: UnitType) => UNITS[type].moveType === 'foot' || UNITS[type].moveType === 'boot';

// Unit stats after commander bonuses.
export const unitMove = (s: GameState, u: Unit) => Math.max(1, UNITS[u.type].move + bonus(s, u.owner, u.type, 'move'));
export const unitMaxRange = (s: GameState, u: Unit) => UNITS[u.type].maxRange + bonus(s, u.owner, u.type, 'range');
export const unitVision = (s: GameState, u: Unit) => Math.max(1, UNITS[u.type].vision + bonus(s, u.owner, u.type, 'vision'));

// ---------------------------------------------------------------- fog of war

/** Tiles in a team's sight. Null when fog is off (everything is visible). */
export type Vision = Set<number> | null;

/**
 * What a team can see: everything near its units (each unit's vision range,
 * +2 for foot soldiers on mountains) plus its own buildings. Units hidden in
 * forests are only seen from right next to them. `pretend` evaluates vision
 * as if one unit stood somewhere else (used when planning a move).
 */
export function visibleTiles(s: GameState, team: number, pretend?: { id: number; x: number; y: number }): Vision {
  if (!s.fog) return null;
  const seen = new Set<number>();
  // A teammate's map-revealing power lifts the fog for the whole team.
  if (s.players.some(p => p.team === team && p.alive && revealsAll(s, p.id))) {
    s.tiles.forEach((_, i) => seen.add(i));
    return seen;
  }
  s.tiles.forEach((t, i) => {
    if (t.owner !== null && teamOf(s, t.owner) === team) seen.add(i);
  });
  for (const u of s.units) {
    if (teamOf(s, u.owner) !== team) continue;
    const ux = pretend?.id === u.id ? pretend.x : u.x;
    const uy = pretend?.id === u.id ? pretend.y : u.y;
    const def = UNITS[u.type];
    const onFoot = def.moveType === 'foot' || def.moveType === 'boot';
    const range = unitVision(s, u) + (onFoot && tileAt(s, ux, uy).terrain === 'mountain' ? 2 : 0);
    const forestSight = seesIntoForests(s, u.owner);
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        const x = ux + dx;
        const y = uy + dy;
        if (d > range || !inBounds(s, x, y)) continue;
        if (d > 1 && !forestSight && tileAt(s, x, y).terrain === 'forest') continue;
        seen.add(y * s.width + x);
      }
    }
  }
  return seen;
}

/**
 * Can `team` see unit `u`? Own and allied units are always visible.
 * Camouflaged units (Sniper) are only seen from right next to them, from
 * inside the team's own building, or when a map-revealing power is active.
 */
export function canSee(s: GameState, vision: Vision, team: number, u: Unit): boolean {
  if (!vision || teamOf(s, u.owner) === team) return true;
  if (!vision.has(u.y * s.width + u.x)) return false;
  if (!UNITS[u.type].camouflage) return true;
  const tile = tileAt(s, u.x, u.y);
  if (tile.owner !== null && teamOf(s, tile.owner) === team) return true;
  if (s.players.some(p => p.team === team && p.alive && revealsAll(s, p.id))) return true;
  return s.units.some(o => teamOf(s, o.owner) === team && Math.abs(o.x - u.x) + Math.abs(o.y - u.y) === 1);
}

// ---------------------------------------------------------------- movement

export interface ReachInfo { cost: number; prev: string | null }
export type Reach = Map<string, ReachInfo>;

/**
 * Every tile the unit can path through this turn (Dijkstra on move points).
 * Under fog, enemies the unit's team can't see don't block planning — moving
 * into one springs an ambush (see applyAction).
 */
export function reachable(s: GameState, u: Unit): Reach {
  const def = UNITS[u.type];
  // Units with fuel can't spend more move points than they have fuel left.
  const move = u.fuel !== undefined ? Math.min(unitMove(s, u), u.fuel) : unitMove(s, u);
  const team = teamOf(s, u.owner);
  const vision = visibleTiles(s, team);
  const reach: Reach = new Map([[posKey(u.x, u.y), { cost: 0, prev: null }]]);
  const frontier: Array<{ x: number; y: number; cost: number }> = [{ x: u.x, y: u.y, cost: 0 }];

  while (frontier.length) {
    frontier.sort((a, b) => a.cost - b.cost);
    const cur = frontier.shift()!;
    if (cur.cost > (reach.get(posKey(cur.x, cur.y))?.cost ?? Infinity)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!inBounds(s, nx, ny)) continue;
      const blocker = unitAt(s, nx, ny);
      let step = TERRAIN[tileAt(s, nx, ny).terrain].cost[def.moveType];
      // A friendly transport on water (e.g. a Lander by the shore) can be boarded
      // from an adjacent tile: one step onto it, and the move ends there.
      let boardOnly = false;
      if (step >= BLOCKED) {
        if (!blocker || !canBoard(blocker, u)) continue;
        step = 1;
        boardOnly = true;
      }
      // Visible enemies block; allies (and enemies hidden in fog) can be passed.
      if (blocker && !areAllies(s, blocker.owner, u.owner) && canSee(s, vision, team, blocker)) continue;
      const cost = cur.cost + step;
      if (cost > move) continue;
      const k = posKey(nx, ny);
      const known = reach.get(k);
      if (known && known.cost <= cost) continue;
      reach.set(k, { cost, prev: posKey(cur.x, cur.y) });
      if (!boardOnly) frontier.push({ x: nx, y: ny, cost });
    }
  }
  return reach;
}

/**
 * Tiles the unit may try to stop on: no unit there that its team can see, or
 * one of its own transports with room for it (moving there means boarding).
 */
export function destinations(s: GameState, u: Unit, reach: Reach): Set<string> {
  const team = teamOf(s, u.owner);
  const vision = visibleTiles(s, team);
  const out = new Set<string>();
  for (const k of reach.keys()) {
    const [x, y] = k.split(',').map(Number);
    const other = unitAt(s, x, y);
    if (!other || other.id === u.id || !canSee(s, vision, team, other) || canBoard(other, u)) out.add(k);
  }
  return out;
}

/** The friendly transport at (x, y) that `u` would board by moving there, if any. */
export function boardingTarget(s: GameState, u: Unit, x: number, y: number): Unit | undefined {
  const other = unitAt(s, x, y);
  return other && canBoard(other, u) ? other : undefined;
}

/**
 * Tiles next to (x, y) where the transport could drop this cargo unit: on the
 * map, empty (of units the team can see), and passable for the cargo.
 */
export function dropTiles(s: GameState, transport: Unit, x: number, y: number, cargo: Unit, taken: Pos[] = []): Pos[] {
  const team = teamOf(s, transport.owner);
  const vision = visibleTiles(s, team, { id: transport.id, x, y });
  const out: Pos[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(s, nx, ny)) continue;
    if (TERRAIN[tileAt(s, nx, ny).terrain].cost[UNITS[cargo.type].moveType] >= BLOCKED) continue;
    if (taken.some(p => p.x === nx && p.y === ny)) continue;
    // (If the transport itself is standing there now, that tile is free once it moves.)
    const other = unitAt(s, nx, ny);
    if (other && other.id !== transport.id && canSee(s, vision, team, other)) continue;
    out.push({ x: nx, y: ny });
  }
  return out;
}

export function pathTo(reach: Reach, x: number, y: number): Pos[] {
  const path: Pos[] = [];
  let k: string | null = posKey(x, y);
  while (k) {
    const [px, py] = k.split(',').map(Number);
    path.unshift({ x: px, y: py });
    k = reach.get(k)?.prev ?? null;
  }
  return path;
}

/**
 * Walk a planned path. Under fog it can run into an enemy the team couldn't
 * see: the unit stops on the last free tile before it (an ambush). Returns the
 * index in `path` where the unit ends up.
 */
export function walkPath(s: GameState, u: Unit, path: Pos[]): { stop: number; trapped: boolean } {
  for (let i = 1; i < path.length; i++) {
    const occ = unitAt(s, path[i].x, path[i].y);
    if (occ && !areAllies(s, occ.owner, u.owner)) {
      let stop = i - 1;
      // Can't stop on top of an ally we were passing through — back up.
      while (stop > 0 && unitAt(s, path[stop].x, path[stop].y)) stop--;
      return { stop, trapped: true };
    }
  }
  return { stop: path.length - 1, trapped: false };
}

// ---------------------------------------------------------------- combat

/**
 * Enemy units this unit could hit from (x, y). Indirect units can't move and
 * fire. Under fog, only targets the team can see (after the move) count.
 */
export function targetsFrom(s: GameState, u: Unit, x: number, y: number, moved: boolean): Unit[] {
  const def = UNITS[u.type];
  if (moved && def.minRange > 1) return [];
  if (outOfAmmo(u)) return [];
  const maxRange = unitMaxRange(s, u);
  const team = teamOf(s, u.owner);
  const vision = visibleTiles(s, team, { id: u.id, x, y });
  return s.units.filter(v => {
    if (areAllies(s, v.owner, u.owner) || !canSee(s, vision, team, v)) return false;
    const d = Math.abs(v.x - x) + Math.abs(v.y - y);
    return d >= def.minRange && d <= maxRange && DAMAGE[u.type][v.type] > 0;
  });
}

/** Every tile this unit could attack next turn (move + fire for direct units, fixed range for indirect). */
export function threatTiles(s: GameState, u: Unit): { move: Set<string>; danger: Set<string> } {
  const def = UNITS[u.type];
  const move = destinations(s, u, reachable(s, u));
  const danger = new Set<string>();
  const origins = def.minRange > 1 ? [posKey(u.x, u.y)] : [...move];
  const maxRange = unitMaxRange(s, u);
  for (const k of origins) {
    const [ox, oy] = k.split(',').map(Number);
    for (let dy = -maxRange; dy <= maxRange; dy++) {
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < def.minRange || d > maxRange) continue;
        if (inBounds(s, ox + dx, oy + dy)) danger.add(posKey(ox + dx, oy + dy));
      }
    }
  }
  return { move, danger };
}

/**
 * Damage (0–100 scale) an attacker with attackerHp deals to a defender on its
 * tile, including both commanders' attack/defense bonuses.
 */
export function calcDamage(
  s: GameState, attacker: { type: UnitType; owner: number }, attackerHp: number, defender: Unit,
): number {
  const unit = UNITS[attacker.type];
  const terrain = tileAt(s, defender.x, defender.y).terrain;
  const atk = Math.max(0, 100 + bonus(s, attacker.owner, attacker.type, 'attack')) / 100;
  const def = 100 / Math.max(10, 100 + bonus(s, defender.owner, defender.type, 'defense'));
  // Most units hit softer as they lose HP; snipers keep a steady aim.
  const hpFactor = unit.fullDamageAtAnyHp ? 1 : displayHp(attackerHp) / 10;

  let base = DAMAGE[attacker.type][defender.type];
  const target = UNITS[defender.type];
  // Each defense star cuts 8%. Aircraft are in the air, so terrain gives them no cover;
  // Engineers out in the open only get half the benefit...
  let terrainFactor = familyOf(defender.type) === 'air' ? 1 : 1 - TERRAIN[terrain].defense * 0.08 * (target.coverFactor ?? 1);
  // ...but dug into cover (forest, mountain, buildings) they shrug off most of a hit.
  if (target.coverDamage !== undefined && target.coverTerrain?.includes(terrain)) terrainFactor = target.coverDamage;
  const precision = unit.precision;
  if (precision) {
    // Snipers ignore defense stars: only "in cover or not" matters.
    const inCover = !!unit.coverTerrain?.includes(terrain);
    base = (inCover ? precision.cover : precision.open)[defender.type] ?? base;
    terrainFactor = 1;
    // A lethal shot in the open always destroys the target, whatever its bonuses.
    if (!inCover && base >= 100) return MAX_HP;
  } else if (target.incomingDamage) {
    // Fixed damage into snipers: a full-health attacker deals exactly this much,
    // less as the attacker loses health. Stars and commander bonuses don't apply.
    const inCover = !!target.coverTerrain?.includes(terrain);
    const table = inCover ? target.incomingDamage.cover : target.incomingDamage.open;
    const fixed = table[attacker.type] ?? table[isInfantry(attacker.type) ? 'infantry' : 'vehicle'];
    // (Round away floating-point dust first: 90 × 0.7 must be 63, not 62.999.)
    if (fixed !== undefined) return Math.max(0, Math.floor(Math.round(fixed * hpFactor * 1000) / 1000));
  }
  // Round away floating-point dust first so e.g. 90 × 1 stays exactly 90.
  const dmg = Math.round(base * hpFactor * atk * def * terrainFactor * 1000) / 1000;
  return Math.max(0, Math.floor(dmg));
}

/**
 * Power meters charge from combat, measured in unit value: half of the
 * damage you take and a quarter of the damage you deal. No charging while a
 * power is on.
 */
function chargeMeters(s: GameState, attackerOwner: number, victim: Unit, amount: number) {
  const value = (amount / 100) * UNITS[victim.type].cost;
  const add = (pid: number, v: number) => {
    const p = s.players[pid];
    if (!commanderOf(s, pid) || p.powerActive) return;
    p.meter = Math.min(powerCharge(s, pid).needed, (p.meter ?? 0) + v);
  };
  add(attackerOwner, value * 0.25);
  add(victim.owner, value * 0.5);
}

function canCounter(defender: Unit, attacker: UnitType, distance: number): boolean {
  const def = UNITS[defender.type];
  return distance === 1 && def.minRange === 1 && DAMAGE[defender.type][attacker] > 0 && !outOfAmmo(defender);
}

/** Predicted outcome of an attack from `from`, used for the in-game forecast. */
export function forecast(s: GameState, attacker: Unit, from: Pos, defender: Unit) {
  const deal = Math.min(defender.hp, calcDamage(s, attacker, attacker.hp, defender));
  const defHpAfter = defender.hp - deal;
  let take = 0;
  if (defHpAfter > 0 && canCounter(defender, attacker.type, dist(from, defender))) {
    const ghost: Unit = { ...attacker, x: from.x, y: from.y };
    take = Math.min(attacker.hp, calcDamage(s, defender, defHpAfter, ghost));
  }
  return { deal, take };
}

// ---------------------------------------------------------------- capture

export function canCapture(s: GameState, u: Unit, x: number, y: number): boolean {
  const tile = tileAt(s, x, y);
  if (!UNITS[u.type].canCapture || !TERRAIN[tile.terrain].property) return false;
  return tile.owner === null || !areAllies(s, tile.owner, u.owner);
}

// ---------------------------------------------------------------- bridges

/** Engineers carry bridge kits; each build, repair or demolition uses one, refilled when they rearm. */
export const hasBridgeKit = (u: Unit) => UNITS[u.type].bridgeKits !== undefined && (u.kits ?? 0) > 0;

/** An Engineer with a kit, standing in a river at (x, y), can bridge it. */
export function canBuildBridge(s: GameState, u: Unit, x: number, y: number): boolean {
  return hasBridgeKit(u) && tileAt(s, x, y).terrain === 'river';
}

/** Our own or an ally's unit is standing on this tile (we never bring down a bridge on our own side). */
function friendlyOn(s: GameState, owner: number, x: number, y: number): boolean {
  const on = unitAt(s, x, y);
  return !!on && areAllies(s, on.owner, owner);
}

/**
 * An Engineer with a kit, standing at (fromX, fromY), can blow up any bridge right next
 * to it (its own or the enemy's) — from the bank or wading in the river beside it, never
 * from on top, since whoever is on a falling bridge dies.
 */
export function canDemolishBridge(s: GameState, u: Unit, fromX: number, fromY: number, x: number, y: number): boolean {
  return hasBridgeKit(u) && Math.abs(fromX - x) + Math.abs(fromY - y) === 1 && inBounds(s, x, y)
    && tileAt(s, x, y).terrain === 'bridge' && !friendlyOn(s, u.owner, x, y);
}

/** Bridges an Engineer standing at (x, y) could blow up. */
export function demolishTargetsFrom(s: GameState, u: Unit, x: number, y: number): Pos[] {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter(p => canDemolishBridge(s, u, x, y, p.x, p.y));
}

/**
 * An Engineer with a kit can repair a cracked bridge right next to it — but only from the
 * bank (dry land), not wading in the river and not standing on a bridge.
 */
export function canRepairBridge(s: GameState, u: Unit, fromX: number, fromY: number, x: number, y: number): boolean {
  if (!hasBridgeKit(u) || Math.abs(fromX - x) + Math.abs(fromY - y) !== 1 || !inBounds(s, x, y)) return false;
  const from = tileAt(s, fromX, fromY).terrain;
  const tile = tileAt(s, x, y);
  return from !== 'river' && from !== 'bridge' && tile.terrain === 'bridge' && (tile.damage ?? 0) > 0;
}

/** Cracked bridges an Engineer standing at (x, y) could repair. */
export function repairTargetsFrom(s: GameState, u: Unit, x: number, y: number): Pos[] {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter(p => canRepairBridge(s, u, x, y, p.x, p.y));
}

/**
 * Bridges a Bomber, Artillery or Rocket Launcher could fire at from (x, y): within its
 * normal range (indirect fire can't move first), and with none of our own or our allies'
 * units on them. Enemies on a bridge are fair game: if it collapses, they die with it.
 */
export function bridgeTargetsFrom(s: GameState, u: Unit, x: number, y: number, moved: boolean): Pos[] {
  const def = UNITS[u.type];
  if (!def.bridgeDamage || (moved && def.minRange > 1) || outOfAmmo(u)) return [];
  const maxRange = unitMaxRange(s, u);
  const out: Pos[] = [];
  for (let dy = -maxRange; dy <= maxRange; dy++) {
    for (let dx = -maxRange; dx <= maxRange; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      const tx = x + dx;
      const ty = y + dy;
      if (d < def.minRange || d > maxRange || !inBounds(s, tx, ty) || tileAt(s, tx, ty).terrain !== 'bridge') continue;
      if (friendlyOn(s, u.owner, tx, ty)) continue;
      out.push({ x: tx, y: ty });
    }
  }
  return out;
}

/**
 * A bridge falls back into river. Any ground unit on it — infantry or vehicle, at any
 * health, with whatever it carries — goes down with it. Aircraft overhead are unharmed.
 */
function collapseBridge(s: GameState, x: number, y: number, by: number): GameEvent[] {
  const tile = tileAt(s, x, y);
  tile.terrain = 'river';
  delete tile.damage;
  const events: GameEvent[] = [{ kind: 'bridge', x, y, change: 'destroyed' }];
  const on = unitAt(s, x, y);
  if (on && familyOf(on.type) !== 'air') {
    s.log.push(`${s.players[on.owner].name}'s ${UNITS[on.type].name} went down with the bridge!`);
    events.push(...destroyUnit(s, on, by));
  }
  return events;
}

// ---------------------------------------------------------------- turns

/** Funds a building pays its owner each turn (3 vs 3 cities pay 800, everything else 1,000). */
export function buildingIncome(s: GameState, tile: Tile): number {
  // Saves from before the mode was stored: 6 armies can only be a 3 vs 3 game.
  const mode = s.mode ?? (s.players.length > 4 ? '3v3' : 'standard');
  return MODES[mode].income?.[tile.terrain] ?? INCOME_PER_PROPERTY;
}

/** Total funds a player collects at the start of their turn. */
export function incomeOf(s: GameState, playerId: number): number {
  return s.tiles.reduce((sum, t) => sum + (t.owner === playerId ? buildingIncome(s, t) : 0), 0);
}

/** "a Rifleman", "an Airfield" — for log lines. */
const withArticle = (name: string) => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;

/** Called at the start of a player's turn: income, repairs, ready units. */
export function startTurn(s: GameState): GameEvent[] {
  const p = currentPlayer(s);
  if (p.powerActive) {
    p.powerActive = false; // powers last until your next turn
    s.log.push(`${p.name}'s ${commanderOf(s, p.id)?.power.name ?? 'power'} wore off.`);
  }
  const income = incomeOf(s, p.id);
  p.funds += income;

  const events: GameEvent[] = [];
  const crashed: Unit[] = [];
  const carriers = s.units.filter(o => o.owner === p.id && UNITS[o.type].resupplies);
  for (const u of s.units) {
    if (u.owner !== p.id) continue;
    u.acted = false;
    for (const c of u.cargo ?? []) c.acted = false;
    const def = UNITS[u.type];
    const tile = tileAt(s, u.x, u.y);
    // Each building serves its own kind of unit: cities/factories/HQs ground units,
    // ports ships, airfields aircraft.
    const atDepot = tile.owner === p.id && !!TERRAIN[tile.terrain].supplies?.includes(supplyClassOf(u.type));
    const nearCarrier = carriers.some(c => c.id !== u.id && Math.abs(c.x - u.x) + Math.abs(c.y - u.y) === 1);

    // Aircraft and ships burn fuel every day (ground vehicles only burn it moving)...
    if (u.fuel !== undefined) u.fuel = Math.max(0, u.fuel - (def.fuelPerDay ?? 0));
    // ...and refuel/rearm at their own depot or next to a friendly APC.
    // Engineers can pick up a new bridge kit at any building they own.
    const kitDepot = def.bridgeKits !== undefined && tile.owner === p.id;
    if (atDepot || nearCarrier || kitDepot) Object.assign(u, fullSupplies(u.type));
    // Out of fuel, aircraft crash and ships sink; a ground vehicle just can't move.
    if (u.fuel !== undefined && u.fuel <= 0 && (familyOf(u.type) === 'air' || familyOf(u.type) === 'naval')) {
      crashed.push(u);
      continue;
    }
    const maxHp = maxHpOf(u.type);
    if (atDepot && u.hp < maxHp) {
      // Repair up to 2 HP, paying the same share of the unit's price as the share of health restored.
      const heal = Math.min(20, maxHp - u.hp);
      const price = Math.ceil((unitCost(s, p.id, u.type) * heal) / maxHp);
      if (p.funds >= price) {
        p.funds -= price;
        u.hp += heal;
      }
    }
  }
  s.log.push(`Day ${s.day}: ${p.name}'s turn (+${income} funds).`);
  events.push({ kind: 'turn', player: p.id, day: s.day });

  // Out of fuel: aircraft crash, ships sink (cargo is lost with them).
  for (const u of crashed) {
    s.log.push(`${p.name}'s ${UNITS[u.type].name} ran out of fuel and was lost!`);
    events.push(...removeUnit(s, u, null));
    events.push({ kind: 'crashed', unitId: u.id, x: u.x, y: u.y });
  }
  return events;
}

function advanceTurn(s: GameState): GameEvent[] {
  if (s.winnerTeam !== null) return [];
  let next = s.current;
  do {
    next = (next + 1) % s.players.length;
    if (next === 0) s.day++;
  } while (!s.players[next].alive);
  s.current = next;
  const events = startTurn(s);
  // Everything they had crashed or sank at the start of their turn: move on.
  if (!s.players[s.current].alive && s.winnerTeam === null) events.push(...advanceTurn(s));
  return events;
}

function eliminate(s: GameState, playerId: number, capturedBy: number | null): GameEvent[] {
  const p = s.players[playerId];
  if (!p.alive) return [];
  p.alive = false;
  s.units = s.units.filter(u => u.owner !== playerId);
  for (const t of s.tiles) {
    if (t.owner !== playerId) continue;
    if (t.terrain === 'hq') t.terrain = 'city';
    t.owner = capturedBy;
    t.capture = CAPTURE_POINTS;
  }
  s.log.push(`${p.name} has been defeated!`);
  const events: GameEvent[] = [{ kind: 'eliminated', player: playerId }];

  const teams = new Set(s.players.filter(pl => pl.alive).map(pl => pl.team));
  if (teams.size === 1) {
    s.winnerTeam = [...teams][0];
    s.log.push(`Team ${s.winnerTeam} wins!`);
    events.push({ kind: 'gameover', team: s.winnerTeam });
  }
  return events;
}

function destroyUnit(s: GameState, u: Unit, killer: number): GameEvent[] {
  return [{ kind: 'destroyed', unitId: u.id, x: u.x, y: u.y }, ...removeUnit(s, u, killer)];
}

/**
 * Take a unit (and anything it carries) off the map. `killer` gets the credit,
 * or null for fuel losses. A player with no units left anywhere is defeated.
 */
function removeUnit(s: GameState, u: Unit, killer: number | null): GameEvent[] {
  s.units = s.units.filter(v => v.id !== u.id);
  const lost = 1 + (u.cargo?.length ?? 0);
  s.players[u.owner].stats.lost += lost;
  if (killer !== null) s.players[killer].stats.destroyed += lost;
  tileAt(s, u.x, u.y).capture = CAPTURE_POINTS;
  if (allUnitsOf(s, u.owner).length === 0) return eliminate(s, u.owner, null);
  return [];
}

// ---------------------------------------------------------------- actions

export function applyAction(s: GameState, a: Action): ActionResult {
  if (s.winnerTeam !== null) return { ok: false, error: 'The game is over.' };
  const me = currentPlayer(s);

  if (a.type === 'endTurn') {
    return { ok: true, events: advanceTurn(s) };
  }

  if (a.type === 'power') {
    const c = commanderOf(s, me.id);
    if (!c) return { ok: false, error: 'You have no commander.' };
    if (!canUsePower(s, me.id)) return { ok: false, error: me.powerActive ? 'Power is already active.' : 'Power meter is not full.' };
    me.powerActive = true;
    me.meter = 0;
    me.powerUses = (me.powerUses ?? 0) + 1;
    if (c.power.heal) {
      for (const u of s.units) if (u.owner === me.id) u.hp = Math.min(maxHpOf(u.type), u.hp + c.power.heal);
    }
    s.log.push(`⚡ ${me.name} used ${c.power.name}!`);
    return { ok: true, events: [{ kind: 'power', player: me.id }] };
  }

  if (a.type === 'build') {
    if (!inBounds(s, a.x, a.y)) return { ok: false, error: 'Out of bounds.' };
    const tile = tileAt(s, a.x, a.y);
    const builds = TERRAIN[tile.terrain].builds;
    if (!builds || tile.owner !== me.id) return { ok: false, error: 'Not your factory, port or airfield.' };
    if (unitAt(s, a.x, a.y)) return { ok: false, error: 'That building is occupied.' };
    const def = UNITS[a.unitType];
    if (!def) return { ok: false, error: 'Unknown unit.' };
    if (supplyClassOf(a.unitType) !== builds) {
      return { ok: false, error: `A ${TERRAIN[tile.terrain].name} can't build a ${def.name}.` };
    }
    const cost = unitCost(s, me.id, a.unitType);
    if (me.funds < cost) return { ok: false, error: 'Not enough funds.' };
    if (atUnitCap(s, me.id)) return { ok: false, error: `Unit limit reached (${MAX_UNITS}).` };
    me.funds -= cost;
    me.stats.built++;
    me.stats.spent += cost;
    s.units.push({
      id: s.nextUnitId++, type: a.unitType, owner: me.id, x: a.x, y: a.y, hp: maxHpOf(a.unitType), acted: true, ...fullSupplies(a.unitType),
    });
    // Under fog, opponents only learn that something was built, not what.
    s.log.push(s.fog ? `${me.name} deployed a unit.` : `${me.name} built ${withArticle(def.name)}.`);
    return { ok: true, events: [] };
  }

  // a.type === 'act'
  const u = unitById(s, a.unitId);
  if (!u || u.owner !== me.id) return { ok: false, error: 'Not your unit.' };
  if (u.acted) return { ok: false, error: 'Unit has already acted.' };
  const reach = reachable(s, u);
  if (!destinations(s, u, reach).has(posKey(a.to.x, a.to.y))) return { ok: false, error: 'Unit cannot move there.' };

  const moved = a.to.x !== u.x || a.to.y !== u.y;
  const err = validateCommand(s, u, a.to, moved, a.command);
  if (err) return { ok: false, error: err };

  const path = pathTo(reach, a.to.x, a.to.y);
  const { stop, trapped } = walkPath(s, u, path);
  const dest = path[stop];
  // Resolve the transport before moving (afterwards it shares the tile with us).
  const transport = a.command.kind === 'load' ? boardingTarget(s, u, a.to.x, a.to.y) : undefined;

  if (dest.x !== u.x || dest.y !== u.y) {
    tileAt(s, u.x, u.y).capture = CAPTURE_POINTS; // leaving a tile abandons its capture
    u.x = dest.x;
    u.y = dest.y;
  }
  // Fuel burns at the movement cost of the route taken (1 per tile for aircraft and
  // ships; a tank crossing a forest uses 2). An ambush stops it, and the spending, early.
  if (u.fuel !== undefined) u.fuel = Math.max(0, u.fuel - (reach.get(posKey(dest.x, dest.y))?.cost ?? stop));
  u.acted = true;
  const events: GameEvent[] = [];

  if (trapped) {
    s.log.push(`Ambush! ${me.name}'s ${UNITS[u.type].name} ran into a hidden enemy.`);
    events.push({ kind: 'trapped', unitId: u.id, x: u.x, y: u.y });
    return { ok: true, events };
  }

  if (a.command.kind === 'load' && transport) {
    // Board: the unit leaves the map and rides inside the transport.
    s.units = s.units.filter(v => v.id !== u.id);
    transport.cargo = [...(transport.cargo ?? []), u];
    if (!s.fog) s.log.push(`${me.name}'s ${UNITS[u.type].name} boarded ${withArticle(UNITS[transport.type].name)}.`);
  }

  if (a.command.kind === 'unload') {
    for (const drop of a.command.drops) {
      const cargo = u.cargo?.find(c => c.id === drop.cargoId);
      if (!cargo) continue;
      if (unitAt(s, drop.x, drop.y)) {
        // A hidden enemy is standing there (fog): that unit stays aboard.
        s.log.push(`${UNITS[cargo.type].name} couldn't land: the spot is blocked.`);
        events.push({ kind: 'trapped', unitId: cargo.id, x: drop.x, y: drop.y });
        continue;
      }
      u.cargo = u.cargo!.filter(c => c.id !== cargo.id);
      Object.assign(cargo, { x: drop.x, y: drop.y, acted: true });
      s.units.push(cargo);
      if (!s.fog) s.log.push(`${me.name}'s ${UNITS[u.type].name} dropped off ${withArticle(UNITS[cargo.type].name)}.`);
    }
    if (u.cargo && !u.cargo.length) delete u.cargo;
  }

  if (a.command.kind === 'capture') {
    const tile = tileAt(s, u.x, u.y);
    tile.capture -= Math.floor((displayHp(u.hp) * (100 + captureBonus(s, me.id))) / 100);
    if (tile.capture <= 0) {
      const prevOwner = tile.owner;
      const wasHq = tile.terrain === 'hq';
      tile.owner = me.id;
      tile.capture = CAPTURE_POINTS;
      me.stats.captured++;
      s.log.push(`${me.name} captured ${withArticle(TERRAIN[tile.terrain].name)}.`);
      events.push({ kind: 'captured', x: u.x, y: u.y, player: me.id });
      if (wasHq && prevOwner !== null) {
        tile.terrain = 'city';
        events.push(...eliminate(s, prevOwner, me.id));
      }
    }
  }

  // Everyone sees bridges change, but under fog not who did it.
  const bridgeLog = (what: string) => s.log.push(s.fog ? `Someone ${what}.` : `${me.name}'s ${UNITS[u.type].name} ${what}.`);
  if (a.command.kind === 'bridge' || a.command.kind === 'demolish' || a.command.kind === 'repair') {
    u.kits = (u.kits ?? 0) - 1;
    if (a.command.kind === 'bridge') {
      tileAt(s, u.x, u.y).terrain = 'bridge';
      bridgeLog('built a bridge');
      events.push({ kind: 'bridge', x: u.x, y: u.y, change: 'built' });
    } else if (a.command.kind === 'repair') {
      const { x, y } = a.command;
      delete tileAt(s, x, y).damage;
      bridgeLog('repaired a bridge');
      events.push({ kind: 'bridge', x, y, change: 'repaired' });
    } else if (a.command.kind === 'demolish') {
      bridgeLog('blew up a bridge');
      events.push(...collapseBridge(s, a.command.x, a.command.y, me.id));
    }
  }

  if (a.command.kind === 'strike') {
    const { x, y } = a.command;
    const tile = tileAt(s, x, y);
    if (u.ammo !== undefined) u.ammo--;
    tile.damage = (tile.damage ?? 0) + (UNITS[u.type].bridgeDamage ?? 0);
    if (tile.damage >= (TERRAIN.bridge.durability ?? 1)) {
      bridgeLog('destroyed a bridge');
      events.push(...collapseBridge(s, x, y, me.id));
    } else {
      bridgeLog('cracked a bridge');
      events.push({ kind: 'bridge', x, y, change: 'cracked' });
    }
  }

  if (a.command.kind === 'attack') {
    const target = unitById(s, a.command.targetId)!;
    const deal = Math.min(target.hp, calcDamage(s, u, u.hp, target));
    if (u.ammo !== undefined) u.ammo--;
    target.hp -= deal;
    me.stats.damageDealt += deal;
    chargeMeters(s, me.id, target, deal);
    events.push({ kind: 'damage', unitId: target.id, amount: deal, x: target.x, y: target.y });
    s.log.push(`${UNITS[u.type].name} hit ${UNITS[target.type].name} for ${deal}%.`);
    if (target.hp <= 0) {
      events.push(...destroyUnit(s, target, me.id));
    } else if (canCounter(target, u.type, dist(u, target))) {
      const back = Math.min(u.hp, calcDamage(s, target, target.hp, u));
      if (target.ammo !== undefined) target.ammo--;
      u.hp -= back;
      s.players[target.owner].stats.damageDealt += back;
      chargeMeters(s, target.owner, u, back);
      events.push({ kind: 'damage', unitId: u.id, amount: back, x: u.x, y: u.y });
      if (u.hp <= 0) events.push(...destroyUnit(s, u, target.owner));
    }
  }

  // If the current player lost their last unit (e.g. to a counterattack), pass the turn.
  if (!me.alive && s.winnerTeam === null) events.push(...advanceTurn(s));
  return { ok: true, events };
}

function validateCommand(s: GameState, u: Unit, to: Pos, moved: boolean, c: Command): string | null {
  // Moving onto your own transport only works as boarding.
  const transport = boardingTarget(s, u, to.x, to.y);
  if (c.kind === 'load') return transport ? null : 'There is no transport with room there.';
  if (transport) return 'That tile has a transport on it: choose Load to board it.';
  if (c.kind === 'wait') return null;
  if (c.kind === 'capture') return canCapture(s, u, to.x, to.y) ? null : 'Cannot capture here.';
  if (c.kind === 'bridge') return canBuildBridge(s, u, to.x, to.y) ? null : 'An Engineer with a bridge kit must stand in a river to build a bridge.';
  if (c.kind === 'demolish') {
    return canDemolishBridge(s, u, to.x, to.y, c.x, c.y)
      ? null : 'An Engineer with a bridge kit can blow up a bridge right next to it, unless your own or an ally\'s unit is on it.';
  }
  if (c.kind === 'repair') {
    return canRepairBridge(s, u, to.x, to.y, c.x, c.y)
      ? null : 'An Engineer with a bridge kit can repair a cracked bridge next to it, from the bank (not from the river).';
  }
  if (c.kind === 'strike') {
    return bridgeTargetsFrom(s, u, to.x, to.y, moved).some(p => p.x === c.x && p.y === c.y)
      ? null : 'Only Bombers, Artillery and Rocket Launchers can hit a bridge, and it must be in range with nobody you can see on it.';
  }
  if (c.kind === 'unload') {
    if (!u.cargo?.length) return 'Nothing to unload.';
    if (!c.drops.length) return 'Choose where to unload.';
    const taken: Pos[] = [];
    for (const d of c.drops) {
      const cargo = u.cargo.find(x => x.id === d.cargoId);
      if (!cargo) return 'That unit is not aboard.';
      if (c.drops.filter(o => o.cargoId === d.cargoId).length > 1) return 'Each unit can only be unloaded once.';
      if (!dropTiles(s, u, to.x, to.y, cargo, taken).some(p => p.x === d.x && p.y === d.y)) {
        return `${UNITS[cargo.type].name} can't be unloaded there.`;
      }
      taken.push({ x: d.x, y: d.y });
    }
    return null;
  }
  const ghost: Unit = { ...u, x: to.x, y: to.y };
  const ok = targetsFrom(s, ghost, to.x, to.y, moved).some(t => t.id === c.targetId);
  return ok ? null : 'Target is not in range.';
}
