// Zoomable, scrollable camera shared by the game and the map editor.
//
//   Mouse wheel          zoom in/out toward the cursor
//   Drag                 scroll (left button in the game, middle button or
//                        Space + left button in the editor)
//   Arrow keys / WASD    scroll
//   − / + / Fit buttons  on-screen zoom controls (top-right of the board)

import Phaser from 'phaser';

/** Tiles never get bigger than this many screen pixels. */
const MAX_TILE_PX = 72;
/** When a map would be smaller than this per tile at "fit", start zoomed in instead. */
const COMFY_TILE_PX = 34;
const KEY_SCROLL_PX = 700; // per second, in screen pixels
const DRAG_THRESHOLD = 8;

export interface MapCameraOptions {
  tile: number;
  /** Which mouse button drags the map: the game uses left, the editor middle (or Space + left). */
  dragWithLeft: boolean;
}

export class MapCamera {
  private worldW: number;
  private worldH: number;
  private down: { x: number; y: number; scrollX: number; scrollY: number } | null = null;
  /** True once the current press moved far enough to count as a drag (so it isn't a click). */
  dragged = false;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private controls: HTMLElement;

  constructor(private scene: Phaser.Scene, worldW: number, worldH: number, private opts: MapCameraOptions) {
    this.worldW = worldW;
    this.worldH = worldH;
    const input = scene.input;

    input.on('wheel', (p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => {
      // Proportional to the scroll distance: a mouse notch (~100) is ~15%, while a
      // trackpad's stream of tiny deltas zooms smoothly instead of racing.
      const delta = Phaser.Math.Clamp(dy, -300, 300);
      this.zoomTo(this.cam.zoom * Math.exp(-delta * 0.0014), p.x, p.y);
    });

    input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.dragged = false;
      if (this.isDragButton(p)) {
        this.down = { x: p.x, y: p.y, scrollX: this.cam.scrollX, scrollY: this.cam.scrollY };
      }
    });
    input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.down || !p.isDown) return;
      const dx = p.x - this.down.x;
      const dy = p.y - this.down.y;
      if (!this.dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.dragged = true;
      this.cam.scrollX = this.down.scrollX - dx / this.cam.zoom;
      this.cam.scrollY = this.down.scrollY - dy / this.cam.zoom;
      this.clamp();
    });
    const release = () => { this.down = null; };
    input.on('pointerup', release);
    input.on('pointerupoutside', release);

    // Keys without "capture", so typing in text boxes (e.g. the map name) still works.
    const kb = input.keyboard;
    if (kb) {
      for (const k of ['LEFT', 'RIGHT', 'UP', 'DOWN', 'W', 'A', 'S', 'D', 'SPACE'] as const) {
        this.keys[k] = kb.addKey(Phaser.Input.Keyboard.KeyCodes[k], false);
      }
    }
    scene.events.on('update', (_t: number, dt: number) => this.updateKeys(dt));

    // In the editor, Space means "scroll". Stop it from also pressing whichever
    // button was clicked last (e.g. "New"), which browsers do by default.
    const guard = (e: KeyboardEvent) => {
      if (!opts.dragWithLeft && e.code === 'Space' && document.activeElement instanceof HTMLButtonElement) e.preventDefault();
    };
    window.addEventListener('keydown', guard);
    window.addEventListener('keyup', guard);

    // If you were looking at the whole map, keep showing the whole map after a resize.
    let lastFit = this.fitZoomFor(this.cam.width, this.cam.height);
    const onResize = (size: Phaser.Structs.Size) => {
      const wasFit = Math.abs(this.cam.zoom - lastFit) < 0.01;
      this.cam.setSize(size.width, size.height);
      lastFit = this.fitZoom();
      if (wasFit) this.fit();
      else this.clamp();
    };
    scene.scale.on('resize', onResize);

    this.controls = this.buildControls();

    // Clean up page-level listeners and the buttons when the scene or the whole game goes away.
    let tornDown = false;
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      window.removeEventListener('keydown', guard);
      window.removeEventListener('keyup', guard);
      scene.scale.off('resize', onResize);
      this.controls.remove();
    };
    scene.events.once('shutdown', teardown);
    scene.events.once('destroy', teardown);
    this.reset();
  }

  private get cam() {
    return this.scene.cameras.main;
  }

  /** True if this press is meant for scrolling (middle button, or Space held in the editor). */
  isPanPress(p: Phaser.Input.Pointer) {
    return p.middleButtonDown() || (!this.opts.dragWithLeft && !!this.keys.SPACE?.isDown);
  }

  private isDragButton(p: Phaser.Input.Pointer) {
    if (p.middleButtonDown()) return true;
    if (!p.leftButtonDown()) return false;
    return this.opts.dragWithLeft || !!this.keys.SPACE?.isDown;
  }

  private typing() {
    const el = document.activeElement;
    return !!el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  }

  private updateKeys(dt: number) {
    if (this.typing()) return;
    const k = this.keys;
    const dx = (k.RIGHT?.isDown || k.D?.isDown ? 1 : 0) - (k.LEFT?.isDown || k.A?.isDown ? 1 : 0);
    const dy = (k.DOWN?.isDown || k.S?.isDown ? 1 : 0) - (k.UP?.isDown || k.W?.isDown ? 1 : 0);
    if (!dx && !dy) return;
    const step = (KEY_SCROLL_PX * dt) / 1000 / this.cam.zoom;
    this.cam.scrollX += dx * step;
    this.cam.scrollY += dy * step;
    this.clamp();
  }

  // ------------------------------------------------------------ zoom

  /** Zoom that shows the whole map. */
  private fitZoom() {
    return this.fitZoomFor(this.cam.width, this.cam.height);
  }

  private fitZoomFor(viewW: number, viewH: number) {
    return Math.min(viewW / this.worldW, viewH / this.worldH);
  }

  private zoomLimits() {
    const fit = this.fitZoom();
    return { min: fit, max: Math.max(fit, MAX_TILE_PX / this.opts.tile) };
  }

  /** Zoom keeping the world point under screen position (sx, sy) in place. */
  zoomTo(zoom: number, sx = this.cam.width / 2, sy = this.cam.height / 2) {
    const { min, max } = this.zoomLimits();
    const before = this.cam.getWorldPoint(sx, sy);
    this.cam.setZoom(Phaser.Math.Clamp(zoom, min, max));
    this.cam.preRender(); // refresh worldView so getWorldPoint uses the new zoom
    const after = this.cam.getWorldPoint(sx, sy);
    this.cam.scrollX += before.x - after.x;
    this.cam.scrollY += before.y - after.y;
    this.clamp();
  }

  /** Whole map if it's comfortable to read, otherwise zoomed in to a readable size. */
  reset(focus?: { x: number; y: number }) {
    const fit = this.fitZoom();
    const comfy = COMFY_TILE_PX / this.opts.tile;
    this.cam.setZoom(fit * this.opts.tile >= COMFY_TILE_PX ? fit : Math.max(fit, comfy));
    this.centerOn(focus?.x ?? this.worldW / 2, focus?.y ?? this.worldH / 2);
  }

  fit() {
    this.cam.setZoom(this.fitZoom());
    this.centerOn(this.worldW / 2, this.worldH / 2);
  }

  /** The map changed size (editor resize). */
  setWorldSize(w: number, h: number) {
    this.worldW = w;
    this.worldH = h;
    this.reset();
  }

  // ------------------------------------------------------------ scrolling

  centerOn(x: number, y: number, animate = false) {
    const target = this.clampCenter(x, y);
    if (animate) this.cam.pan(target.x, target.y, 300, 'Sine.easeInOut');
    else this.cam.centerOn(target.x, target.y);
  }

  /** Scroll just enough to bring a world point into view (with a margin of ~2 tiles). */
  ensureVisible(x: number, y: number, animate = true) {
    const v = this.cam.worldView;
    const m = this.opts.tile * 2;
    if (x >= v.x + m && x <= v.right - m && y >= v.y + m && y <= v.bottom - m) return;
    this.centerOn(x, y, animate);
  }

  private clampCenter(x: number, y: number) {
    const viewW = this.cam.width / this.cam.zoom;
    const viewH = this.cam.height / this.cam.zoom;
    // A map smaller than the view stays centered; otherwise keep its edges on screen.
    const cx = this.worldW <= viewW ? this.worldW / 2 : Phaser.Math.Clamp(x, viewW / 2, this.worldW - viewW / 2);
    const cy = this.worldH <= viewH ? this.worldH / 2 : Phaser.Math.Clamp(y, viewH / 2, this.worldH - viewH / 2);
    return { x: cx, y: cy };
  }

  clamp() {
    const { min, max } = this.zoomLimits();
    if (this.cam.zoom < min || this.cam.zoom > max) this.cam.setZoom(Phaser.Math.Clamp(this.cam.zoom, min, max));
    // Phaser zooms around the view's center, so the center is scroll + half the view.
    const c = this.clampCenter(this.cam.scrollX + this.cam.width / 2, this.cam.scrollY + this.cam.height / 2);
    this.cam.centerOn(c.x, c.y);
  }

  /** World position → page (CSS) position, for placing HTML menus next to tiles. */
  toScreen(wx: number, wy: number) {
    const canvas = this.scene.game.canvas;
    const r = canvas.getBoundingClientRect();
    const css = r.width / canvas.width;
    const v = this.cam.worldView;
    return { left: r.left + (wx - v.x) * this.cam.zoom * css, top: r.top + (wy - v.y) * this.cam.zoom * css };
  }

  // ------------------------------------------------------------ on-screen buttons

  private buildControls() {
    const host = this.scene.game.canvas.parentElement!;
    host.style.position = 'relative';
    const box = document.createElement('div');
    box.className = 'zoom-controls';
    box.innerHTML = `
      <button type="button" data-z="out" title="Zoom out (mouse wheel)">−</button>
      <button type="button" data-z="in" title="Zoom in (mouse wheel)">+</button>
      <button type="button" data-z="fit" title="Show the whole map">Fit</button>`;
    box.addEventListener('click', e => {
      const z = (e.target as HTMLElement).dataset.z;
      if (z === 'in') this.zoomTo(this.cam.zoom * 1.3);
      if (z === 'out') this.zoomTo(this.cam.zoom / 1.3);
      if (z === 'fit') this.fit();
    });
    // Don't let clicks on the buttons reach the map.
    box.addEventListener('pointerdown', e => e.stopPropagation());
    host.appendChild(box);
    // Stop the browser's middle-click autoscroll and page scrolling over the map.
    const canvas = this.scene.game.canvas;
    canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    return box;
  }
}
