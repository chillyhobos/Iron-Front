// Phaser scene for the map editor: draws the map being edited and turns
// mouse strokes into paint calls on the MapEditor.

import Phaser from 'phaser';
import { CAPTURE_POINTS, maxHpOf, PLAYER_COLORS } from '../core/data';
import type { EditGrid } from '../core/mapTools';
import type { GameState } from '../core/state';
import { drawTerrain, makeUnitSprite, TILE } from '../game/render';
import { MapCamera } from '../game/camera';

const T = TILE;

export interface EditorHost {
  grid: EditGrid;
  /** Called once the scene exists, so the host can ask it to redraw / resize. */
  attachScene(scene: EditorScene): void;
  /** Mirror images of a tile under the current symmetry setting (for the cursor preview). */
  previewPoints(x: number, y: number): Array<{ x: number; y: number }>;
  beginStroke(): void;
  paint(x: number, y: number, erase: boolean): void;
  endStroke(): void;
  hover(x: number, y: number): void;
}

/** A throwaway GameState so the editor can reuse the game's drawing code. */
export function previewState(g: EditGrid): GameState {
  return {
    width: g.width,
    height: g.height,
    tiles: g.terrain.map((terrain, i) => ({ terrain, owner: g.owner[i] ? g.owner[i] - 1 : null, capture: CAPTURE_POINTS })),
    units: g.units.map((u, i) => ({ id: i + 1, type: u.type, owner: u.slot - 1, x: u.x, y: u.y, hp: maxHpOf(u.type), acted: false })),
    players: PLAYER_COLORS.map((color, i) => ({
      id: i, name: `Player ${i + 1}`, team: i + 1, color, funds: 0, alive: true, ai: false, difficulty: 'medium',
      stats: { built: 0, lost: 0, destroyed: 0, captured: 0, spent: 0, damageDealt: 0 },
    })),
    current: -1,
    day: 1,
    nextUnitId: 1,
    winnerTeam: null,
    log: [],
    mapName: g.name,
  };
}

export class EditorScene extends Phaser.Scene {
  private host!: EditorHost;
  private terrainG!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private cursorG!: Phaser.GameObjects.Graphics;
  private camera!: MapCamera;
  private stroking = false;
  private erasing = false;
  private last: string | null = null;

  constructor() {
    super('editor');
  }

  init(data: { host: EditorHost }) {
    this.host = data.host;
  }

  create() {
    this.terrainG = this.add.graphics();
    this.unitLayer = this.add.container();
    this.cursorG = this.add.graphics();
    this.input.mouse?.disableContextMenu();
    // Left-drag paints here, so scrolling uses the middle button or Space + drag.
    this.camera = new MapCamera(this, this.host.grid.width * T, this.host.grid.height * T, { tile: T, dragWithLeft: false });

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.camera.isPanPress(p)) return;
      const t = this.tileOf(p);
      if (!t) return;
      this.stroking = true;
      this.erasing = p.rightButtonDown();
      this.last = null;
      this.host.beginStroke();
      this.paintAt(t.x, t.y);
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const t = this.tileOf(p);
      if (!t) return;
      this.drawCursor(t.x, t.y);
      this.host.hover(t.x, t.y);
      if (this.stroking && p.isDown) this.paintAt(t.x, t.y);
    });
    const end = () => {
      if (!this.stroking) return;
      this.stroking = false;
      this.host.endStroke();
    };
    this.input.on('pointerup', end);
    this.input.on('pointerupoutside', end);
    this.redraw();
    this.host.attachScene(this);
  }

  private tileOf(p: Phaser.Input.Pointer) {
    const x = Math.floor(p.worldX / T);
    const y = Math.floor(p.worldY / T);
    const g = this.host.grid;
    return x >= 0 && y >= 0 && x < g.width && y < g.height ? { x, y } : null;
  }

  private paintAt(x: number, y: number) {
    const k = `${x},${y}`;
    if (k === this.last) return; // one paint per tile per stroke
    this.last = k;
    this.host.paint(x, y, this.erasing);
  }

  private drawCursor(x: number, y: number) {
    const g = this.cursorG.clear();
    this.host.previewPoints(x, y).forEach((p, i) => {
      g.lineStyle(3, 0xffffff, i === 0 ? 0.95 : 0.45).strokeRect(p.x * T + 1, p.y * T + 1, T - 2, T - 2);
    });
  }

  /** The map was resized or replaced with one of a different size. */
  setWorldSize(width: number, height: number) {
    this.camera?.setWorldSize(width * T, height * T);
  }

  /** Redraw everything from the host's grid (cheap enough for maps up to 40×40). */
  redraw() {
    if (!this.terrainG) return;
    const s = previewState(this.host.grid);
    drawTerrain(this.terrainG, s);
    this.unitLayer.removeAll(true);
    for (const u of s.units) this.unitLayer.add(makeUnitSprite(this, s, u));
  }
}
