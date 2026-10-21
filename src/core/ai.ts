// Computer opponent. Pure logic like rules.ts: it looks at the state and
// returns the single best next Action. Call it repeatedly until it returns
// { type: 'endTurn' }.
//
// Strategy (greedy, scored in "funds" so everything is comparable):
//   1. For every ready unit, try every tile it can stop on and every order
//      there (attack / capture / wait), score each, and play the best one.
//   2. When no units are left to move, spend money at free factories.

import {
  BLOCKED, CAPTURE_POINTS, DAMAGE, familyOf, MAX_UNITS, maxHpOf, supplyClassOf, TERRAIN, UNIT_ORDER, UNITS,
  type MoveType, type SupplyClass, type UnitType,
} from './data';
import {
  allUnitsOf, areAllies, atUnitCap, boardingTarget, bridgeTargetsFrom, canBoard, canBuildBridge, canCapture, demolishTargetsFrom,
  currentPlayer, destinations, repairTargetsFrom,
  displayHp, dropTiles, hasBridgeKit,
  forecast, outOfAmmo, posKey, reachable, targetsFrom, teamOf, threatTiles, tileAt, unitAt, unitMaxRange, visibleTiles, canSee,
} from './rules';
import type { Action, Difficulty, GameState, Pos, Unit } from './state';
import { bonus, canUsePower, captureBonus, unitCost } from './commanders';

// ---------------------------------------------------------------- difficulty profiles
// Tuning knobs per difficulty — raise/lower to change each AI's personality.

interface Profile {
  /** Value of being one move-point closer to a goal. */
  step: number;
  /** How much the AI fears tiles enemies can hit next turn. */
  risk: number;
  /** Value per defense star on the end tile. */
  cover: number;
  /** Random +/- added to every score: bigger = sloppier, less predictable play. */
  noise: number;
  /** How much the AI cares about the counterattack it will take (1 = fully). */
  counterCare: number;
  /** Bonus (fraction of the target's price) for finishing a unit off. */
  killBonus: number;
  /** Rush to attack enemies that are capturing our buildings. */
  defendCaptures: boolean;
  /** Pull badly damaged units back to repair. */
  retreat: boolean;
  /** Pick units that counter the enemy army (otherwise buys at random). */
  counterPick: boolean;
  /** Get bolder when its army clearly outclasses every opponent. */
  pressAdvantage: boolean;
  /** When counter-picking, how much cheaper units are favoured (1 = per fund, 0 = ignore price). */
  thrift: number;
  /** Split funds across all free factories instead of buying greedily at the first one. */
  budgetBuild: boolean;
  /** When ahead, send combat units at enemy buildings/HQ to close the game out. */
  siege: boolean;
}

export const PROFILES: Record<Difficulty, Profile> = {
  easy: {
    step: 90, risk: 0.1, cover: 0, noise: 2500, counterCare: 0.3, killBonus: 0,
    defendCaptures: false, retreat: false, counterPick: false, pressAdvantage: false, thrift: 1,
    budgetBuild: false, siege: false,
  },
  medium: {
    step: 110, risk: 0.3, cover: 30, noise: 1000, counterCare: 0.7, killBonus: 0.2,
    defendCaptures: true, retreat: false, counterPick: true, pressAdvantage: true, thrift: 1,
    budgetBuild: false, siege: true,
  },
  hard: {
    step: 140, risk: 0.4, cover: 60, noise: 0, counterCare: 1.1, killBonus: 0.5,
    defendCaptures: true, retreat: true, counterPick: true, pressAdvantage: true, thrift: 0.6,
    budgetBuild: false, siege: true,
  },
};

const FACTORY_BLOCK = 800;     // penalty for parking on your own free factory
const WOUNDED_HP = 30;         // at or below this, units retreat to repair
const BRIDGE_GAIN = 8;         // move points a bridge must save our vehicles before an Engineer builds it
const PUSH_DAY = 30;           // from this day on, CPUs stop holding lines and go for the enemy's buildings
const PUSH_DAY_BIG = 20;       // ...or this day in big team games (5–6 armies on big maps take longer to cross)

/**
 * pickup: our transports with room (for riders); riders: our units waiting for a lift (for transports);
 * bridge / demolish: river tiles worth bridging and bridges worth blowing up (for Engineers);
 * supply: buildings and APCs that refuel this unit; needy: our vehicles low on fuel or ammo (for APCs);
 * hq: enemy HQs (capturers finishing a game).
 */
type Goal = 'capture' | 'enemy' | 'home' | 'siege' | 'pickup' | 'riders' | 'bridge' | 'demolish' | 'repair' | 'supply' | 'needy' | 'hq';
type RideWish = 'stranded' | 'far' | null;

interface Scored { score: number; action: Action }
/** Tile indexes: river to bridge (with the move points saved), bridges to destroy, cracked bridges to fix, bridges we use. */
interface BridgePlan { build: Map<number, number>; demolish: Set<number>; repair: Set<number>; keep: Set<number> }

export function nextAiAction(s: GameState, rng: () => number = Math.random): Action {
  const me = currentPlayer(s);
  // Fire the commander power as soon as it's charged, before moving anything.
  if (canUsePower(s, me.id)) return { type: 'power' };
  const ctx = new Context(s, me.id, PROFILES[me.difficulty] ?? PROFILES.medium, rng);

  let best: Scored | null = null;
  // Units parked on our own factories/ports/airfields move first, so those tiles
  // free up for building and for aircraft/ships that need to land and refuel.
  // (Transports are skipped here: they may be waiting at a port for passengers to board.)
  const parked = s.units.filter(u => u.owner === me.id && !u.acted && onOwnDepot(s, u) && !UNITS[u.type].transport);
  for (const u of parked) {
    const c = bestOrderFor(s, u, ctx);
    const a = c.action;
    if (a.type === 'act' && (a.to.x !== u.x || a.to.y !== u.y)) return a;
  }

  for (const u of s.units) {
    if (u.owner !== me.id || u.acted) continue;
    const c = bestOrderFor(s, u, ctx);
    if (!best || c.score > best.score) best = c;
  }
  if (best) return best.action;

  return chooseBuild(s, me.id, ctx) ?? { type: 'endTurn' };
}

/** The current player's bridge plan, as tile positions (for tests and debugging). */
export function bridgePlanOf(s: GameState): { build: Pos[]; demolish: Pos[] } {
  const me = currentPlayer(s);
  const plan = new Context(s, me.id, PROFILES[me.difficulty] ?? PROFILES.medium, () => 0.5).bridgePlan();
  const at = (i: number) => ({ x: i % s.width, y: Math.floor(i / s.width) });
  return { build: [...plan.build.keys()].map(at), demolish: [...plan.demolish].map(at) };
}

// ---------------------------------------------------------------- unit orders

interface Intent {
  goal: Goal;
  wounded: boolean;
  needsSupply: boolean;
}

