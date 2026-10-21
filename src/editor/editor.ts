// Map editor screen: palette, tools, history and saving. The actual drawing
// and mouse handling live in EditorScene.

import Phaser from 'phaser';
import { PLAYER_COLORS, TERRAIN, UNIT_ORDER, UNITS, type TerrainId, type UnitType } from '../core/data';
import {
  applyBrush, blankGrid, floodFill, fromGrid, mirrorPoints, resizeGrid, snapshot, toGrid, unitIndexAt,
  validateGrid, type Brush, type EditGrid, type Symmetry,
} from '../core/mapTools';
import { TILE } from '../game/render';
import { MODES, mapMode, type MapMode } from '../core/maps';
import { cssColor, escapeHtml } from '../ui/hud';
import {
  allMaps, checkMap, deleteCustomMap, exportMapFile, isBuiltin, listCustomMaps, pickMapFile, saveCustomMap,
} from '../ui/mapStore';
import { EditorScene, type EditorHost } from './EditorScene';

const DRAFT_KEY = 'iron-front.editorDraft';
const HISTORY_LIMIT = 100;

const PAINT_TERRAIN: TerrainId[] = ['plain', 'forest', 'mountain', 'road', 'river', 'bridge', 'sea'];
const BUILDINGS: TerrainId[] = ['city', 'factory', 'hq', 'port', 'airfield'];
const SWATCH: Record<string, string> = {
  plain: '#8cc152', forest: '#2e6b2e', mountain: '#8d6e4c', road: '#cdbf94', river: '#5aa9e6', bridge: '#a07a48', sea: '#3d7cc9',
  city: '#bdbdbd', factory: '#9a9a9a', hq: '#f0b429', port: '#5f8fbf', airfield: '#6f7680',
};

