// Saving and loading. The whole game is one plain-JSON GameState, so a save
// is just that object plus a small header.

import type { GameState } from '../core/state';
import { upgradeUnitSet, validateUnitSet } from '../core/unitSets';

const AUTOSAVE_KEY = 'iron-front.autosave';
/** Up to 6 armies (3 vs 3 mode). */
const MAX_PLAYERS = 6;
/** Bump when GameState changes shape in a way old saves can't load. */
const SAVE_VERSION = 1;

interface SaveFile {
  game: 'iron-front';
  version: number;
  savedAt: string;
  state: GameState;
}

function serialize(state: GameState): string {
  const save: SaveFile = { game: 'iron-front', version: SAVE_VERSION, savedAt: new Date().toISOString(), state };
  return JSON.stringify(save);
}

/** Parse and sanity-check a save. Throws an Error with a player-friendly message. */
export function parseSave(text: string): GameState {
  let save: SaveFile;
  try {
    save = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a valid save (couldn't read it).");
  }
  if (save?.game !== 'iron-front' || !save.state) throw new Error("That file isn't an Iron Front save.");
  if (save.version > SAVE_VERSION) throw new Error('That save is from a newer version of the game.');
  const s = save.state;
  const ok = Number.isInteger(s.width) && Number.isInteger(s.height) &&
    Array.isArray(s.tiles) && s.tiles.length === s.width * s.height &&
    Array.isArray(s.units) && Array.isArray(s.players) && s.players.length >= 2 && s.players.length <= MAX_PLAYERS &&
    s.current >= 0 && s.current < s.players.length;
  if (!ok) throw new Error('That save file is damaged.');
  if (s.unitSet && validateUnitSet(upgradeUnitSet(s.unitSet)).length) throw new Error("That save's custom unit set is damaged.");
  return s;
}

// ---------------------------------------------------------------- autosave (this browser only)

export function writeAutosave(state: GameState) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, serialize(state));
  } catch {
    // Storage full or blocked (private window) — the game still works, just without autosave.
  }
}

export function readAutosave(): GameState | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? parseSave(text) : null;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- save files (portable)

export function downloadSave(state: GameState) {
  const blob = new Blob([serialize(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const map = (state.mapName ?? 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  a.href = url;
  a.download = `iron-front-${map}-day${state.day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and resolves with the loaded game (rejects with a readable Error). */
export function pickSaveFile(): Promise<GameState> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        resolve(parseSave(await file.text()));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
