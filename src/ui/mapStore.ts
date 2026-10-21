// Custom maps: kept in this browser (localStorage) and exportable as files.

import { BUILTIN_MAPS, type MapDef } from '../core/maps';
import { checkMap } from '../core/mapTools';

const CUSTOM_KEY = 'iron-front.customMaps';
const MAP_FILE_VERSION = 1;

export function listCustomMaps(): MapDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const maps = raw ? (JSON.parse(raw) as MapDef[]) : [];
    return Array.isArray(maps) ? maps.filter(m => checkMap(m) === null) : [];
  } catch {
    return [];
  }
}

/** Built-in maps first, then this browser's custom maps. */
export function allMaps(): MapDef[] {
  return [...BUILTIN_MAPS, ...listCustomMaps()];
}

export const isBuiltin = (id: string) => BUILTIN_MAPS.some(m => m.id === id);

/** Save (or overwrite by id). Returns an error message if storage failed. */
export function saveCustomMap(map: MapDef): string | null {
  const maps = listCustomMaps().filter(m => m.id !== map.id);
  maps.push(map);
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(maps));
    return null;
  } catch {
    return "Couldn't save in this browser (storage full or blocked). Use Export to save a file instead.";
  }
}

export function deleteCustomMap(id: string) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(listCustomMaps().filter(m => m.id !== id)));
  } catch {
    // ignore
  }
}

export { checkMap };

export function exportMapFile(map: MapDef) {
  const blob = new Blob([JSON.stringify({ game: 'iron-front-map', version: MAP_FILE_VERSION, map }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${map.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'map'}.iron-map.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseMapFile(text: string): MapDef {
  let data: { game?: string; version?: number; map?: MapDef };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a valid map (couldn't read it).");
  }
  if (data?.game !== 'iron-front-map' || !data.map) throw new Error("That file isn't an Iron Front map.");
  if ((data.version ?? 0) > MAP_FILE_VERSION) throw new Error('That map is from a newer version of the game.');
  const problem = checkMap(data.map);
  if (problem) throw new Error(`That map can't be used: ${problem}`);
  return data.map;
}

export function pickMapFile(): Promise<MapDef> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        resolve(parseMapFile(await file.text()));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