/** What a unit is trying to do this turn: its goal, and whether it must retreat or resupply. */
function intentOf(s: GameState, u: Unit, ctx: Context): Intent {
  const p = ctx.profile;
  const def = UNITS[u.type];
  // (No limping home for repairs while pushing to finish a game: every unit counts at the front.)
  const wounded = p.retreat && u.hp <= WOUNDED_HP && !ctx.pushing;
  const at = u.y * s.width + u.x;
  const ground = supplyClassOf(u.type) === 'ground';
  let lowFuel = false;
  if (u.fuel !== undefined && !ground) {
    // Aircraft and ships head home to refuel/rearm before they run dry (every CPU
    // level does this: crashing isn't a "difficulty" choice). Leave a generous margin:
    // the airfield/port may be busy with another unit refuelling.
    const homeDist = ctx.field(def.moveType, 'home', u.type)[at];
    lowFuel = Number.isFinite(homeDist) && u.fuel <= homeDist + (def.fuelPerDay ?? 0) * 4 + 10;
  } else if (u.fuel !== undefined) {
    // A ground vehicle that runs dry is stuck, not lost: refuel (at a building or next to
    // an APC) once the tank won't cover the trip there plus a turn of driving.
    const supplyDist = ctx.field(def.moveType, def.resupplies ? 'home' : 'supply', u.type)[at];
    lowFuel = Number.isFinite(supplyDist) && u.fuel <= supplyDist + def.move;
  }
  const engineer = def.bridgeKits !== undefined;
  const needsSupply = outOfAmmo(u) || (engineer && !hasBridgeKit(u)) || lowFuel;
  const unarmed = UNIT_ORDER.every(t => DAMAGE[u.type][t] === 0);
  // Engineers are too fragile to fight: they go where a bridge is needed (or blown), else stay home.
  const job = engineer && !wounded && !needsSupply ? ctx.engineerJob(u) : null;
  const goal: Goal = job ? job
    : ground && needsSupply && !wounded && !engineer && !def.resupplies ? 'supply'
    : wounded || needsSupply || unarmed || engineer ? 'home'
    : def.canCapture && (ctx.pushing || ctx.ahead) && Number.isFinite(ctx.field(def.moveType, 'hq', u.type)[u.y * s.width + u.x]) ? 'hq'
    : def.canCapture && ctx.hasCaptureGoals ? 'capture'
    : (p.siege && ctx.ahead) || ctx.pushing ? 'siege'
    : ctx.hasTargetsFor(u.type) ? 'enemy'
    : 'home';
  return { goal, wounded, needsSupply };
}

function bestOrderFor(s: GameState, u: Unit, ctx: Context): Scored {
  const def = UNITS[u.type];
  if (def.transport) return transportOrder(s, u, ctx);
  const p = ctx.profile;
  const value = def.cost * (u.hp / 100);
  const cls = supplyClassOf(u.type);
  const { goal, wounded, needsSupply } = intentOf(s, u, ctx);
  // Stranded (no land route to the goal) units head for a transport that can carry them.
  const ride = ctx.rideWish(u);
  // Cut off by a river with a bridge planned: wait at the crossing for the Engineer.
  const field = ride === 'stranded' && ctx.hasTransportFor(u) ? ctx.field(def.moveType, 'pickup', u.type)
    : ride === 'stranded' && ctx.bridgePlan().build.size ? ctx.bridgedField(def.moveType, goal, u.type)
    : ctx.field(def.moveType, goal, u.type);
  const plan = ctx.bridgePlan();
  const w = s.width;
  const distNow = field[u.y * s.width + u.x];
  const indirect = def.minRange > 1;
  const ranged = unitMaxRange(s, u) > 1;
  // Engineers with a bridge to build or blow up press on despite danger: that's their whole job.
  const step = (ctx.ahead || ctx.pushing ? p.step * 1.3 : p.step) * (goal === 'bridge' || goal === 'demolish' || goal === 'repair' ? 2.5 : 1);
  const riskFactor = ctx.pushing ? p.risk * 0.15 : ctx.ahead ? p.risk * 0.5 : p.risk;

  let best: Scored = { score: -Infinity, action: { type: 'act', unitId: u.id, to: { x: u.x, y: u.y }, command: { kind: 'wait' } } };
  const consider = (score: number, action: Action) => {
    if (p.noise) score += (ctx.rng() - 0.5) * p.noise;
    if (score > best.score) best = { score, action };
  };

  for (const k of destinations(s, u, reachable(s, u))) {
    const [x, y] = k.split(',').map(Number);
    const to = { x, y };
    const moved = x !== u.x || y !== u.y;
    // Tiles with our own transport on them mean "board it". Worth it when we're
    // stranded (no land route) or facing a long march the transport can shorten.
    const transport = moved ? boardingTarget(s, u, x, y) : undefined;
    if (transport) {
      if (ride) {
        const bonus = ride === 'stranded' ? 4000 : 1200;
        const from = Number.isFinite(distNow) ? -distNow * p.step : -5000;
        consider(from + bonus, { type: 'act', unitId: u.id, to, command: { kind: 'load' } });
      }
      continue;
    }
    const tile = tileAt(s, x, y);
    const stars = TERRAIN[tile.terrain].defense;

    // Positional score: get closer to the goal, prefer cover, avoid danger.
    let dist = field[y * s.width + x];
    // Ranged units (artillery, rockets, snipers) want to sit at range, not walk up to the enemy.
    if (ranged && goal === 'enemy') dist = Math.max(0, dist - unitMaxRange(s, u));
    // Snipers can shoot point-blank but are fragile: don't park right next to enemies.
    if (ranged && !indirect && ctx.adjacentToEnemy(x, y)) dist += 2;
    let base = Number.isFinite(dist) ? -dist * step : -5000;
    base += stars * p.cover;
    // Engineers dug into cover take only a fraction of each hit, so cover is where they're safe.
    const dugIn = def.coverDamage !== undefined && !!def.coverTerrain?.includes(tile.terrain);
    const risk = dugIn
      ? Math.min(1, (ctx.threatAt(k, u.type) / 100) * def.coverDamage! * riskFactor) * value
      : Math.min(1, (ctx.threatAt(k, u.type) / 100) * riskFactor) * value * (1 - stars * 0.08);
    base -= risk;
    // Whoever is on a bridge when it falls dies: don't stop on one the enemy can bring down next turn.
    if (cls === 'ground' && ctx.bridgeMayFall(x, y)) base -= value;
    const supplyHere = tile.owner === u.owner && !!TERRAIN[tile.terrain].supplies?.includes(cls);
    if (tile.owner === u.owner && TERRAIN[tile.terrain].builds && !(wounded || needsSupply)) base -= FACTORY_BLOCK;
    if ((wounded || needsSupply) && supplyHere) base += 1500;
    if (needsSupply && cls === 'ground' && ctx.nextToSupplier(u, x, y)) base += 1500; // an APC will top us up

    consider(base, { type: 'act', unitId: u.id, to, command: { kind: 'wait' } });

    // Engineers: bridge a planned crossing, fix a cracked one we use, or (from the bank) blow up
    // one the enemy is about to use — taking anyone standing on it down too.
    if (canBuildBridge(s, u, x, y) && plan.build.has(y * w + x)) {
      consider(base + 4000, { type: 'act', unitId: u.id, to, command: { kind: 'bridge' } });
    }
    for (const b of repairTargetsFrom(s, u, x, y)) {
      if (plan.repair.has(b.y * w + b.x)) consider(base + 4000, { type: 'act', unitId: u.id, to, command: { kind: 'repair', x: b.x, y: b.y } });
    }
    for (const b of demolishTargetsFrom(s, u, x, y)) {
      if (!plan.demolish.has(b.y * w + b.x)) continue;
      consider(base + 5000 + ctx.lostWithBridge(b.x, b.y), { type: 'act', unitId: u.id, to, command: { kind: 'demolish', x: b.x, y: b.y } });
    }
    // Bombers, Artillery and Rockets shell those bridges too (a Bomber takes one out in one hit),
    // and any bridge with enemies on it that one more hit brings down — unless we need it ourselves.
    for (const b of bridgeTargetsFrom(s, u, x, y, moved)) {
      const bi = b.y * w + b.x;
      const destroys = (tileAt(s, b.x, b.y).damage ?? 0) + (def.bridgeDamage ?? 0) >= (TERRAIN.bridge.durability ?? 1);
      const kill = destroys ? ctx.lostWithBridge(b.x, b.y) : 0;
      const wanted = plan.demolish.has(bi);
      if (!wanted && !kill) continue;
      const score = (wanted ? (destroys ? 6000 : 3000) : 0) + kill * (1 + p.killBonus) - (!wanted && plan.keep.has(bi) ? 4000 : 0);
      if (score > 0) consider(base + score, { type: 'act', unitId: u.id, to, command: { kind: 'strike', x: b.x, y: b.y } });
    }

    // Low on fuel: just get home. Stopping to fight is how aircraft end up crashing.
    // (Ground vehicles low on fuel still fight on the way: running dry only strands them.)
    if (needsSupply && !outOfAmmo(u) && cls !== 'ground') continue;

    if (canCapture(s, u, x, y)) {
      const power = Math.floor((displayHp(u.hp) * (100 + captureBonus(s, u.owner))) / 100);
      const finishes = power >= tile.capture;
      const worth = tile.terrain === 'hq' ? 20000 : tile.terrain === 'factory' ? 4000 : 2500;
      const progress = finishes ? 1 : power / CAPTURE_POINTS;
      const keepGoing = !moved && tile.capture < CAPTURE_POINTS ? 1000 : 0;
      consider(base + worth * progress + 500 + keepGoing, { type: 'act', unitId: u.id, to, command: { kind: 'capture' } });
    }

    for (const t of targetsFrom(s, u, x, y, moved)) {
      const f = forecast(s, u, to, t);
      const tCost = UNITS[t.type].cost;
      const kills = f.deal >= t.hp;
      let score = base + (f.deal / 100) * tCost - (f.take / 100) * def.cost * p.counterCare;
      if (kills) score += p.killBonus * tCost + 1000;
      // Stop enemies capturing our (or our allies') buildings.
      const under = tileAt(s, t.x, t.y);
      if (p.defendCaptures && under.capture < CAPTURE_POINTS && under.owner !== null && areAllies(s, under.owner, u.owner)) {
        score += under.terrain === 'hq' ? 8000 : 2500;
      }
      if (f.deal <= 0) continue;
      consider(score, { type: 'act', unitId: u.id, to, command: { kind: 'attack', targetId: t.id } });
    }
  }
  return best;
}

