// Named moments in the game that sound effects (or anything else) can hook into.
// Animations call cue() at the moment something happens on screen, in sync with
// what the player sees, offline and online alike. sound.ts listens and plays the
// matching sound (so far for some of them).

export type Cue =
  /** A capturing unit lands each of its hops. */
  | 'capture-hop'
  /** A building changed hands. */
  | 'captured'
  /** A shot leaves the barrel (detail: the firing unit's type, e.g. 'rifle', 'htank'). */
  | 'fire'
  /** A shot lands (detail: the firing unit's type). */
  | 'impact'
  /** A unit is destroyed. */
  | 'explosion'
  /**
   * A bridge was built, cracked, repaired or destroyed (detail: the type of the unit that
   * did it, when the player could see that unit; otherwise no detail).
   */
  | 'bridge-built' | 'bridge-cracked' | 'bridge-repaired' | 'bridge-destroyed';

type Listener = (cue: Cue, detail?: string) => void;
const listeners = new Set<Listener>();

/** Listen for cues; returns a function that stops listening. */
export function onCue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function cue(name: Cue, detail?: string) {
  for (const listener of listeners) listener(name, detail);
}