/** What's picked in the palette: "t:forest", "b:hq", "u:rifle" or "erase". */
type PaletteKey = string;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class MapEditor implements EditorHost {
  grid: EditGrid = blankGrid(18, 18);
  private history: string[] = [];
  private strokeStart: string | null = null;
  private sym: Symmetry = 'quad';
  private picked: PaletteKey = 't:forest';
  private slot = 1;
  private game: Phaser.Game | null = null;
  private scene: EditorScene | null = null;
  private keyHandler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
  };

  constructor(private onExit: (playMapId?: string) => void) {
    this.buildPalette();
    $<HTMLSelectElement>('ed-sym').onchange = e => { this.sym = (e.target as HTMLSelectElement).value as Symmetry; };
    $<HTMLInputElement>('ed-name').oninput = e => { this.grid.name = (e.target as HTMLInputElement).value; this.saveDraft(); };
    $('ed-resize').onclick = () => this.resize();
    $('ed-undo').onclick = () => this.undo();
    $('ed-new').onclick = () => this.replaceGrid(this.newGrid(), 'Started a new map.');
    $<HTMLSelectElement>('ed-mode').innerHTML = (Object.keys(MODES) as MapMode[])
      .map(m => `<option value="${m}">${escapeHtml(MODES[m].name)}</option>`).join('');
    $<HTMLSelectElement>('ed-mode').onchange = e => this.changeMode((e.target as HTMLSelectElement).value as MapMode);
    $<HTMLSelectElement>('ed-open').onchange = e => this.openFromList(e.target as HTMLSelectElement);
    $('ed-import').onclick = () => this.importFile();
    $('ed-export').onclick = () => this.exportFile();
    $('ed-delete').onclick = () => this.deleteMap();
    $('ed-save').onclick = () => this.save();
    $('ed-play').onclick = () => { const id = this.save(); if (id) this.close(id); };
    $('ed-back').onclick = () => this.close();
  }

  // ------------------------------------------------------------ open / close

  open() {
    $('setup').classList.add('hidden');
    $('editor').classList.remove('hidden');
    this.grid = this.loadDraft() ?? blankGrid(18, 18);
    this.history = [];
    $<HTMLSelectElement>('ed-sym').value = this.sym;
    document.addEventListener('keydown', this.keyHandler);

    const board = $('editor-board');
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'editor-board',
      width: board.clientWidth || this.grid.width * TILE,
      height: board.clientHeight || this.grid.height * TILE,
      backgroundColor: '#1b2027',
      scale: { mode: Phaser.Scale.RESIZE }, // canvas fills the board; the camera zooms and scrolls
    });
    // The scene registers itself via attachScene() once it's created
    // (scene.add() returns null while the game is still booting).
    this.game.scene.add('editor', EditorScene, true, { host: this });
    // Handy for debugging in the browser console during development (not in built releases).
    if (import.meta.env.DEV) (window as unknown as { ironFrontEditor: Phaser.Game }).ironFrontEditor = this.game;
    this.refreshUi();
  }

  private close(playMapId?: string) {
    document.removeEventListener('keydown', this.keyHandler);
    this.game?.destroy(true);
    this.game = null;
    this.scene = null;
    $('editor').classList.add('hidden');
    this.onExit(playMapId);
  }

  // ------------------------------------------------------------ EditorHost (called by the scene)

  attachScene(scene: EditorScene) {
    this.scene = scene;
  }

  previewPoints(x: number, y: number) {
    return mirrorPoints(this.grid, x, y, this.sym);
  }

  beginStroke() {
    this.strokeStart = snapshot(this.grid);
  }

  endStroke() {
    if (this.strokeStart && this.strokeStart !== snapshot(this.grid)) this.pushHistory(this.strokeStart);
    this.strokeStart = null;
  }

  paint(x: number, y: number, erase: boolean) {
    let changed: boolean;
    if (erase) {
      const brush: Brush = unitIndexAt(this.grid, x, y) !== -1 ? { kind: 'eraseUnit' } : { kind: 'terrain', terrain: 'plain' };
      changed = applyBrush(this.grid, x, y, brush, this.sym);
    } else {
      const brush = this.brush();
      if (!brush) return;
      const fill = $<HTMLInputElement>('ed-fill').checked && brush.kind === 'terrain';
      changed = fill
        ? floodFill(this.grid, x, y, (brush as { terrain: TerrainId }).terrain, this.sym)
        : applyBrush(this.grid, x, y, brush, this.sym);
    }
    if (changed) this.afterChange();
  }

  hover(x: number, y: number) {
    const i = y * this.grid.width + x;
    const owner = this.grid.owner[i];
    const unit = this.grid.units.find(u => u.x === x && u.y === y);
    let text = `(${x}, ${y}) · ${TERRAIN[this.grid.terrain[i]].name}`;
    if (TERRAIN[this.grid.terrain[i]].property) text += owner ? ` · Player ${owner}` : ' · Neutral';
    if (unit) text += ` · ${UNITS[unit.type].name} (Player ${unit.slot})`;
    $('ed-status').textContent = text;
  }

  // ------------------------------------------------------------ tools

  private brush(): Brush | null {
    const [kind, id] = this.picked.split(':');
    if (this.picked === 'erase') return { kind: 'eraseUnit' };
    if (kind === 't') return { kind: 'terrain', terrain: id as TerrainId };
    if (kind === 'b') {
      if (id === 'hq' && !this.slot) return this.warn('An HQ must belong to a player — pick a player color under Owner.');
      return { kind: 'building', terrain: id as TerrainId, slot: this.slot };
    }
    if (!this.slot) return this.warn('Units must belong to a player — pick a player color under Owner.');
    return { kind: 'unit', unitType: id as UnitType, slot: this.slot };
  }

  private warn(message: string): null {
    $('ed-status').innerHTML = `<span style="color:#ffd479">${escapeHtml(message)}</span>`;
    return null;
  }

  private buildPalette() {
    const button = (key: PaletteKey, html: string, title: string) =>
      `<button type="button" data-key="${key}" title="${escapeHtml(title)}">${html}</button>`;
    $('ed-terrain').innerHTML = PAINT_TERRAIN.map(t =>
      button(`t:${t}`, `<span class="chip" style="background:${SWATCH[t]}"></span>${TERRAIN[t].name}`, TERRAIN[t].name)).join('');
    $('ed-buildings').innerHTML = BUILDINGS.map(t =>
      button(`b:${t}`, `<span class="chip" style="background:${SWATCH[t]}"></span>${TERRAIN[t].name}`, TERRAIN[t].name)).join('');
    $('ed-units').innerHTML = UNIT_ORDER.map(u =>
      button(`u:${u}`, `<span class="tag">${UNITS[u].label}</span>${UNITS[u].name}`, UNITS[u].name)).join('') +
      button('erase', '<span class="tag">✕</span>Remove unit', 'Remove unit');
    $('ed-owner').innerHTML =
      `<button type="button" data-slot="0" title="Neutral"><span class="chip" style="background:#bdbdbd"></span></button>` +
      PLAYER_COLORS.map((c, i) =>
        `<button type="button" data-slot="${i + 1}" title="Player ${i + 1}"><span class="chip" style="background:${cssColor(c)}"></span></button>`).join('');

    document.querySelectorAll<HTMLButtonElement>('#editor-panel [data-key]').forEach(b => {
      b.onclick = () => { this.picked = b.dataset.key!; this.refreshPalette(); };
    });
    document.querySelectorAll<HTMLButtonElement>('#ed-owner [data-slot]').forEach(b => {
      b.onclick = () => { this.slot = Number(b.dataset.slot); this.refreshPalette(); };
    });
  }

  private refreshPalette() {
    // Players 5–6 only exist on 3 vs 3 maps.
    const maxSlot = MODES[mapMode(this.grid)].slots.length;
    if (this.slot > maxSlot) this.slot = 1;
    document.querySelectorAll<HTMLButtonElement>('#editor-panel [data-key]').forEach(b =>
      b.classList.toggle('active', b.dataset.key === this.picked));
    document.querySelectorAll<HTMLButtonElement>('#ed-owner [data-slot]').forEach(b => {
      const slot = Number(b.dataset.slot);
      b.classList.toggle('active', slot === this.slot);
      b.classList.toggle('hidden', slot > maxSlot);
      if (slot && mapMode(this.grid) === '3v3') b.title = `Player ${slot} (${slot <= 3 ? 'West' : 'East'} team)`;
      else if (slot) b.title = `Player ${slot}`;
    });
  }

  /** New blank map of the selected type: 3 vs 3 maps start bigger. */
  private newGrid(): EditGrid {
    const mode = ($<HTMLSelectElement>('ed-mode').value || 'standard') as MapMode;
    const g = mode === '3v3' ? blankGrid(32, 23) : blankGrid(18, 18);
    g.mode = mode;
    return g;
  }

  private changeMode(mode: MapMode) {
    if (mode === mapMode(this.grid)) return;
    const next = JSON.parse(snapshot(this.grid)) as EditGrid;
    next.mode = mode;
    this.replaceGrid(next, mode === '3v3'
      ? 'Map type: 3 vs 3. Place an HQ for all six players: 1–3 (West) and 4–6 (East). Tip: use Left ↔ Right mirroring.'
      : 'Map type: Standard (2–4 players).');
  }

  // ------------------------------------------------------------ history & changes

  private pushHistory(state: string) {
    this.history.push(state);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    $<HTMLButtonElement>('ed-undo').disabled = false;
  }

  private undo() {
    const prev = this.history.pop();
    if (!prev) return;
    const restored = JSON.parse(prev) as EditGrid;
    const sizeChanged = restored.width !== this.grid.width || restored.height !== this.grid.height;
    // Undo is for painting; keep whatever name was typed since.
    if (restored.id === this.grid.id) restored.name = this.grid.name;
    this.grid = restored;
    if (sizeChanged) this.scene?.setWorldSize(this.grid.width, this.grid.height);
    this.afterChange();
    this.refreshUi();
  }

  private replaceGrid(next: EditGrid, message: string) {
    this.pushHistory(snapshot(this.grid));
    const sizeChanged = next.width !== this.grid.width || next.height !== this.grid.height;
    this.grid = next;
    if (sizeChanged) this.scene?.setWorldSize(next.width, next.height);
    this.afterChange();
    this.refreshUi();
    $('ed-status').textContent = message;
  }

  private afterChange() {
    this.scene?.redraw();
    this.refreshCheck();
    this.saveDraft();
  }

  private resize() {
    const w = Number($<HTMLInputElement>('ed-w').value);
    const h = Number($<HTMLInputElement>('ed-h').value);
    this.replaceGrid(resizeGrid(this.grid, w, h), 'Resized the map.');
  }

  // ------------------------------------------------------------ UI refresh

  private refreshUi() {
    $<HTMLInputElement>('ed-name').value = this.grid.name;
    $<HTMLInputElement>('ed-w').value = String(this.grid.width);
    $<HTMLInputElement>('ed-h').value = String(this.grid.height);
    $<HTMLSelectElement>('ed-mode').value = mapMode(this.grid);
    $<HTMLButtonElement>('ed-undo').disabled = this.history.length === 0;
    $<HTMLButtonElement>('ed-delete').disabled = !listCustomMaps().some(m => m.id === this.grid.id);
    const open = $<HTMLSelectElement>('ed-open');
    open.innerHTML = '<option value="">Open map…</option>' + allMaps().map(m =>
      `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}${mapMode(m) === '3v3' ? ' · 3 vs 3' : ''}${isBuiltin(m.id) ? ' (built-in)' : ''}</option>`).join('');
    this.refreshPalette();
    this.refreshCheck();
  }

  private refreshCheck() {
    const v = validateGrid(this.grid);
    const items = [
      ...v.errors.map(e => `<li class="bad">${escapeHtml(e)}</li>`),
      ...v.warnings.map(w => `<li class="warn">${escapeHtml(w)}</li>`),
    ];
    const ready = v.errors.length === 0
      ? mapMode(this.grid) === '3v3'
        ? '<div class="good">✓ Playable as 3 vs 3 (West 1–3 vs East 4–6).</div>'
        : `<div class="good">✓ Playable with ${v.slots.length === 2 ? '2' : `2–${v.slots.length}`} players.</div>`
      : '';
    $('ed-check').innerHTML = ready + (items.length ? `<ul>${items.join('')}</ul>` : '');
  }

  // ------------------------------------------------------------ saving

  /** Save to this browser. Returns the map id, or null if the map isn't playable yet. */
  private save(): string | null {
    const map = fromGrid(this.grid);
    const problem = checkMap(map);
    if (problem) {
      this.warn(`Can't save yet: ${problem}`);
      return null;
    }
    const err = saveCustomMap(map);
    if (err) {
      this.warn(err);
      return null;
    }
    $('ed-status').innerHTML = `<span style="color:#8fdf8f">Saved “${escapeHtml(map.name)}”. It's now in the map list.</span>`;
    this.refreshUi();
    return map.id;
  }

  private exportFile() {
    const map = fromGrid(this.grid);
    const problem = checkMap(map);
    if (problem) return void this.warn(`Can't export yet: ${problem}`);
    exportMapFile(map);
  }

  private importFile() {
    pickMapFile()
      .then(map => {
        const g = toGrid(map);
        if (isBuiltin(g.id)) g.id = blankGrid(1, 1).id;
        this.replaceGrid(g, `Imported “${map.name}”. Click Save to add it to your map list.`);
      })
      .catch((e: Error) => this.warn(e.message));
  }

  private openFromList(select: HTMLSelectElement) {
    const map = allMaps().find(m => m.id === select.value);
    select.value = '';
    if (!map) return;
    const g = toGrid(map);
    if (isBuiltin(map.id)) {
      // Built-in maps open as a copy so the originals stay intact.
      g.id = blankGrid(1, 1).id;
      g.name = `${map.name} (copy)`;
    }
    this.replaceGrid(g, `Opened “${g.name}”.`);
  }

  private deleteMap() {
    if (!listCustomMaps().some(m => m.id === this.grid.id)) return;
    if (!confirm(`Delete “${this.grid.name}” from your saved maps? This can't be undone.`)) return;
    deleteCustomMap(this.grid.id);
    this.replaceGrid(this.newGrid(), 'Map deleted.');
  }

  // ------------------------------------------------------------ draft (unsaved work survives reloads)

  private saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, snapshot(this.grid));
    } catch {
      // ignore — drafts are a convenience
    }
  }

  private loadDraft(): EditGrid | null {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return null;
      const g = JSON.parse(raw) as EditGrid;
      return g.terrain?.length === g.width * g.height ? g : null;
    } catch {
      return null;
    }
  }
}