/**
 * Transports (APC, Airlift, Lander): carry passengers toward their goals and drop
 * them off; when empty, go and fetch whoever is waiting for a ride; otherwise stay safe.
 */
function transportOrder(s: GameState, u: Unit, ctx: Context): Scored {
  const p = ctx.profile;
  const def = UNITS[u.type];
  const cargo = u.cargo ?? [];
  const cls = supplyClassOf(u.type);
  const value = def.cost * (u.hp / 100) + cargo.reduce((sum, c) => sum + UNITS[c.type].cost * (c.hp / 100), 0);
  const { needsSupply } = intentOf(s, u, ctx);
  // Gather a full load before setting off, so units land together instead of one at a time.
  const roomLeft = (def.transport?.capacity ?? 0) - cargo.length;
  const gathering = cargo.length > 0 && roomLeft > 0 && ctx.hasRidersFor(u);
  const lead = gathering ? undefined : cargo[0];
  const field = needsSupply ? ctx.field(def.moveType, 'home', u.type)
    : lead ? ctx.deliveryField(u.type, lead)
    : ctx.hasRidersFor(u) ? ctx.pickupField(u)
    : cargo[0] ? ctx.deliveryField(u.type, cargo[0])
    // Nothing to carry: an APC drives out to refuel and rearm vehicles running low.
    : def.resupplies && ctx.needy().length ? ctx.field(def.moveType, 'needy')
    : ctx.field(def.moveType, 'home', u.type);
  const w = s.width;

  let best: Scored = { score: -Infinity, action: { type: 'act', unitId: u.id, to: { x: u.x, y: u.y }, command: { kind: 'wait' } } };
  const consider = (score: number, action: Action) => {
    if (p.noise) score += (ctx.rng() - 0.5) * p.noise;
    if (score > best.score) best = { score, action };
  };

  for (const k of destinations(s, u, reachable(s, u))) {
    const [x, y] = k.split(',').map(Number);
    const to = { x, y };
    if ((x !== u.x || y !== u.y) && boardingTarget(s, u, x, y)) continue; // transports don't ride transports
    const tile = tileAt(s, x, y);
    const stars = TERRAIN[tile.terrain].defense;
    const dist = field[y * w + x];
    let base = Number.isFinite(dist) ? -dist * p.step : -5000;
    // Carrying passengers makes a transport a juicy target: be careful.
    const risk = Math.min(1, (ctx.threatAt(k, u.type) / 100) * Math.max(p.risk, 0.3)) * value * (1 - stars * 0.08);
    base -= risk;
    if (cls === 'ground' && ctx.bridgeMayFall(x, y)) base -= value; // passengers would go down too
    const supplyHere = tile.owner === u.owner && !!TERRAIN[tile.terrain].supplies?.includes(cls);
    if (tile.owner === u.owner && TERRAIN[tile.terrain].builds && !needsSupply) base -= FACTORY_BLOCK;
    if (needsSupply && supplyHere) base += 1500;
    // Empty and next to someone who wants a ride: wait here so they can climb in.
    if (!lead && !needsSupply && ctx.riderNextTo(u, x, y)) base += 600;
    // An APC parked next to vehicles that need fuel or ammo refills them next turn.
    if (def.resupplies && !needsSupply) base += 600 * ctx.needy().filter(n => n.id !== u.id && Math.abs(n.x - x) + Math.abs(n.y - y) === 1).length;
    consider(base, { type: 'act', unitId: u.id, to, command: { kind: 'wait' } });

    // Unload: each passenger onto the free tile nearest its own goal (not while still gathering).
    if (!cargo.length || needsSupply || gathering) continue;
    const drops: Array<{ cargoId: number; x: number; y: number }> = [];
    const taken: Pos[] = [];
    let bestLanding = Infinity;
    for (const c of cargo) {
      const cf = ctx.field(UNITS[c.type].moveType, intentOf(s, c, ctx).goal, c.type);
      let pick: Pos | null = null;
      let pickDist = Infinity;
      for (const t of dropTiles(s, u, x, y, c, taken)) {
        const d = cf[t.y * w + t.x];
        if (d < pickDist) { pickDist = d; pick = t; }
      }
      if (!pick || !Number.isFinite(pickDist)) continue;
      drops.push({ cargoId: c.id, x: pick.x, y: pick.y });
      taken.push(pick);
      bestLanding = Math.min(bestLanding, pickDist);
    }
    // Drop off only if no better landing spot lies ahead on the route.
    if (drops.length && bestLanding <= (Number.isFinite(dist) ? dist : Infinity) + 1) {
      consider(-bestLanding * p.step + 800 - risk, { type: 'act', unitId: u.id, to, command: { kind: 'unload', drops } });
    }
  }
  return best;
}

