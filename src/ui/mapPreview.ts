// A small map preview for the setup screen: one coloured square per tile, buildings in
// the colour of the army that starts with them (for the chosen player count; unused
// armies' buildings are neutral, as in the game) and any starting units as dots.
// Plain 2D canvas, so redrawing it whenever a setting changes is cheap.

import { PLAYER_COLORS, TERRAIN, type TerrainId } from '../core/data';
import type { MapDef } from '../core/maps';
import { cssColor } from './hud';

/** Drawing pixels per tile; the page shrinks the canvas to fit (see .map-preview in style.css). */
const TILE = 8;

const GROUND: Partial<Record<TerrainId, string>> = {
  plain: '#8cc65a', forest: '#3f7f3a', mountain: '#9a7a56', road: '#d2c59b',
  sea: '#3a78c4', river: '#4a97df', bridge: '#a07a48',
};
const NEUTRAL = '#c9ced6';
const OUTLINE = 'rgba(0, 0, 0, 0.45)';

const BY_CHAR = new Map(Object.entries(TERRAIN).map(([id, t]) => [t.char, id as TerrainId]));

/** Draw `map` as it starts with these slots in play; returns a one-line description of it. */
export function drawMapPreview(canvas: HTMLCanvasElement, map: MapDef, slots: number[]): string {
  const h = map.terrain.length, w = map.terrain[0].length;
  canvas.width = w * TILE;
  canvas.height = h * TILE;
  const g = canvas.getContext('2d');
  if (!g) return '';
  const ownerOf = (x: number, y: number) => {
    const slot = Number(map.owners[y]?.[x]);
    return slot && slots.includes(slot) ? slot : 0;
  };
  const count: Partial<Record<TerrainId, number>> = {};
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = BY_CHAR.get(map.terrain[y][x]) ?? 'plain';
      const px = x * TILE, py = y * TILE;
      if (!TERRAIN[id].property) {
        g.fillStyle = GROUND[id] ?? GROUND.plain!;
        g.fillRect(px, py, TILE, TILE);
        continue;
      }
      // Buildings: grass underneath, then the building in its owner's colour.
      const owner = ownerOf(x, y);
      const kind = id === 'hq' && !owner ? 'city' : id; // an unused army's HQ becomes a city
      count[kind] = (count[kind] ?? 0) + 1;
      g.fillStyle = GROUND.plain!;
      g.fillRect(px, py, TILE, TILE);
      g.fillStyle = owner ? cssColor(PLAYER_COLORS[owner - 1]) : NEUTRAL;
      g.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
      g.strokeStyle = OUTLINE;
      g.lineWidth = 1;
      g.strokeRect(px + 1.5, py + 1.5, TILE - 3, TILE - 3);
      // A mark so HQs and production buildings stand out from cities.
      if (kind === 'hq') {
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(px + TILE / 2, py + TILE / 2, TILE * 0.2, 0, Math.PI * 2);
        g.fill();
      } else if (kind !== 'city') {
        g.fillStyle = 'rgba(0, 0, 0, 0.55)';
        g.fillRect(px + TILE * 0.35, py + TILE * 0.35, TILE * 0.3, TILE * 0.3);
      }
    }
  }
  // Starting units (only for armies in play).
  for (const u of map.units ?? []) {
    if (!slots.includes(u.slot)) continue;
    g.fillStyle = cssColor(PLAYER_COLORS[u.slot - 1]);
    g.strokeStyle = '#161616';
    g.beginPath();
    g.arc(u.x * TILE + TILE / 2, u.y * TILE + TILE / 2, TILE * 0.32, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  const words: Array<[TerrainId, string, string]> = [['city', 'city', 'cities'], ['factory', 'factory', 'factories'], ['port', 'port', 'ports'], ['airfield', 'airfield', 'airfields']];
  const parts = words.filter(([t]) => count[t]).map(([t, one, many]) => `${count[t]} ${count[t] === 1 ? one : many}`);
  return `Map preview: ${map.name}, ${w}×${h}${parts.length ? ', ' + parts.join(', ') : ''}`;
}
