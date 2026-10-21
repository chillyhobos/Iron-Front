// What one player is allowed to know. Online, the server sends each player only
// this view, so units hidden by fog of war never reach the other player's browser.

import { canSee, teamOf, visibleTiles } from './rules';
import type { GameEvent, GameState } from './state';

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