/** Is this unit sitting on one of its owner's unit-producing buildings? */
function onOwnDepot(s: GameState, u: Unit): boolean {
  const t = tileAt(s, u.x, u.y);
  return t.owner === u.owner && !!TERRAIN[t.terrain].builds;
}

// ---------------------------------------------------------------- building

// (Worked out on each call: a custom unit set can give units weapons or bridge kits.)
/** Unit types the CPU buys as fighters: anything with a weapon except Engineers (transports are bought separately). */
const armedTypes = () => UNIT_ORDER.filter(t => UNIT_ORDER.some(v => DAMAGE[t][v] > 0) && UNITS[t].bridgeKits === undefined);
/** Engineers are bought only when the bridge plan has work for them. */
const engineerType = () => UNIT_ORDER.find(t => UNITS[t].bridgeKits !== undefined);
const BUILD_ORDER: SupplyClass[] = ['ground', 'air', 'naval'];

function chooseBuild(s: GameState, pid: number, ctx: Context): Action | null {
  if (atUnitCap(s, pid)) return null;
  // Every free building we own that produces units: factories first, then airfields, then ports.
  const free = s.tiles
    .map((t, i) => i)
    .filter(i => {
      const t = s.tiles[i];
      return t.owner === pid && !!TERRAIN[t.terrain].builds && !unitAt(s, i % s.width, Math.floor(i / s.width));
    })
    .sort((a, b) => BUILD_ORDER.indexOf(TERRAIN[s.tiles[a].terrain].builds!) - BUILD_ORDER.indexOf(TERRAIN[s.tiles[b].terrain].builds!));
  for (const i of free) {
    const action = chooseBuildAt(s, pid, ctx, i, free.length);
    if (action) return action;
  }
  return null;
}

function chooseBuildAt(s: GameState, pid: number, ctx: Context, at: number, freeCount: number): Action | null {
  const me = s.players[pid];
  const builds = TERRAIN[s.tiles[at].terrain].builds!;
  const factory = at;

  // Budget builds share money across every free building this turn.
  const price = (t: UnitType) => unitCost(s, pid, t);
  const budget = ctx.profile.budgetBuild ? Math.max(me.funds / freeCount, price('rifle')) : me.funds;
  const affordable = armedTypes().filter(t => supplyClassOf(t) === builds && price(t) <= Math.min(budget, me.funds));
  // Transports first, when someone needs a lift this building can provide.
  const lift = pickTransport(s, pid, ctx, builds, t => price(t) <= me.funds);
  if (lift) return { type: 'build', x: factory % s.width, y: Math.floor(factory / s.width), unitType: lift };

  // An Engineer when there's a bridge to build or blow up (up to one per job, at most 2),
  // once the first few capturers are out.
  // (Not onto a factory enemies can already reach: a fresh Engineer would just be shot.)
  const engType = engineerType();
  const fx = factory % s.width;
  const fy = Math.floor(factory / s.width);
  if (builds === 'ground' && engType && price(engType) <= me.funds && ctx.threatAt(posKey(fx, fy), engType) === 0) {
    const plan = ctx.bridgePlan();
    // A bridge to blow up only counts if a slow Engineer could get there in about 3 turns.
    const urgent = plan.demolish.size && ctx.field(UNITS[engType].moveType, 'demolish')[factory] <= UNITS[engType].move * 3 ? 1 : 0;
    // ...and a bridge site only counts while no visible enemy covers it.
    const safeSites = [...plan.build.keys(), ...plan.repair]
      .filter(i => ctx.threatAt(posKey(i % s.width, Math.floor(i / s.width)), engType) === 0).length;
    const jobs = safeSites + urgent;
    const engineers = allUnitsOf(s, pid).filter(u => u.type === engType).length; // riding ones too
    const capturersOut = s.units.filter(u => u.owner === pid && UNITS[u.type].canCapture).length;
    if (jobs && engineers < Math.min(2, jobs) && (capturersOut >= 2 || urgent)) {
      return { type: 'build', x: factory % s.width, y: Math.floor(factory / s.width), unitType: engType };
    }
  }

  if (!affordable.length) return null;
  // Plenty of ground units already stuck waiting for a lift (island maps): don't add
  // more to the queue — spend on transports, aircraft and ships that can reach the enemy.
  if (builds === 'ground' && ctx.riders().filter(r => r.wish === 'stranded').length >= 4) return null;
  // Aircraft and ships are pricey: only buy them when there's something for them to hit,
  // and only as many as our airfields/ports can keep fuelled (3 per building).
  if (builds !== 'ground') {
    if (!ctx.enemies.some(e => affordable.some(t => DAMAGE[t][e.type] > 0))) return null;
    const depots = s.tiles.filter(t => t.owner === pid && TERRAIN[t.terrain].builds === builds).length;
    const fleet = s.units.filter(u => u.owner === pid && supplyClassOf(u.type) === builds).length;
    if (fleet >= depots * 3) return null;
  }

  const mine = s.units.filter(u => u.owner === pid);
  const enemies = ctx.enemies;
  const capturers = mine.filter(u => UNITS[u.type].canCapture).length;
  const openProps = s.tiles.filter(t => TERRAIN[t.terrain].property && (t.owner === null || !areAllies(s, t.owner, pid))).length;
  const enemyVehicles = enemies.filter(u => !UNITS[u.type].canCapture).length;

  // Snipers are support: they soften infantry for the rest of the army. Smarter
  // CPUs add one only once they already have a real army to back it up.
  const enemyInfantry = enemies.filter(u => UNITS[u.type].moveType === 'foot' || UNITS[u.type].moveType === 'boot').length;
  const mySnipers = mine.filter(u => u.type === 'sniper').length;
  const myFighters = mine.filter(u => !UNITS[u.type].canCapture && u.type !== 'sniper').length;
  const wantSniper = ctx.profile.counterPick && enemyInfantry >= 4 && myFighters >= 6 && mySnipers < 1
    && affordable.includes('sniper' as UnitType);

  let type: UnitType;
  if (builds !== 'ground') {
    type = ctx.profile.counterPick
      ? bestCounterPick(s, pid, affordable, enemies, price, ctx)
      : affordable[Math.floor(ctx.rng() * affordable.length)];
  } else if (capturers < Math.min(4, openProps) && affordable.includes('rifle')) {
    type = enemyVehicles > 0 && capturers >= 2 && affordable.includes('bazooka') ? 'bazooka' : 'rifle';
  } else if (wantSniper) {
    type = 'sniper' as UnitType;
  } else if (!ctx.profile.counterPick) {
    type = affordable[Math.floor(ctx.rng() * affordable.length)];
  } else if (!enemies.length) {
    type = (['ltank', 'scout', 'rifle'] as UnitType[]).find(t => affordable.includes(t)) ?? affordable[0];
  } else {
    type = bestCounterPick(s, pid, affordable, enemies, price, ctx);
  }
  return { type: 'build', x: factory % s.width, y: Math.floor(factory / s.width), unitType: type };
}

