// Custom unit sets: kept in this browser (localStorage) and exportable as files,
// like custom maps.

import { upgradeUnitSet, validateUnitSet, type UnitSetData } from '../core/unitSets';

const CUSTOM_KEY = 'iron-front.unitSets';
const LAST_PICK_KEY = 'iron-front.unitSetPick';
const FILE_VERSION = 1;

/** A saved set, with an id so it can be renamed without losing track of it. */
export interface StoredUnitSet extends UnitSetData {
  id: string;
}

export function listUnitSets(): StoredUnitSet[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const sets = raw ? (JSON.parse(raw) as StoredUnitSet[]) : [];
    // (Sets saved before newer units existed get those units at their Standard values.)
    return Array.isArray(sets) ? sets.map(upgradeUnitSet).filter(s => typeof s?.id === 'string' && validateUnitSet(s).length === 0) : [];
  } catch {
    return [];
  }
}

export const newUnitSetId = () => `units-${Date.now().toString(36)}`;

/** Save (or overwrite by id). Returns an error message if storage failed. */
export function saveUnitSet(set: StoredUnitSet): string | null {
  const sets = listUnitSets().filter(s => s.id !== set.id);
  sets.push(set);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(sets));
    return null;
  } catch {
    return "Couldn't save in this browser (storage full or blocked). Use Export to save a file instead.";
  }
}

export function deleteUnitSet(id: string) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(listUnitSets().filter(s => s.id !== id)));
  } catch {
    // ignore
  }
}

/** The set last picked on the setup screen ("" = Standard). */
export function lastUnitSetPick(): string {
  try {
    return localStorage.getItem(LAST_PICK_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberUnitSetPick(id: string) {
  try {
    localStorage.setItem(LAST_PICK_KEY, id);
  } catch {
    // just a convenience
  }
}

export function exportUnitSetFile(set: UnitSetData) {
  const { name, units, damage } = set;
  const blob = new Blob([JSON.stringify({ game: 'iron-front-units', version: FILE_VERSION, set: { name, units, damage } }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'units'}.iron-units.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseUnitSetFile(text: string): UnitSetData {
  let data: { game?: string; version?: number; set?: UnitSetData };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a valid unit set (couldn't read it).");
  }
  if (data?.game !== 'iron-front-units' || !data.set) throw new Error("That file isn't an Iron Front unit set.");
  if ((data.version ?? 0) > FILE_VERSION) throw new Error('That unit set is from a newer version of the game.');
  const problems = validateUnitSet(upgradeUnitSet(data.set));
  if (problems.length) throw new Error(`That unit set can't be used: ${problems[0]}`);
  return data.set;
}

export function pickUnitSetFile(): Promise<UnitSetData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        resolve(parseUnitSetFile(await file.text()));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
