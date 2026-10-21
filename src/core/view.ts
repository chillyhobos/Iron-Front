// What one player is allowed to know. Online, the server sends each player only
// this view, so units hidden by fog of war never reach the other player's browser.

import { canSee, pathTo, reachable, teamOf, unitById, visibleTiles, walkPath } from './rules';
import type { UnitType } from './data';
import type { Action, GameEvent, GameState, Pos } from './state';

/** How a move looks on screen: which unit walked which tiles, then what it attacked or captured. */
export interface MoveAnim {
  unitId: number;
  /** The moving unit's type (picks its weapon's look and timing). */
  unitType: UnitType;
  /** Tiles walked, starting where the unit stood. */
  path: Pos[];
  targetId?: number;
  /** It captured (or kept capturing) the building it ended on: it hops. */
  capture?: true;
}

// (How long these animations take lives in timing.ts.)

/**
 * The game as player `pid` may see it. Without fog that's everything. With fog,
 * enemy units their team can't see are left out, and enemy transports don't
 * reveal who is aboard.
 */
export function playerView(s: GameState, pid: number): GameState {
  const view = JSON.parse(JSON.stringify(s)) as GameState;
  if (!s.fog) return view;
  const team = teamOf(s, pid);
  const vision = visibleTiles(s, team);
  view.units = view.units
    .filter(u => s.players[u.owner].team === team || canSee(s, vision, team, u))
    .map(u => (s.players[u.owner].team === team || !u.cargo ? u : { ...u, cargo: [] }));
  return view;
}

/**
 * The events from one action that player `pid` may see: everything that isn't tied to a
 * tile, plus what happened on tiles their team could see before or after the action.
 */
export function visibleEvents(before: GameState, after: GameState, events: GameEvent[], pid: number): GameEvent[] {
  if (!after.fog) return events;
  const team = teamOf(after, pid);
  const was = visibleTiles(before, team);
  const now = visibleTiles(after, team);
  // (A null vision means the whole map is revealed, e.g. by a commander power.)
  return events.filter(e => {
    if (!('x' in e)) return true;
    const i = e.y * after.width + e.x;
    return !was || !now || was.has(i) || now.has(i);
  });
}

/**
 * The whole move behind an action (before it's applied), for animating it: the path
 * the unit really walks (cut short by an ambush) and its attack target. Null for
 * actions that don't move a unit (building, ending the turn, powers).
 */
export function actionMove(before: GameState, action: Action): MoveAnim | null {
  if (action.type !== 'act') return null;
  const u = unitById(before, action.unitId);
  if (!u) return null;
  const full = pathTo(reachable(before, u), action.to.x, action.to.y);
  const path = full.length ? full.slice(0, walkPath(before, u, full).stop + 1) : [{ x: u.x, y: u.y }];
  const targetId = action.command.kind === 'attack' ? action.command.targetId : undefined;
  return {
    unitId: u.id, unitType: u.type, path,
    ...(targetId !== undefined ? { targetId } : {}),
    // (An ambush stops the unit short of the building: no capture then.)
    ...(action.command.kind === 'capture' && path.length === Math.max(1, full.length) ? { capture: true as const } : {}),
  };
}

/**
 * The part of a move player `pid` may watch. Without fog, or for their own team, all
 * of it. Otherwise nothing if they couldn't see the unit to begin with (it simply
 * appears), the path cut off where it enters tiles they couldn't see before or after
 * the move, the attack target only if they could see it, and the capture hop only if
 * they saw the unit all the way to its building.
 */
export function visibleMove(before: GameState, after: GameState, move: MoveAnim, pid: number): MoveAnim | null {
  const u = unitById(before, move.unitId);
  if (!u) return null;
  const team = teamOf(before, pid);
  if (!before.fog || before.players[u.owner].team === team) return move;
  const was = visibleTiles(before, team);
  const now = visibleTiles(after, team);
  if (!canSee(before, was, team, u)) return null;
  const seen = (p: Pos) => {
    const i = p.y * before.width + p.x;
    return !was || !now || was.has(i) || now.has(i);
  };
  let n = 1;
  while (n < move.path.length && seen(move.path[n])) n++;
  const target = move.targetId !== undefined ? unitById(before, move.targetId) : undefined;
  const showTarget = !!target && canSee(before, was, team, target);
  return {
    unitId: u.id, unitType: move.unitType, path: move.path.slice(0, n),
    ...(showTarget ? { targetId: move.targetId } : {}),
    ...(move.capture && n === move.path.length ? { capture: true as const } : {}),
  };
}
