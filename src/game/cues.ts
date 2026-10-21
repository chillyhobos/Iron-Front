// Named moments in the game that sound effects (or anything else) can hook into.
// Animations call cue() at the moment something happens on screen, in sync with
// what the player sees, offline and online alike. Nothing listens yet: a sound
// player only needs to call onCue() and play the matching sound.

export type Cue =
  /** A capturing unit lands each of its hops. */
  | 'capture-hop'
  /** A building changed hands. */
  | 'captured'
  /** A shot leaves the barrel (detail: the weapon style, e.g. 'cannon', 'rockets'). */
  | 'fire'
  /** A shot lands (detail: the weapon style). */
  | 'impact'
  /** A unit is destroyed. */
  | 'explosion';

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