/**
 * Which transport (if any) to buy at this kind of building: Landers/Airlifts for
 * units with no land route to their goal, APCs (smarter CPUs) for infantry facing
 * a long march. At most 2 of each, roughly one per two waiting units.
 */
function pickTransport(
  s: GameState, pid: number, ctx: Context, builds: SupplyClass, affordable: (t: UnitType) => boolean,
): UnitType | null {
  const riders = ctx.riders();
  if (!riders.length) return null;
  const options = UNIT_ORDER
    .filter(t => UNITS[t].transport && supplyClassOf(t) === builds && affordable(t))
    .sort((a, b) => UNITS[a].cost - UNITS[b].cost);
  for (const t of options) {
    // Ground transports only help the long-march case, and only smarter CPUs bother.
    if (builds === 'ground' && !ctx.profile.counterPick) continue;
    const wanting = riders.filter(r => ctx.carriesFor(t, r.unit, r.wish)
      && (builds === 'ground' ? r.wish === 'far' && familyOf(r.unit.type) === 'infantry' : r.wish === 'stranded'));
    const need = builds === 'ground' ? (wanting.length >= 2 ? 1 : 0) : Math.min(2, Math.ceil(wanting.length / 2));
    const owned = s.units.filter(u => u.owner === pid && u.type === t).length;
    if (owned < need) return t;
  }
  return null;
}

/**
 * Counter-pick: damage we'd deal to their army vs. damage they'd deal to us, per fund spent.
 * Commander bonuses count, so e.g. an artillery commander actually builds artillery.
 */
function bestCounterPick(
  s: GameState, pid: number, options: UnitType[], enemies: Unit[], price: (t: UnitType) => number, ctx: Context,
): UnitType {
  // Diminishing returns: enemy types our army can already hit plenty count for less,
  // so e.g. a handful of cheap enemy Snipers doesn't make us buy nothing but Riflemen.
  const need = new Map<UnitType, number>();
  for (const e of enemies) need.set(e.type, (need.get(e.type) ?? 0) + e.hp / 100);
  const weight = new Map<UnitType, number>();
  for (const [et, n] of need) {
    let have = 0;
    for (const m of s.units) if (m.owner === pid) have += (DAMAGE[m.type][et] / 100) * (m.hp / 100);
    weight.set(et, n / (n + have));
  }

  let bestScore = -Infinity;
  let type = options[0];
  for (const t of options) {
    const cost = price(t);
    const atk = (100 + bonus(s, pid, t, 'attack')) / 100;
    const tough = 100 / (100 + bonus(s, pid, t, 'defense'));
    let offense = 0;
    let defense = 0;
    for (const e of enemies) {
      offense += (DAMAGE[t][e.type] / 100) * atk * UNITS[e.type].cost * (e.hp / 100) * weight.get(e.type)!;
      defense += (DAMAGE[e.type][t] / 100) * tough * cost;
    }
    const score = (offense - 0.5 * defense) / Math.max(1, enemies.length) / Math.pow(cost, ctx.profile.thrift) + cost / 40000;
    if (score > bestScore) { bestScore = score; type = t; }
  }
  return type;
}

// ---------------------------------------------------------------- shared analysis

class Context {
  private fields = new Map<string, number[]>();
  private enemyThreats: Array<{ type: UnitType; hp: number; danger: Set<string> }>;
  readonly hasCaptureGoals: boolean;
  /** True when pressing the advantage: our team's army is worth 1.5x the strongest enemy team's. */
  readonly ahead: boolean;
  /** True when it's time to attack whatever the odds: near the unit cap, or a long game. */
  readonly pushing: boolean;

  /** Enemy units this player can see (all of them when fog is off) — the AI never peeks through fog. */
  readonly enemies: Unit[];

  constructor(private s: GameState, private pid: number, readonly profile: Profile, readonly rng: () => number) {
    const team = teamOf(s, pid);
    const vision = visibleTiles(s, team);
    this.enemies = s.units.filter(u => !areAllies(s, u.owner, pid) && canSee(s, vision, team, u));
    this.enemyThreats = this.enemies.map(u => ({ type: u.type, hp: u.hp, danger: threatTiles(s, u).danger }));
    this.hasCaptureGoals = this.goalTiles('capture').length > 0;

    // Compare whole teams, so a team game sees its combined strength (1v1 and FFA: one player each).
    const known = [...s.units.filter(u => areAllies(s, u.owner, pid)), ...this.enemies];
    const armyValue = (t: number) => known
      .filter(u => s.players[u.owner].team === t)
      .reduce((sum, u) => sum + UNITS[u.type].cost * (u.hp / 100), 0);
    const mine = armyValue(team);
    const foeTeams = new Set(s.players.filter(pl => pl.alive && pl.team !== team).map(pl => pl.team));
    const strongestFoe = Math.max(0, ...[...foeTeams].map(armyValue));
    this.ahead = profile.pressAdvantage && mine > 10000 && mine >= strongestFoe * 1.5;
    // Break stalemates: an army at the unit cap can't grow any more (big team games), and
    // a long game needs finishing. Either way, stop holding the line and go for their buildings.
    this.pushing = allUnitsOf(s, pid).length >= MAX_UNITS - 5 || s.day >= (s.players.length > 4 ? PUSH_DAY_BIG : PUSH_DAY);
  }

  // ---- transport planning

  private rideCache = new Map<number, RideWish>();

  /**
   * Does this ground unit want a lift? "stranded": no land route to its goal at all
   * (e.g. it's on another island). "far": a long march a transport could shorten.
   */
  rideWish(u: Unit): RideWish {
    const cached = this.rideCache.get(u.id);
    if (cached !== undefined) return cached;
    let wish: RideWish = null;
    const fam = familyOf(u.type);
    if ((fam === 'infantry' || fam === 'vehicle') && !UNITS[u.type].transport) {
      const { goal } = intentOf(this.s, u, this);
      if (goal !== 'home') {
        const d = this.field(UNITS[u.type].moveType, goal, u.type)[u.y * this.s.width + u.x];
        wish = !Number.isFinite(d) ? 'stranded' : d > UNITS[u.type].move * 2.5 ? 'far' : null;
      }
    }
    this.rideCache.set(u.id, wish);
    return wish;
  }

  /** Our units that want a lift (on the map, not already riding). */
  riders(): Array<{ unit: Unit; wish: Exclude<RideWish, null> }> {
    const out: Array<{ unit: Unit; wish: Exclude<RideWish, null> }> = [];
    for (const u of this.s.units) {
      if (u.owner !== this.pid) continue;
      const wish = this.rideWish(u);
      if (wish) out.push({ unit: u, wish });
    }
    return out;
  }

  /** Could this transport type carry this rider? Landers only fetch stranded units (no land route). */
  carriesFor(transportType: UnitType, rider: Unit, wish: RideWish): boolean {
    const t = UNITS[transportType].transport;
    if (!t || !t.carries.includes(familyOf(rider.type))) return false;
    return wish === 'stranded' || UNITS[transportType].moveType !== 'ship';
  }

  /** Is there one of our transports with room that could carry this unit? */
  hasTransportFor(u: Unit): boolean {
    return this.s.units.some(t => t.owner === this.pid && canBoard(t, u));
  }

  /** Is anyone waiting for a lift that this (empty) transport could carry? */
  hasRidersFor(transport: Unit): boolean {
    return this.riders().some(r => this.carriesFor(transport.type, r.unit, r.wish));
  }

  /** Would a rider be right next to this transport if it stopped at (x, y)? */
  riderNextTo(transport: Unit, x: number, y: number): boolean {
    return this.riders().some(r => this.carriesFor(transport.type, r.unit, r.wish)
      && Math.abs(r.unit.x - x) + Math.abs(r.unit.y - y) === 1);
  }

  private needyCache?: Unit[];

  /** Our ground vehicles that need fuel or ammo (APCs drive out to them). */
  needy(): Unit[] {
    if (this.needyCache) return this.needyCache;
    this.needyCache = []; // (set first: intentOf below may ask again)
    this.needyCache = this.s.units.filter(u => u.owner === this.pid && supplyClassOf(u.type) === 'ground'
      && !UNITS[u.type].resupplies && (u.fuel !== undefined || UNITS[u.type].ammo !== undefined) && intentOf(this.s, u, this).needsSupply);
    return this.needyCache;
  }

  /** Would this unit be next to one of our APCs (which refuel and rearm their neighbours) at (x, y)? */
  nextToSupplier(u: Unit, x: number, y: number): boolean {
    return this.s.units.some(o => o.owner === this.pid && o.id !== u.id && UNITS[o.type].resupplies
      && Math.abs(o.x - x) + Math.abs(o.y - y) === 1);
  }

  /**
   * For a loaded transport: distance from every tile to a good drop-off spot,
   * counting both the transport's trip and the passenger's walk from the landing tile.
   */
  deliveryField(transportType: UnitType, cargo: Unit): number[] {
    const tm = UNITS[transportType].moveType;
    const cm = UNITS[cargo.type].moveType;
    const { goal } = intentOf(this.s, cargo, this);
    const key = `deliver:${tm}:${cm}:${goal}:${cargo.type}`;
    const cached = this.fields.get(key);
    if (cached) return cached;
    const dist = this.viaShore(tm, [{ walk: this.field(cm, goal, cargo.type), moveType: cm }]);
    this.fields.set(key, dist);
    return dist;
  }

  /**
   * For an empty transport: distance to a spot where waiting riders can climb in,
   * counting the riders' own walk to it (e.g. to the shore for a Lander).
   */
  pickupField(transport: Unit): number[] {
    const key = `pickupFor:${transport.type}`;
    const cached = this.fields.get(key);
    if (cached) return cached;
    const tm = UNITS[transport.type].moveType;
    const walks = this.riders()
      .filter(r => this.carriesFor(transport.type, r.unit, r.wish))
      .map(r => {
        const moveType = UNITS[r.unit.type].moveType;
        return { walk: this.walkFrom(r.unit.y * this.s.width + r.unit.x, moveType), moveType };
      });
    const dist = this.viaShore(tm, walks);
    this.fields.set(key, dist);
    return dist;
  }

  // ---- bridge planning (Engineers)

  private plan?: BridgePlan;

  /**
   * Smarter CPUs plan bridges. build: river tiles where a bridge would save our vehicles
   * (and the tanks our factories will build) at least BRIDGE_GAIN move points, or open a
   * route that doesn't exist at all — the first river tile on each such route, with the
   * total saving. demolish: bridges enemy vehicles are about to use to reach our buildings
   * that none of our own vehicles need (Engineers blow them up, Bombers/Artillery/Rockets
   * shell them). repair: cracked bridges our own vehicles drive over.
   */
  bridgePlan(): BridgePlan {
    if (this.plan) return this.plan;
    const plan: BridgePlan = { build: new Map(), demolish: new Set(), repair: new Set(), keep: new Set() };
    this.plan = plan;
    const { s, pid } = this;
    if (!this.profile.counterPick || !s.tiles.some(t => t.terrain === 'river' || t.terrain === 'bridge')) return plan;
    const w = s.width;

    // Crossings visible enemy vehicles could reach within two turns on their way to our
    // buildings: over bridges that exist now, or over any river if it were bridged.
    const enemyNow = new Set<number>();
    const enemyIfBridged = new Set<number>();
    for (const e of this.enemies) {
      if (familyOf(e.type) !== 'vehicle' || UNITS[e.type].transport) continue;
      const mt = UNITS[e.type].moveType;
      const start = e.y * w + e.x;
      for (const [bridged, into] of [[false, enemyNow], [true, enemyIfBridged]] as const) {
        const toUs = bridged ? this.bridgedField(mt, 'home') : this.field(mt, 'home');
        if (!Number.isFinite(toUs[start])) continue;
        for (const i of this.route(toUs, start, mt, bridged)) {
          if (toUs[start] - toUs[i] > UNITS[e.type].move * 2) break;
          into.add(i);
        }
      }
    }

    // Who has the stronger armour? Bridges help whoever brings more tanks across.
    const vehicleValue = (us: boolean) => (us ? s.units.filter(u => u.owner === pid) : this.enemies)
      .filter(u => familyOf(u.type) === 'vehicle' && !UNITS[u.type].transport)
      .reduce((sum, u) => sum + UNITS[u.type].cost * (u.hp / 100), 0);
    const ours = vehicleValue(true);
    const theirs = vehicleValue(false);

    // Routes our vehicles take to the enemy's buildings: the ones we have, plus a tank from
    // each factory. (Buildings, not the nearest enemy unit: infantry wade rivers, tanks can't.)
    const routes: Array<{ start: number; moveType: MoveType }> = [];
    for (const u of s.units) {
      if (u.owner === pid && familyOf(u.type) === 'vehicle' && !UNITS[u.type].transport) {
        routes.push({ start: u.y * w + u.x, moveType: UNITS[u.type].moveType });
      }
    }
    s.tiles.forEach((t, i) => {
      if (t.owner === pid && TERRAIN[t.terrain].builds === 'ground') routes.push({ start: i, moveType: UNITS.ltank.moveType });
    });

    const ourRoads = new Set<number>(); // tiles our vehicles (and the ones our factories will build) drive over
    for (const r of routes) {
      const normal = this.field(r.moveType, 'siege');
      const bridged = this.bridgedField(r.moveType, 'siege');
      if (Number.isFinite(normal[r.start])) for (const i of this.route(normal, r.start, r.moveType, false)) ourRoads.add(i);
      if (!Number.isFinite(bridged[r.start])) continue;
      const gain = Number.isFinite(normal[r.start]) ? normal[r.start] - bridged[r.start] : 50;
      if (gain < BRIDGE_GAIN) continue;
      const site = this.route(bridged, r.start, r.moveType, true).find(i => s.tiles[i].terrain === 'river');
      // Don't open a crossing enemy tanks would pour over first, unless our armour can hold it.
      if (site === undefined || (enemyIfBridged.has(site) && ours < theirs * 0.8)) continue;
      plan.build.set(site, (plan.build.get(site) ?? 0) + gain);
    }

    // Blow up bridges enemy tanks are about to use: ones we don't need, or any when we're outgunned.
    // (Not once we're pushing to finish the game: we need every crossing ourselves then.)
    for (const i of this.pushing ? [] : enemyNow) {
      if (s.tiles[i].terrain === 'bridge' && (!ourRoads.has(i) || ours < theirs * 0.6)) plan.demolish.add(i);
    }
    for (const i of ourRoads) {
      if (s.tiles[i].terrain === 'bridge') plan.keep.add(i);
      if (s.tiles[i].damage && !plan.demolish.has(i)) plan.repair.add(i);
    }
    return plan;
  }

  /** The tiles along the cheapest route down a distance field from `start` to its goal. */
  private route(dist: number[], start: number, moveType: MoveType, bridged: boolean): number[] {
    const { s } = this;
    const out: number[] = [];
    let i = start;
    while (dist[i] > 0 && out.length < s.width * s.height) {
      const x = i % s.width;
      const y = Math.floor(i / s.width);
      let next = -1;
      let best = Infinity;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
        const n = ny * s.width + nx;
        const cost = this.enterCost(n, moveType, bridged);
        const v = dist[n] + (dist[n] === 0 ? 1 : cost);
        if (cost < BLOCKED && v < best) { best = v; next = n; }
        else if (dist[n] === 0 && v < best) { best = v; next = n; } // goal tiles may be "blocked" (an enemy ship)
      }
      if (next < 0 || !Number.isFinite(best)) break;
      out.push(next);
      i = next;
    }
    return out;
  }

  private fallCache = new Map<number, boolean>();

  /**
   * Could the enemy bring down the bridge at (x, y) on their next turn? Enough Bomber /
   * Artillery / Rocket hits in range, or an Engineer with a kit close enough to reach its bank.
   */
  bridgeMayFall(x: number, y: number): boolean {
    const { s } = this;
    const i = y * s.width + x;
    const tile = s.tiles[i];
    if (tile.terrain !== 'bridge') return false;
    const cached = this.fallCache.get(i);
    if (cached !== undefined) return cached;
    const k = posKey(x, y);
    let hits = tile.damage ?? 0;
    let falls = false;
    this.enemies.forEach((e, n) => {
      const def = UNITS[e.type];
      if (def.bridgeDamage && !outOfAmmo(e) && this.enemyThreats[n].danger.has(k)) hits += def.bridgeDamage;
      if (hasBridgeKit(e) && Math.abs(e.x - x) + Math.abs(e.y - y) <= def.move + 1) falls = true;
    });
    falls ||= hits >= (TERRAIN.bridge.durability ?? 1);
    this.fallCache.set(i, falls);
    return falls;
  }

  /** Value of the enemy unit (and anything it carries) on this bridge, which dies if it falls. */
  lostWithBridge(x: number, y: number): number {
    const on = unitAt(this.s, x, y);
    if (!on || areAllies(this.s, on.owner, this.pid) || familyOf(on.type) === 'air' || !this.enemies.includes(on)) return 0;
    return [on, ...(on.cargo ?? [])].reduce((sum, u) => sum + UNITS[u.type].cost * (u.hp / maxHpOf(u.type)), 0);
  }

  /** What an Engineer with a kit should do: blow up a threatened bridge first, then repair, then build. */
  engineerJob(u: Unit): 'bridge' | 'demolish' | 'repair' | null {
    const plan = this.bridgePlan();
    const at = u.y * this.s.width + u.x;
    const mt = UNITS[u.type].moveType;
    if (plan.demolish.size && Number.isFinite(this.field(mt, 'demolish')[at])) return 'demolish';
    if (plan.repair.size && Number.isFinite(this.field(mt, 'repair')[at])) return 'repair';
    if (plan.build.size && Number.isFinite(this.field(mt, 'bridge')[at])) return 'bridge';
    return null;
  }

  /** Move-point distance from one tile for a given move type (ignores units). */
  private walkFrom(start: number, moveType: MoveType): number[] {
    const dist = new Array<number>(this.s.width * this.s.height).fill(Infinity);
    dist[start] = 0;
    this.spread(dist, [start], moveType, true);
    return dist;
  }

  /**
   * Transport distance field seeded from "hand-over" tiles: every tile the transport
   * can stop on is priced by the best adjacent tile a passenger can stand on, using that
   * passenger's own walking distance. Then spread outward over the transport's terrain.
   */
  private viaShore(tm: MoveType, walks: Array<{ walk: number[]; moveType: MoveType }>): number[] {
    const { s } = this;
    const dist = new Array<number>(s.width * s.height).fill(Infinity);
    const frontier: number[] = [];
    s.tiles.forEach((t, i) => {
      if (TERRAIN[t.terrain].cost[tm] >= BLOCKED) return;
      const x = i % s.width;
      const y = Math.floor(i / s.width);
      let best = Infinity;
      for (const { walk, moveType } of walks) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
          const n = ny * s.width + nx;
          if (TERRAIN[s.tiles[n].terrain].cost[moveType] >= BLOCKED) continue;
          best = Math.min(best, walk[n]);
        }
      }
      if (Number.isFinite(best)) {
        dist[i] = best + 1;
        frontier.push(i);
      }
    });
    this.spread(dist, frontier, tm);
    return dist;
  }

  /**
   * Dijkstra outward from already-seeded tiles. Reverse mode (default): stepping from a
   * neighbour into tile i costs i's terrain (distance TO the seeds). Forward mode: stepping
   * from i into a neighbour costs the neighbour's terrain (distance FROM the seed).
   */
  private spread(dist: number[], frontier: number[], moveType: MoveType, forward = false) {
    const { s } = this;
    while (frontier.length) {
      frontier.sort((a, b) => dist[a] - dist[b]);
      const i = frontier.shift()!;
      const here = TERRAIN[s.tiles[i].terrain].cost[moveType];
      if (here >= BLOCKED && !(forward && dist[i] === 0)) continue;
      const x = i % s.width;
      const y = Math.floor(i / s.width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
        const n = ny * s.width + nx;
        const there = TERRAIN[s.tiles[n].terrain].cost[moveType];
        if (there >= BLOCKED) continue;
        const nd = dist[i] + (forward ? there : here);
        if (nd < dist[n]) {
          dist[n] = nd;
          frontier.push(n);
        }
      }
    }
  }

  adjacentToEnemy(x: number, y: number): boolean {
    return this.enemies.some(e => Math.abs(e.x - x) + Math.abs(e.y - y) === 1);
  }

  /**
   * % damage enemies could deal next turn to a unit of this type on this tile: the
   * three worst attackers that can reach it (no more can really pile onto one unit,
   * and counting a whole army freezes big fronts in team games).
   */
  threatAt(k: string, type: UnitType): number {
    const hits: number[] = [];
    for (const e of this.enemyThreats) {
      if (e.danger.has(k)) hits.push(DAMAGE[e.type][type] * (displayHp(e.hp) / 10));
    }
    if (hits.length > 3) hits.sort((a, b) => b - a).length = 3;
    return hits.reduce((a, b) => a + b, 0);
  }

  /** Is there any visible enemy this unit type can actually damage? */
  hasTargetsFor(type: UnitType): boolean {
    return this.enemies.some(e => DAMAGE[type][e.type] > 0);
  }

  /** `type` narrows the goal: enemies it can hurt, or buildings that can supply it. */
  private goalTiles(goal: Goal, type?: UnitType): number[] {
    const { s, pid } = this;
    const out: number[] = [];
    if (goal === 'enemy') {
      for (const u of this.enemies) if (!type || DAMAGE[type][u.type] > 0) out.push(u.y * s.width + u.x);
      // No enemy units visible? Head for their buildings instead.
      if (!out.length) return this.goalTiles('capture');
      return out;
    }
    if (goal === 'pickup' && type) {
      // Our transports with room that could carry a unit of this type.
      const probe = { id: -1, type, owner: pid, x: 0, y: 0, hp: 100, acted: false } as Unit;
      for (const t of s.units) if (t.owner === pid && canBoard(t, probe)) out.push(t.y * s.width + t.x);
      return out;
    }
    if (goal === 'supply' && type) {
      // Our buildings that refuel/rearm this kind of unit, plus our APCs (they supply their neighbours).
      const cls = supplyClassOf(type);
      s.tiles.forEach((t, i) => {
        if (t.owner === pid && TERRAIN[t.terrain].supplies?.includes(cls)) out.push(i);
      });
      for (const u of s.units) if (u.owner === pid && UNITS[u.type].resupplies) out.push(u.y * s.width + u.x);
      return out;
    }
    if (goal === 'needy') return this.needy().map(u => u.y * s.width + u.x);
    if (goal === 'bridge') return [...this.bridgePlan().build.keys()];
    if (goal === 'demolish') return [...this.bridgePlan().demolish];
    if (goal === 'repair') {
      // Repairs happen from the bank: head for dry land next to a cracked bridge.
      for (const b of this.bridgePlan().repair) {
        const bx = b % s.width;
        const by = Math.floor(b / s.width);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
          const t = s.tiles[ny * s.width + nx].terrain;
          if (t !== 'river' && t !== 'bridge' && t !== 'sea') out.push(ny * s.width + nx);
        }
      }
      return out;
    }
    if (goal === 'riders' && type) {
      // Our units waiting for a lift that a transport of this type could carry.
      for (const r of this.riders()) if (this.carriesFor(type, r.unit, r.wish)) out.push(r.unit.y * s.width + r.unit.x);
      return out;
    }
    if (goal === 'home' && type) {
      // Our buildings that repair/resupply this kind of unit (airfields for aircraft, ports for ships).
      const cls = supplyClassOf(type);
      s.tiles.forEach((t, i) => {
        if (t.owner === pid && TERRAIN[t.terrain].supplies?.includes(cls)) out.push(i);
      });
      return out.length ? out : this.goalTiles('home');
    }
    if (goal === 'hq') {
      // Enemy HQs: capturing one knocks that player out (what capturers go for when finishing a game).
      s.tiles.forEach((t, i) => {
        if (t.terrain === 'hq' && t.owner !== null && !areAllies(s, t.owner, pid)) out.push(i);
      });
      return out;
    }
    if (goal === 'siege') {
      // Enemy-owned buildings, where their units spawn and their HQ sits.
      s.tiles.forEach((t, i) => {
        if (TERRAIN[t.terrain].property && t.owner !== null && !areAllies(s, t.owner, pid)) out.push(i);
      });
      return out.length ? out : this.goalTiles('enemy');
    }
    s.tiles.forEach((t, i) => {
      if (!TERRAIN[t.terrain].property) return;
      if (goal === 'home' ? t.owner === pid : t.owner === null || !areAllies(s, t.owner, pid)) out.push(i);
    });
    return out;
  }

  /** Move-point distance from every tile to the nearest goal tile (ignores units). */
  field(moveType: MoveType, goal: Goal, type?: UnitType): number[] {
    return this.goalField(moveType, goal, type, false);
  }

  /** Like field(), but as if every river tile already had a bridge on it. */
  bridgedField(moveType: MoveType, goal: Goal, type?: UnitType): number[] {
    return this.goalField(moveType, goal, type, true);
  }

  /** Cost for a unit of this move type to enter tile i (rivers count as bridges if `bridged`). */
  private enterCost(i: number, moveType: MoveType, bridged: boolean): number {
    const t = this.s.tiles[i].terrain;
    return TERRAIN[bridged && t === 'river' ? 'bridge' : t].cost[moveType];
  }

  private goalField(moveType: MoveType, goal: Goal, type: UnitType | undefined, bridged: boolean): number[] {
    // Goals that depend on the unit: who it can hurt (enemy) or where it resupplies (home).
    const narrow = goal === 'enemy' || goal === 'pickup' || goal === 'riders' ? type ?? ''
      : (goal === 'home' || goal === 'supply') && type ? supplyClassOf(type) : '';
    const key = `${bridged ? 'bridged:' : ''}${moveType}:${goal}:${narrow}`;
    const cached = this.fields.get(key);
    if (cached) return cached;

    const { s } = this;
    const dist = new Array<number>(s.width * s.height).fill(Infinity);
    const frontier: number[] = [];
    for (const i of this.goalTiles(goal, type)) {
      dist[i] = 0;
      frontier.push(i);
    }
    while (frontier.length) {
      frontier.sort((a, b) => dist[a] - dist[b]);
      const i = frontier.shift()!;
      const x = i % s.width;
      const y = Math.floor(i / s.width);
      // Walking from neighbour n into i costs i's terrain.
      const step = this.enterCost(i, moveType, bridged);
      const enter = step >= BLOCKED ? Infinity : step;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) continue;
        const n = ny * s.width + nx;
        if (this.enterCost(n, moveType, bridged) >= BLOCKED) continue;
        const nd = dist[i] + (dist[i] === 0 ? 1 : enter);
        if (nd < dist[n]) {
          dist[n] = nd;
          frontier.push(n);
        }
      }
    }
    this.fields.set(key, dist);
    return dist;
  }
}
