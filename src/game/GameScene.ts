// The Phaser scene: draws the map and units with placeholder art and turns
// clicks into Actions for the rules engine.

import Phaser from 'phaser';
import { CAPTURE_POINTS, maxHpOf, TERRAIN, UNITS } from '../core/data';
import {
  applyAction, boardingTarget, bridgeTargetsFrom, canBuildBridge, canCapture, canSee, demolishTargetsFrom, repairTargetsFrom, currentPlayer, destinations, displayHp, dropTiles, forecast,
  inBounds, pathTo,
  posKey, reachable, startTurn, targetsFrom, threatTiles, tileAt, unitAt, unitById, unitMaxRange, unitMove,
  unitVision, visibleTiles, walkPath,
  type Reach, type Vision,
} from '../core/rules';
import { nextAiAction } from '../core/ai';
import { canUsePower, commanderOf } from '../core/commanders';
import type { Action, Command, Difficulty, GameEvent, GameState, Pos, Tile, Unit } from '../core/state';
import type { UnitType } from '../core/data';
import { controlLabel, escapeHtml, type Hud } from '../ui/hud';
import { clearAutosave, downloadOnlineSave, downloadSave, writeAutosave } from '../ui/saves';
import { forgetSession, type OnlineLink } from '../net/client';
import type { SeatStatus } from '../net/protocol';
import type { MoveAnim } from '../core/view';
import { ANIM_CAPTURE_MS, ANIM_STEP_MS, animMs, COUNTER_PAUSE_MS } from '../core/timing';
import { AttackFx } from './attackFx';
import { drawTerrain, isLowFuel, makeUnitSprite, TILE } from './render';
import { MapCamera } from './camera';
import { cue } from './cues';
import { sound } from './sound';

export { TILE };
const T = TILE;
/** Pause between computer actions, in ms. */
const AI_DELAY = 280;

type Mode = 'locked' | 'idle' | 'selected' | 'animating' | 'menu' | 'target' | 'bridgeTarget' | 'unload';

interface Selection {
  unit: Unit;
  reach: Reach;
  dests: Set<string>;
  /** Enemy unit ids this unit could attack this turn. */
  threats: Set<number>;
}

export class GameScene extends Phaser.Scene {
  private s!: GameState;
  private hud!: Hud;
  private terrainG!: Phaser.GameObjects.Graphics;
  private fogG!: Phaser.GameObjects.Graphics;
  private camera!: MapCamera;
  private overlayG!: Phaser.GameObjects.Graphics;
  private cursorG!: Phaser.GameObjects.Graphics;
  private unitLayer!: Phaser.GameObjects.Container;
  private fx!: AttackFx;
  /** An attack whose shots are flying or about to land: its result plays as a battle (hit, return fire). */
  private attackCtx: { attackerId: number; defenderId: number } | null = null;
  /**
   * The type of the unit whose action is being shown, when the player could see it
   * (sounds use it, e.g. an Engineer blowing up a bridge). pendingActor: our own
   * online action, until the server's answer is shown.
   */
  private actorType: UnitType | undefined;
  private pendingActor: UnitType | undefined;
  private sprites = new Map<number, Phaser.GameObjects.Container>();

  private mode: Mode = 'locked';
  private sel: Selection | null = null;
  private pending: {
    to: Pos;
    targets: Unit[];
    /** Bridges this unit could fire at from `to` (Bomber, Artillery, Rockets). */
    bridgeTargets: Pos[];
    /** Bridges next to `to` an Engineer could blow up, or (from the bank) repair. */
    demolishTargets: Pos[];
    repairTargets: Pos[];
    /** Picking a bridge: to shell it, or (Engineer) to blow it up or repair it. */
    aim?: 'strike' | 'demolish' | 'repair';
    /** Unloading in progress: passengers placed so far, the one being placed, and where it may go. */
    drops?: Array<{ cargoId: number; x: number; y: number }>;
    unloading?: Unit;
    dropOptions?: Pos[];
  } | null = null;
  private inspect: { move: Set<string>; danger: Set<string> } | null = null;
  private hover: Pos | null = null;
  private resumed = false;
  /** Snapshots of the state before each of the current human player's actions this turn. */
  private undoStack: string[] = [];
  /**
   * Fog of war: whose eyes the board is drawn through — the human whose turn
   * it is, or the last human to play during CPU turns. Null = see everything.
   */
  private viewerTeam: number | null = null;
  private vision: Vision = null;
  /** Which human (player id of the army's commander) last took a turn; skips needless handover screens. */
  private lastHuman: number | null = null;
  /** Online play: the link to the game server (null = hot-seat on this device). */
  private online: OnlineLink | null = null;
  private onlineStartEvents: GameEvent[] = [];
  /** Online: server updates waiting to be shown, and whether one is playing now. */
  private serverQueue: Array<{ state: GameState; events: GameEvent[]; anim?: MoveAnim }> = [];
  private playingServer = false;

  constructor() {
    super('game');
  }

  init(data: { state: GameState; hud: Hud; resumed?: boolean; online?: { link: OnlineLink; events: GameEvent[] } }) {
    this.s = data.state;
    this.hud = data.hud;
    this.resumed = !!data.resumed;
    this.online = data.online?.link ?? null;
    this.onlineStartEvents = data.online?.events ?? [];
  }

  /** Online: it's this browser's turn. (Offline every human turn is "ours".) */
  /** Offline always; online when it's our army's turn, or (3 vs 3) a teammate's army we play. */
  private myTurn(): boolean {
    if (!this.online) return true;
    return this.s.current === this.online.seat || this.s.players[this.s.current]?.controller === this.online.seat;
  }

  /**
   * Online: the server sent a new state (after our move, someone else's, or a reconnect).
   * Updates play one at a time, in order: first the move that led there (a unit walking
   * its path, its target flashing), then the new state with its hits and explosions.
   */
  private fromServer(state: GameState, events: GameEvent[], anim?: MoveAnim) {
    this.serverQueue.push({ state, events, anim });
    if (!this.playingServer) this.nextFromServer();
  }

  private nextFromServer() {
    const next = this.serverQueue.shift();
    this.playingServer = !!next;
    if (!next) return;
    const show = () => this.applyServer(next.state, next.events, () => this.nextFromServer(), next.anim?.unitType);
    // Running behind (a slow tab, or one that was hidden): skip animations to catch up.
    if (next.anim && !document.hidden && this.serverQueue.length < 3) this.animateMove(next.anim, show);
    else show();
  }

  /** Someone else's move, as the server described it: walk the unit along its path, then it fires or hops. */
  private animateMove(anim: MoveAnim, onDone: () => void) {
    const sprite = this.sprites.get(anim.unitId);
    // If the browser isn't drawing frames (window covered, tab in the background) the tween
    // never ends; don't let that hold up the game: show the result after a while anyway.
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(watchdog);
      onDone();
    };
    const watchdog = window.setTimeout(() => {
      if (sprite) this.tweens.killTweensOf(sprite);
      done();
    }, animMs(anim) + 1000);
    const afterMove = () => {
      if (anim.capture) return this.captureHop(anim.unitId, done);
      const target = anim.targetId !== undefined ? unitById(this.s, anim.targetId) : undefined;
      if (!target || !this.sprites.has(target.id)) return done();
      this.attackCtx = { attackerId: anim.unitId, defenderId: target.id };
      this.fireAt(anim.unitId, target, done);
    };
    if (!sprite || anim.path.length <= 1) return afterMove();
    const end = anim.path[anim.path.length - 1];
    this.camera.ensureVisible(end.x * T + T / 2, end.y * T + T / 2);
    this.walk(anim.unitType, sprite, anim.path, ANIM_STEP_MS, afterMove);
  }

  /** Show a server update: a battle first if it was an attack, then the new state. */
  private applyServer(state: GameState, events: GameEvent[], done: () => void, actorType?: UnitType) {
    // Who acted: from the move (someone else's), or our own action the server is answering.
    this.actorType = actorType ?? this.pendingActor;
    this.pendingActor = undefined;
    this.s = state;
    this.sel = null;
    this.pending = null;
    this.inspect = null;
    this.hud.hideActionMenu();
    this.mode = 'animating';
    this.resolveBattle(events, shown => {
      this.mode = this.myTurn() ? 'idle' : 'locked'; // (turn and game-over events adjust this)
      this.refresh();
      this.handleEvents(events.filter(e => !shown.has(e)));
      this.actorType = undefined;
      done();
    });
  }

  // ------------------------------------------------------------ battles

  /** A unit fires its weapon at a tile; done when the shots land. Instant if it can't be seen. */
  private fireAt(attackerId: number, at: Pos, done: () => void) {
    const u = unitById(this.s, attackerId);
    const sprite = this.sprites.get(attackerId);
    if (!u || !sprite || document.hidden) return done();
    const to = { x: at.x * T + T / 2, y: at.y * T + T / 2 };
    this.camera.ensureVisible(to.x, to.y);
    this.fx.fire(u.type, { x: sprite.x, y: sprite.y }, to, sprite, done);
  }

  /**
   * After an attack's shots land (attackCtx set) and its result is known: show the hit on
   * the defender, and if it survived and fired back, play its shots and then the hit on
   * the attacker. The map isn't redrawn until the end, so a unit destroyed by return fire
   * stays on screen until its explosion. Reports the events it already showed.
   */
  private resolveBattle(events: GameEvent[], done: (shown: Set<GameEvent>) => void) {
    const ctx = this.attackCtx;
    this.attackCtx = null;
    const shown = new Set<GameEvent>();
    if (!ctx || document.hidden) return done(shown);
    const hitsOn = (id: number) => events.filter(e => (e.kind === 'damage' || e.kind === 'destroyed') && e.unitId === id);
    const onDefender = hitsOn(ctx.defenderId);
    if (!onDefender.length || !this.sprites.has(ctx.defenderId)) return done(shown);
    this.showHits(onDefender, shown);
    const onAttacker = hitsOn(ctx.attackerId);
    const firesBack = onAttacker.length > 0 && !!unitById(this.s, ctx.defenderId) && this.sprites.has(ctx.attackerId);
    if (!firesBack) return done(shown);
    const at = onAttacker[0] as Extract<GameEvent, { kind: 'damage' }>;
    this.later(COUNTER_PAUSE_MS, () => this.fireAt(ctx.defenderId, at, () => {
      this.showHits(onAttacker, shown);
      done(shown);
    }));
  }

  private showHits(hits: GameEvent[], shown: Set<GameEvent>) {
    for (const e of hits) {
      shown.add(e);
      this.showEvent(e);
    }
  }

  create() {
    this.terrainG = this.add.graphics();
    this.fogG = this.add.graphics();
    this.overlayG = this.add.graphics();
    this.unitLayer = this.add.container();
    this.fx = new AttackFx(this, this.add.container(), T);
    this.cursorG = this.add.graphics();

    this.input.mouse?.disableContextMenu();
    // The camera listens first, so it can tell a drag (scroll the map) from a click.
    this.camera = new MapCamera(this, this.s.width * T, this.s.height * T, { tile: T, dragWithLeft: true });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { if (p.rightButtonDown()) this.cancel(); });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onClick(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.keyboard?.on('keydown-ESC', () => this.cancel());
    this.input.keyboard?.on('keydown-M', () => sound.setMuted(!sound.muted));
    this.hud.bindSound(sound);
    this.input.keyboard?.on('keydown-Z', (e: KeyboardEvent) => { if (e.ctrlKey || e.metaKey) this.undo(); });
    this.hud.onEndTurn(() => this.endTurn());
    this.hud.onUndo(() => this.undo());
    this.hud.onPower(() => this.usePower());
    this.hud.onSave(() => (this.online ? this.online.requestSave() : downloadSave(this.s)));
    this.hud.onMenu(() => {
      const text = this.online
        ? 'Leave this online game for now? It keeps going on the server: use Rejoin on the main menu to come back.'
        : 'Return to the main menu? Your game is autosaved — use Continue to pick it back up.';
      if (!confirm(text)) return;
      this.online?.leave();
      location.reload();
    });

    if (this.online) {
      // Online: the server runs the game; we draw what it sends and send our moves.
      const link = this.online;
      this.hud.setOnline(link.code, link.seat === link.host);
      link.onSaveFile(file => {
        downloadOnlineSave(file);
        this.hud.flashBanner('Match saved: keep the file and use Resume a saved match to carry on', 0x3fa34d, 3500);
      });
      link.onState((state, evs, anim) => this.fromServer(state, evs, anim));
      link.onPresence((on, seats) => this.showPresence(on, seats));
      link.onError(message => {
        this.hud.showBanner(`⚠ ${message}`, 0xd94848);
        this.later(3000, () => this.hud.showBanner(null));
        if (this.myTurn() && this.mode === 'locked') this.mode = 'idle';
      });
      this.refresh();
      const start = this.onlineStartEvents.length ? this.onlineStartEvents : [{ kind: 'turn' as const, player: this.s.current, day: this.s.day }];
      this.handleEvents(this.s.winnerTeam !== null ? [{ kind: 'gameover', team: this.s.winnerTeam }] : start);
      return;
    }

    let events: GameEvent[];
    if (!this.resumed) {
      events = startTurn(this.s);
    } else if (this.s.winnerTeam !== null) {
      events = [{ kind: 'gameover', team: this.s.winnerTeam }];
    } else {
      // Pick up mid-turn: no income/repairs again, just hand control back.
      this.s.log.push(`Game loaded — Day ${this.s.day}.`);
      events = [{ kind: 'turn', player: this.s.current, day: this.s.day }];
    }
    writeAutosave(this.s);
    this.refresh();
    this.handleEvents(events);
  }

  update() {
    // Keep the order menu next to its tile while the map is scrolled or zoomed.
    if (this.mode === 'menu' && this.pending) {
      const scr = this.tileToScreen(this.pending.to.x + 1, this.pending.to.y);
      this.hud.placeActionMenu(scr.left + 4, scr.top);
    }
  }

  private undo() {
    if (this.mode !== 'idle' || !this.undoStack.length) return;
    this.s = JSON.parse(this.undoStack.pop()!);
    this.inspect = null;
    this.s.log.push('↶ Undid last action.');
    writeAutosave(this.s);
    this.refresh();
  }

  // ------------------------------------------------------------ input

  /** A left click (press and release without dragging the map). */
  private onClick(p: Phaser.Input.Pointer) {
    if (p.button !== 0 || this.camera.dragged) return;
    if (this.mode === 'locked' || this.mode === 'animating') return;
    const x = Math.floor(p.worldX / T);
    const y = Math.floor(p.worldY / T);
    if (!inBounds(this.s, x, y)) return;

    switch (this.mode) {
      case 'idle':
        return this.clickIdle(x, y);
      case 'selected':
        if (this.sel!.dests.has(posKey(x, y))) return this.moveSelected(x, y);
        this.clearSelection();
        return this.clickIdle(x, y);
      case 'menu':
        return this.cancel();
      case 'unload':
        return this.pickDrop(x, y);
      case 'target': {
        const t = this.pending!.targets.find(u => u.x === x && u.y === y);
        if (t) return this.commit({ kind: 'attack', targetId: t.id });
        return this.openMenu();
      }
      case 'bridgeTarget':
        if (this.aimedBridges().some(b => b.x === x && b.y === y)) return this.commit({ kind: this.pending!.aim ?? 'strike', x, y });
        return this.openMenu();
    }
  }

  private onMove(p: Phaser.Input.Pointer) {
    const x = Math.floor(p.worldX / T);
    const y = Math.floor(p.worldY / T);
    if (!inBounds(this.s, x, y)) return;
    if (this.hover && this.hover.x === x && this.hover.y === y) return;
    this.hover = { x, y };
    this.cursorG.clear().lineStyle(3, 0xffffff, 0.9).strokeRect(x * T + 1, y * T + 1, T - 2, T - 2);
    this.updateInfo();
    if (this.mode === 'selected') this.drawOverlay();
  }

  /** The unit on a tile, if the viewer can see it. */
  private visibleUnitAt(x: number, y: number): Unit | undefined {
    const u = unitAt(this.s, x, y);
    return u && this.seesUnit(u) ? u : undefined;
  }

  private seesUnit(u: Unit) {
    return this.viewerTeam === null || canSee(this.s, this.vision, this.viewerTeam, u);
  }

  private seesTile(x: number, y: number) {
    return !this.vision || this.vision.has(y * this.s.width + x);
  }

  private clickIdle(x: number, y: number) {
    const u = this.visibleUnitAt(x, y);
    this.inspect = null;
    if (u && u.owner === this.s.current && !u.acted) return this.select(u);
    if (u) {
      this.inspectUnit(u);
      return this.drawOverlay();
    }
    const tile = tileAt(this.s, x, y);
    // Factories build ground units, ports ships, airfields aircraft.
    const builds = TERRAIN[tile.terrain].builds;
    if (builds && tile.owner === this.s.current) {
      this.mode = 'locked';
      this.hud.showBuild(
        this.s,
        builds,
        TERRAIN[tile.terrain].name,
        unitType => { this.mode = 'idle'; this.submit({ type: 'build', x, y, unitType }); },
        () => { this.mode = 'idle'; },
      );
      return;
    }
    this.drawOverlay();
  }

  private cancel() {
    switch (this.mode) {
      case 'unload':
        return this.openUnloadMenu();
      case 'target':
      case 'bridgeTarget':
        return this.openMenu();
      case 'menu': {
        const u = this.sel!.unit;
        this.sprites.get(u.id)?.setPosition(u.x * T + T / 2, u.y * T + T / 2);
        this.hud.hideActionMenu();
        this.pending = null;
        this.mode = 'selected';
        return this.drawOverlay();
      }
      case 'selected':
        return this.clearSelection();
      case 'idle':
        this.inspect = null;
        return this.drawOverlay();
    }
  }

  private endTurn() {
    if (this.mode === 'locked' || this.mode === 'animating') return;
    if (this.mode === 'menu' || this.mode === 'target' || this.mode === 'bridgeTarget') this.cancel();
    this.clearSelection();
    this.inspect = null;
    this.submit({ type: 'endTurn' });
  }

  // ------------------------------------------------------------ selection & orders

  private select(u: Unit) {
    const reach = reachable(this.s, u);
    const dests = destinations(this.s, u, reach);
    const threats = new Set<number>();
    for (const k of dests) {
      const [x, y] = k.split(',').map(Number);
      const moved = x !== u.x || y !== u.y;
      for (const t of targetsFrom(this.s, u, x, y, moved)) threats.add(t.id);
    }
    this.sel = { unit: u, reach, dests, threats };
    this.mode = 'selected';
    this.drawOverlay();
  }

  private clearSelection() {
    this.sel = null;
    this.pending = null;
    this.hud.hideActionMenu();
    if (this.mode !== 'locked') this.mode = 'idle';
    this.drawOverlay();
  }

  /** Show where an enemy (or spent) unit can move and what it threatens. */
  private inspectUnit(u: Unit) {
    this.inspect = threatTiles(this.s, u);
  }

  private moveSelected(x: number, y: number) {
    const sel = this.sel!;
    const fullPath = pathTo(sel.reach, x, y);
    const sprite = this.sprites.get(sel.unit.id)!;
    this.pending = { to: { x, y }, targets: [], bridgeTargets: [], demolishTargets: [], repairTargets: [] };
    this.overlayG.clear();

    // Fog of war: running into a hidden enemy ends the move right there.
    const { stop, trapped } = walkPath(this.s, sel.unit, fullPath);
    const path = fullPath.slice(0, stop + 1);
    const arrive = () => (trapped ? this.commit({ kind: 'wait' }) : this.openMenu());

    if (path.length <= 1) return arrive();
    this.mode = 'animating';
    this.walk(sel.unit.type, sprite, path, 70, arrive); // (your own moves are a little snappier)
  }

  /**
   * Slide a unit along a path, one tile every `ms`. As each tile is entered, infantry
   * make a footstep by what the ground is (cue 'footstep' with the terrain) and anything
   * else keeps its engine running (cue 'drive' with the unit type), but only on tiles
   * the player can see.
   */
  private walk(type: UnitType, sprite: Phaser.GameObjects.Container, path: Pos[], ms: number, onComplete: () => void) {
    const onFoot = UNITS[type].moveType === 'foot' || UNITS[type].moveType === 'boot';
    const enter = (p: Pos) => {
      if (this.seesTile(p.x, p.y)) cue(onFoot ? 'footstep' : 'drive', onFoot ? tileAt(this.s, p.x, p.y).terrain : type);
    };
    this.tweens.chain({
      targets: sprite,
      tweens: path.slice(1).map(p => ({ x: p.x * T + T / 2, y: p.y * T + T / 2, duration: ms, onStart: () => enter(p) })),
      onComplete,
    });
  }

  private openMenu() {
    const sel = this.sel!;
    const pend = this.pending!;
    const u = sel.unit;
    const { x, y } = pend.to;
    const moved = x !== u.x || y !== u.y;
    pend.targets = targetsFrom(this.s, u, x, y, moved);
    pend.bridgeTargets = bridgeTargetsFrom(this.s, u, x, y, moved);
    pend.demolishTargets = demolishTargetsFrom(this.s, u, x, y);
    pend.repairTargets = repairTargetsFrom(this.s, u, x, y);
    pend.drops = [];

    // Moved onto one of our own transports: the only thing to do there is board it.
    const transport = moved ? boardingTarget(this.s, u, x, y) : undefined;
    if (transport) {
      this.mode = 'menu';
      this.drawOverlay();
      const scr = this.tileToScreen(x + 1, y);
      this.hud.showActionMenu(scr.left + 4, scr.top, [
        { label: `Load into ${UNITS[transport.type].name}`, onClick: () => this.commit({ kind: 'load' }) },
        { label: 'Cancel', onClick: () => this.cancel() },
      ]);
      return;
    }

    const options = [];
    if (u.cargo?.some(c => dropTiles(this.s, u, x, y, c).length)) {
      options.push({ label: 'Unload', onClick: () => this.openUnloadMenu() });
    }
    if (pend.targets.length) {
      options.push({
        label: 'Attack',
        onClick: () => {
          this.hud.hideActionMenu();
          this.mode = 'target';
          this.drawOverlay();
          this.updateInfo();
        },
      });
    }
    if (canCapture(this.s, u, x, y)) {
      const left = tileAt(this.s, x, y).capture;
      options.push({ label: `Capture (${left}/${CAPTURE_POINTS})`, onClick: () => this.commit({ kind: 'capture' }) });
    }
    // Shelling (Bomber/Artillery/Rockets), or an Engineer blowing up or repairing one next to it: pick the bridge.
    const aimAt = (aim: 'strike' | 'demolish' | 'repair') => () => {
      this.hud.hideActionMenu();
      pend.aim = aim;
      this.mode = 'bridgeTarget';
      this.drawOverlay();
    };
    if (pend.bridgeTargets.length) options.push({ label: 'Hit bridge', onClick: aimAt('strike') });
    if (canBuildBridge(this.s, u, x, y)) options.push({ label: 'Build bridge', onClick: () => this.commit({ kind: 'bridge' }) });
    if (pend.repairTargets.length) options.push({ label: 'Repair bridge', onClick: aimAt('repair') });
    if (pend.demolishTargets.length) options.push({ label: 'Blow up bridge', onClick: aimAt('demolish') });
    options.push({ label: 'Wait', onClick: () => this.commit({ kind: 'wait' }) });
    options.push({ label: 'Cancel', onClick: () => this.cancel() });

    this.mode = 'menu';
    this.drawOverlay();
    const scr = this.tileToScreen(x + 1, y);
    this.hud.showActionMenu(scr.left + 4, scr.top, options);
  }

  /** Unloading: pick a passenger, then a highlighted tile; repeat or finish with Done. */
  private openUnloadMenu() {
    const pend = this.pending!;
    const u = this.sel!.unit;
    const { x, y } = pend.to;
    const drops = pend.drops ?? [];
    const taken = drops.map(d => ({ x: d.x, y: d.y }));
    const waiting = (u.cargo ?? []).filter(c => !drops.some(d => d.cargoId === c.id));
    const options = waiting
      .filter(c => dropTiles(this.s, u, x, y, c, taken).length)
      .map(c => ({
        label: `Unload ${UNITS[c.type].name}`,
        onClick: () => {
          pend.unloading = c;
          pend.dropOptions = dropTiles(this.s, u, x, y, c, taken);
          this.hud.hideActionMenu();
          this.mode = 'unload';
          this.drawOverlay();
        },
      }));
    if (drops.length) options.push({ label: 'Done', onClick: () => this.commit({ kind: 'unload', drops }) });
    options.push({ label: 'Back', onClick: () => this.openMenu() });
    pend.unloading = undefined;
    this.mode = 'menu';
    this.drawOverlay();
    const scr = this.tileToScreen(x + 1, y);
    this.hud.showActionMenu(scr.left + 4, scr.top, options);
  }

  /** Clicked a tile while choosing where a passenger goes. */
  private pickDrop(x: number, y: number) {
    const pend = this.pending!;
    const cargo = pend.unloading;
    if (cargo && pend.dropOptions?.some(p => p.x === x && p.y === y)) {
      pend.drops = [...(pend.drops ?? []), { cargoId: cargo.id, x, y }];
      // Nothing else to drop? Do it right away.
      const u = this.sel!.unit;
      const taken = pend.drops.map(d => ({ x: d.x, y: d.y }));
      const more = (u.cargo ?? []).some(c => !pend.drops!.some(d => d.cargoId === c.id)
        && dropTiles(this.s, u, pend.to.x, pend.to.y, c, taken).length);
      if (!more) return this.commit({ kind: 'unload', drops: pend.drops });
    }
    this.openUnloadMenu();
  }

  private commit(command: Command) {
    const action: Action = { type: 'act', unitId: this.sel!.unit.id, to: this.pending!.to, command };
    this.hud.hideActionMenu();
    this.sel = null;
    this.pending = null;
    if (command.kind === 'attack') {
      // Attacking: the unit fires first, then the hit (and any return fire) plays out
      // (online, others see the same shots when the move reaches them).
      this.mode = 'animating';
      this.attackCtx = { attackerId: action.unitId, defenderId: command.targetId };
      this.fireAt(action.unitId, unitById(this.s, command.targetId)!, () => this.submit(action));
      return;
    }
    if (command.kind !== 'capture') {
      this.mode = 'idle';
      this.submit(action);
      return;
    }
    // Capturing: the unit hops on the building first, then the capture happens
    // (online, others see the same hop when the move reaches them).
    this.mode = 'animating';
    this.captureHop(action.unitId, () => {
      this.mode = 'idle';
      this.submit(action);
    });
  }

  /**
   * The capture hop: the unit jumps twice on its building, in ANIM_CAPTURE_MS, the same
   * everywhere (the server paces CPU moves by it). Each takeoff and landing is a cue for
   * sound ('capture-jump' and 'capture-hop'); the second hop takes off as the first lands.
   */
  private captureHop(unitId: number, done: () => void) {
    const sprite = this.sprites.get(unitId);
    if (!sprite || document.hidden) return done();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallback);
      this.tweens.killTweensOf(sprite);
      sprite.y = groundY;
      done();
    };
    // If the browser stops drawing (window covered), don't wait for the tween forever.
    const fallback = window.setTimeout(finish, ANIM_CAPTURE_MS + 500);
    const groundY = sprite.y;
    this.tweens.add({
      targets: sprite,
      y: groundY - T * 0.3,
      duration: ANIM_CAPTURE_MS / 4,
      ease: 'Quad.Out',
      yoyo: true,
      repeat: 1,
      onStart: () => cue('capture-jump'),
      onRepeat: () => { cue('capture-hop'); cue('capture-jump'); },
      onComplete: () => {
        cue('capture-hop');
        finish();
      },
    });
  }

  /** Send an action to the rules engine — or, online, to the server (its answer arrives in fromServer). */
  /**
   * Send an action to the rules engine (or, online, the server). Offline, an attack's
   * result plays as a battle before the map is redrawn; onShown runs once everything is
   * on screen. Returns the events (null if refused, or online).
   */
  private submit(action: Action, onShown?: (events: GameEvent[]) => void): GameEvent[] | null {
    if (this.online) {
      if (!this.myTurn()) return null;
      this.mode = 'locked'; // until the server answers
      this.pendingActor = action.type === 'act' ? unitById(this.s, action.unitId)?.type : undefined;
      this.online.send(action);
      return null;
    }
    // Humans can undo their own moves and builds until the turn ends.
    const undoable = !currentPlayer(this.s).ai && action.type !== 'endTurn';
    const before = undoable ? JSON.stringify(this.s) : null;
    // Under fog, undo must not become a free scouting tool.
    const team = currentPlayer(this.s).team;
    const seenBefore = this.s.fog && undoable ? this.seenEnemies(team) : null;

    this.actorType = action.type === 'act' ? unitById(this.s, action.unitId)?.type : undefined;
    const res = applyAction(this.s, action);
    if (!res.ok) this.s.log.push(`⚠ ${res.error}`);
    if (res.ok && before) {
      const revealed = seenBefore && (
        [...this.seenEnemies(team)].some(id => !seenBefore.has(id)) || res.events.some(e => e.kind === 'trapped'));
      if (revealed) {
        this.undoStack = [];
        this.s.log.push('Enemy spotted, so earlier moves can no longer be undone.');
      } else {
        this.undoStack.push(before);
      }
    }
    if (res.ok && res.events.some(e => e.kind === 'turn' || e.kind === 'gameover')) this.undoStack = [];
    if (res.ok) {
      if (this.s.winnerTeam !== null) clearAutosave();
      else writeAutosave(this.s);
    }
    if (!res.ok) {
      this.attackCtx = null;
      this.actorType = undefined;
      if (this.mode === 'animating') this.mode = 'idle';
      this.refresh();
      return null;
    }
    this.resolveBattle(res.events, shown => {
      if (this.mode === 'animating') this.mode = 'idle';
      this.refresh();
      this.handleEvents(res.events.filter(e => !shown.has(e)));
      this.actorType = undefined;
      onShown?.(res.events);
    });
    return res.events;
  }

  private usePower() {
    if (this.mode !== 'idle' || currentPlayer(this.s).ai || !this.myTurn() || !canUsePower(this.s, this.s.current)) return;
    this.inspect = null;
    this.submit({ type: 'power' });
  }

  private announcePower(playerId: number) {
    const p = this.s.players[playerId];
    const c = commanderOf(this.s, playerId);
    if (!c) return;
    this.hud.showBanner(`⚡ ${c.name}: ${c.power.name}! ${c.power.description}`, p.color);
    this.cameras.main.flash(250, 255, 215, 106);
    this.later(2600, () => {
      const now = currentPlayer(this.s);
      // Restore the CPU's "thinking" banner if it's still their turn.
      if (now.id === playerId && now.ai && this.s.winnerTeam === null) {
        this.hud.showBanner(`${now.name} (${controlLabel(now)}) is thinking…`, now.color);
      } else if (now.id === playerId) {
        this.hud.showBanner(null);
      }
    });
  }

  private seenEnemies(team: number): Set<number> {
    const vision = visibleTiles(this.s, team);
    return new Set(this.s.units.filter(u => this.s.players[u.owner].team !== team && canSee(this.s, vision, team, u)).map(u => u.id));
  }

  // ------------------------------------------------------------ computer players

  // CPU turns use browser timers (not Phaser's clock) and skip animations while
  // the tab is hidden, so games against the computer keep going in the background.
  private later(ms: number, fn: () => void) {
    window.setTimeout(fn, document.hidden ? 0 : ms);
  }

  private aiStep() {
    if (this.s.winnerTeam !== null || !currentPlayer(this.s).ai) return;
    const action = nextAiAction(this.s);

    const finish = () => {
      // The next step waits until this one (and any battle it starts) is on screen.
      const next = (events: GameEvent[]) => {
        if (!events.some(e => e.kind === 'turn' || e.kind === 'gameover')) this.later(AI_DELAY, () => this.aiStep());
      };
      if (!this.submit(action, next)) this.submit({ type: 'endTurn' }, next); // never get stuck on a bad move
    };

    if (action.type !== 'act') return finish();

    const u = unitById(this.s, action.unitId)!;
    const fullPath = pathTo(reachable(this.s, u), action.to.x, action.to.y);
    const path = fullPath.slice(0, walkPath(this.s, u, fullPath).stop + 1);
    const sprite = this.sprites.get(u.id)!;
    const afterMove = () => {
      // Capturing (and not stopped short by an ambush): hop on the building, if the viewer can see it.
      if (action.command.kind === 'capture') {
        const there = path.length === Math.max(1, fullPath.length);
        return there && this.seesTile(end.x, end.y) ? this.captureHop(u.id, finish) : finish();
      }
      if (action.command.kind !== 'attack') return finish();
      // Fire at the target (if the viewer can see it); the hit and any return fire follow.
      const t = unitById(this.s, action.command.targetId)!;
      if (!this.seesUnit(t)) return finish();
      this.attackCtx = { attackerId: u.id, defenderId: t.id };
      this.fireAt(u.id, t, finish);
    };
    // Don't animate moves the viewer can't see (fog of war).
    const end = path[path.length - 1];
    const hiddenMove = !this.seesUnit(u) && !this.seesTile(end.x, end.y);
    if (path.length <= 1 || document.hidden || hiddenMove || !sprite) return afterMove();
    // Big maps: follow the CPU's move if it happens off-screen.
    this.camera.ensureVisible(end.x * T + T / 2, end.y * T + T / 2);
    this.walk(u.type, sprite, path, ANIM_STEP_MS, afterMove);
  }

  private handleEvents(events: GameEvent[]) {
    for (const e of events) {
      if (e.kind === 'power') this.announcePower(e.player);
      this.showEvent(e);
    }
    this.handleTurnEvents(events);
  }

  /** The on-screen effect of one event on the map (damage numbers, explosions, captures...). */
  private showEvent(e: GameEvent) {
    if (e.kind === 'turn' || e.kind === 'eliminated' || e.kind === 'gameover' || e.kind === 'power') return;
    if (!this.seesTile(e.x, e.y)) return; // happened in the fog
    if (e.kind === 'damage' && e.amount > 0) this.floatText(e.x, e.y, `-${e.amount}%`, '#ffdd55');
    if (e.kind === 'destroyed') this.explode(e.x, e.y);
    if (e.kind === 'captured') {
      cue('captured');
      this.floatText(e.x, e.y, 'Captured!', '#ffffff');
    }
    if (e.kind === 'bridge') {
      cue(`bridge-${e.change}`, this.actorType);
      if (e.change === 'destroyed') this.explode(e.x, e.y);
      const text = { built: 'Bridge built!', repaired: 'Repaired!', cracked: 'Cracked!', destroyed: 'Bridge down!' }[e.change];
      this.floatText(e.x, e.y, text, e.change === 'built' || e.change === 'repaired' ? '#ffffff' : '#ff7b7b');
    }
    if (e.kind === 'trapped') this.floatText(e.x, e.y, 'Ambush!', '#ff7b7b');
    if (e.kind === 'crashed') {
      this.explode(e.x, e.y);
      this.floatText(e.x, e.y, 'Out of fuel!', '#ff7b7b');
    }
  }

  /** Game over, or whose turn it is now. */
  private handleTurnEvents(events: GameEvent[]) {
    const over = events.find(e => e.kind === 'gameover');
    if (over && over.kind === 'gameover') {
      const names = this.s.players.filter(p => p.team === over.team).map(p => p.name).join(' & ');
      this.mode = 'locked';
      this.hud.showBanner(null);
      if (this.online) forgetSession(); // nothing left to rejoin
      this.later(700, () =>
        this.hud.showOverlay('Victory!', `${names} win${names.includes('&') ? '' : 's'} on day ${this.s.day}.`, 'New game',
          () => { this.online?.leave(); location.reload(); }, undefined, this.hud.statsTable(this.s)),
      );
      return;
    }
    const turn = events.find(e => e.kind === 'turn');
    if (turn && this.online) {
      // Online: no handing the device over; it's either our turn or we wait for theirs.
      const p = currentPlayer(this.s);
      if (this.myTurn()) {
        this.mode = 'idle';
        this.refresh();
        this.focusOn(p.id);
        this.hud.showBanner(`Day ${this.s.day} · Your turn${p.id !== this.online.seat ? ` · ${p.name}` : ''}`, p.color);
        this.later(2500, () => { if (this.myTurn()) this.hud.showBanner(null); });
      } else {
        this.mode = 'locked';
        const seat = this.online.seat;
        const me = this.s.players[seat];
        const ally = p.team === me.team;
        const lead = p.controller !== undefined ? this.s.players[p.controller] : undefined;
        const tag = [p.ai ? 'CPU' : '', lead ? `played by ${lead.name}` : '', ally ? 'ally' : ''].filter(Boolean).join(', ');
        const who = tag ? `${p.name} (${tag})` : p.name;
        // Still in it while any army we play is alive.
        const inGame = this.s.players.some(pl => pl.alive && (pl.id === seat || pl.controller === seat));
        this.hud.showBanner(!inGame
          ? `You're out · watching ${p.name}'s turn`
          : p.ai ? `${who} is playing…` : `Waiting for ${who}…`, p.color);
      }
      return;
    }
    if (turn) {
      const p = currentPlayer(this.s);
      this.mode = 'locked';
      if (p.ai) {
        this.hud.showBanner(`${p.name} (${controlLabel(p, this.s.players)}) is thinking…`, p.color);
        this.later(AI_DELAY * 2, () => this.aiStep());
        return;
      }
      // The same person is up again (they command several armies, or play
      // alone against CPUs): no need to pass the device, just carry on.
      const human = p.controller ?? p.id;
      if (this.lastHuman === human) {
        this.mode = 'idle';
        this.refresh();
        this.focusOn(p.id);
        this.hud.showBanner(`Day ${this.s.day} · ${p.name}'s turn`, p.color);
        this.later(2500, () => { if (currentPlayer(this.s).id === p.id) this.hud.showBanner(null); });
        return;
      }
      this.lastHuman = human;
      this.hud.showBanner(null);
      this.focusOn(p.id, false); // behind the handover screen, so no animation needed
      const lead = p.controller !== undefined ? this.s.players[p.controller] : undefined;
      // Under fog the handover screen fully covers the board, so the next
      // player doesn't glimpse what the previous one could see.
      this.hud.showOverlay(
        p.name,
        `Day ${this.s.day} · Funds ${p.funds.toLocaleString()}${lead ? ` · commanded by ${lead.name}` : ''}`,
        'Start turn',
        () => {
          this.mode = 'idle';
          this.refresh();
        },
        p.color, '', !!this.s.fog,
      );
    }
  }

  // ------------------------------------------------------------ drawing

  private refresh() {
    this.updateViewer();
    this.drawTerrain();
    this.drawFog();
    this.drawUnits();
    this.drawOverlay();
    this.hud.render(this.s, this.viewerTeam);
    this.hud.setUndoEnabled(this.undoStack.length > 0 && !currentPlayer(this.s).ai);
    this.updateInfo();
  }

  /**
   * Online: who is away (the side panel tag), and for the host, a menu per army whose
   * player is away to let a CPU or a connected teammate stand in until they return.
   */
  private showPresence(on: boolean[], seats: SeatStatus[]) {
    const link = this.online!;
    const players = this.s.players;
    // Only players still in the game matter; a beaten player closing their tab is fine.
    const away = seats.map((st, i) => i).filter(i => i !== link.seat && seats[i].away && players[i]?.alive);
    const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);
    const stuck = away.filter(i => !on[i]).map(i => players[i].name);
    const covered = away.filter(i => on[i]).map(i => players[i].name);
    this.hud.setPresence(
      stuck.length ? `${list(stuck)} ${stuck.length > 1 ? 'are' : 'is'} disconnected…`
        : covered.length ? `${list(covered)} away · stand-in playing` : `Online · code ${link.code}`,
      !stuck.length,
    );
    if (link.seat !== link.host) return;
    const rows = players.flatMap(p => {
      const st = seats[p.id];
      const owner = st?.kind === 'person' ? p.id : st?.kind === 'shared' ? st.lead ?? -1 : -1;
      if (!p.alive || owner < 0 || !seats[owner]?.away) return [];
      const ownerName = players[owner].name;
      const teammates = seats.map((_, j) => j)
        .filter(j => j !== owner && seats[j].kind === 'person' && !seats[j].away && players[j].team === p.team);
      const value = !st.standIn ? 'wait' : 'cpu' in st.standIn ? st.standIn.cpu : `lead:${st.standIn.lead}`;
      return [{
        seat: p.id,
        label: owner === p.id ? p.name : `${p.name} (${ownerName}'s)`,
        value,
        options: [
          ['wait', `Nobody: wait for ${ownerName}`],
          ['easy', 'CPU · Easy'], ['medium', 'CPU · Medium'], ['hard', 'CPU · Hard'],
          ...teammates.map(j => [`lead:${j}`, j === link.seat ? 'Me' : players[j].name]),
        ] as Array<[string, string]>,
      }];
    });
    this.hud.setStandIns(rows, (seat, v) => link.standIn(seat,
      v === 'wait' ? null : v.startsWith('lead:') ? { lead: Number(v.slice(5)) } : { cpu: v as Difficulty }));
  }

  private updateViewer() {
    if (this.online) {
      // Online you only ever see through your own army's eyes.
      this.viewerTeam = this.s.fog ? this.s.players[this.online.seat].team : null;
    } else if (!this.s.fog) {
      this.viewerTeam = null;
    } else {
      const p = currentPlayer(this.s);
      if (!p.ai) this.viewerTeam = p.team;
      else if (this.viewerTeam === null) this.viewerTeam = this.s.players.find(pl => !pl.ai)?.team ?? null; // all-CPU: spectate
    }
    this.vision = this.viewerTeam === null ? null : visibleTiles(this.s, this.viewerTeam);
  }

  private drawTerrain() {
    drawTerrain(this.terrainG, this.s);
  }

  private drawFog() {
    const g = this.fogG.clear();
    if (!this.vision) return;
    g.fillStyle(0x0b0f14, 0.45);
    for (let i = 0; i < this.s.tiles.length; i++) {
      if (!this.vision.has(i)) g.fillRect((i % this.s.width) * T, Math.floor(i / this.s.width) * T, T, T);
    }
  }

  private drawUnits() {
    this.unitLayer.removeAll(true);
    this.sprites.clear();
    for (const u of this.s.units) {
      if (!this.seesUnit(u)) continue;
      const c = makeUnitSprite(this, this.s, u);
      this.unitLayer.add(c);
      this.sprites.set(u.id, c);
    }
  }

  private drawOverlay() {
    const g = this.overlayG.clear();
    const fill = (k: string, color: number, alpha: number) => {
      const [x, y] = k.split(',').map(Number);
      g.fillStyle(color, alpha).fillRect(x * T, y * T, T, T);
    };

    if (this.inspect) {
      for (const k of this.inspect.danger) fill(k, 0xff4040, 0.25);
      for (const k of this.inspect.move) fill(k, 0xffa040, 0.3);
    }

    if (this.sel && this.mode === 'selected') {
      for (const k of this.sel.dests) {
        // Our own transports you can board show in green.
        const [dx, dy] = k.split(',').map(Number);
        const boards = (dx !== this.sel.unit.x || dy !== this.sel.unit.y) && boardingTarget(this.s, this.sel.unit, dx, dy);
        fill(k, boards ? 0x4fd16b : 0x4fa3ff, boards ? 0.55 : 0.4);
      }
      for (const id of this.sel.threats) {
        const t = this.s.units.find(u => u.id === id);
        if (t) g.lineStyle(3, 0xff3030, 1).strokeRect(t.x * T + 2, t.y * T + 2, T - 4, T - 4);
      }
      // Path preview to the hovered tile.
      if (this.hover && this.sel.dests.has(posKey(this.hover.x, this.hover.y))) {
        const path = pathTo(this.sel.reach, this.hover.x, this.hover.y);
        g.lineStyle(5, 0xffffff, 0.85).beginPath();
        path.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, p.x * T + T / 2, p.y * T + T / 2));
        g.strokePath();
      }
    }

    if (this.pending && (this.mode === 'menu' || this.mode === 'target' || this.mode === 'bridgeTarget' || this.mode === 'unload')) {
      fill(posKey(this.pending.to.x, this.pending.to.y), 0x4fa3ff, 0.4);
    }
    if (this.pending && this.mode === 'target') {
      for (const t of this.pending.targets) fill(posKey(t.x, t.y), 0xff3030, 0.5);
    }
    if (this.pending && this.mode === 'bridgeTarget') {
      for (const b of this.aimedBridges()) fill(posKey(b.x, b.y), 0xff9030, 0.55);
    }
    // Unloading: where this passenger can go (green), and spots already chosen (ringed).
    if (this.pending && this.mode === 'unload') {
      for (const p of this.pending.dropOptions ?? []) fill(posKey(p.x, p.y), 0x4fd16b, 0.55);
    }
    for (const d of this.pending?.drops ?? []) {
      g.lineStyle(3, 0x4fd16b, 1).strokeCircle(d.x * T + T / 2, d.y * T + T / 2, T / 2 - 5);
    }
  }

  /** The bridges the player is picking between: ones to shell, or (Engineer) ones to blow up or repair. */
  private aimedBridges(): Pos[] {
    if (!this.pending) return [];
    const { aim } = this.pending;
    return aim === 'demolish' ? this.pending.demolishTargets : aim === 'repair' ? this.pending.repairTargets : this.pending.bridgeTargets;
  }

  private updateInfo() {
    if (!this.hover) return;
    const { x, y } = this.hover;
    const tile = tileAt(this.s, x, y);
    const td = TERRAIN[tile.terrain];
    let html = `<b>${td.name}</b> ${'★'.repeat(td.defense) || '<span style="color:var(--muted)">no cover</span>'}`;
    if (tile.terrain === 'bridge') {
      const left = (td.durability ?? 1) - (tile.damage ?? 0);
      html += tile.damage
        ? `<br><span style="color:#ff7b7b">Cracked: ${left} more hit${left === 1 ? '' : 's'} from Artillery or Rockets brings it down</span>`
        : '<br>A Bomber hit destroys it; Artillery and Rockets need 2';
    }
    if (td.property) {
      const owner = tile.owner === null ? 'Neutral' : escapeHtml(this.s.players[tile.owner].name);
      html += `<br>${owner} · capture ${tile.capture}/${CAPTURE_POINTS}`;
    }
    if (!this.seesTile(x, y)) html += '<br><span style="color:var(--muted)">Fog: you can\'t see units here.</span>';
    const u = this.visibleUnitAt(x, y);
    if (u) {
      const def = UNITS[u.type];
      const maxRange = unitMaxRange(this.s, u);
      const range = maxRange > 1 ? `${def.minRange}–${maxRange}` : '1';
      const vision = this.s.fog ? ` · Vision ${unitVision(this.s, u)}` : '';
      html += `<hr style="border-color:#4a5563"><b>${def.name}</b> (${escapeHtml(this.s.players[u.owner].name)})
        <br>HP ${displayHp(u.hp)}/${displayHp(maxHpOf(u.type))} · Move ${unitMove(this.s, u)} · Range ${range}${vision}`;
      // Fuel, ammo and passengers (only shown for units that have them).
      const supplies: string[] = [];
      if (u.fuel !== undefined) {
        const low = isLowFuel(u) ? ' style="color:#ff7b7b"' : '';
        const burn = def.fuelPerDay ? ` (−${def.fuelPerDay}/day)` : '';
        supplies.push(`<span${low}>Fuel ${u.fuel}/${def.fuel}${burn}${u.fuel <= 0 ? ' · out of fuel, can\'t move' : ''}</span>`);
      }
      if (def.ammo !== undefined) {
        const empty = (u.ammo ?? 0) <= 0 ? ' style="color:#ff7b7b"' : '';
        supplies.push(`<span${empty}>Ammo ${u.ammo ?? 0}/${def.ammo}</span>`);
      }
      if (def.bridgeKits !== undefined) {
        const empty = (u.kits ?? 0) <= 0 ? ' style="color:#ff7b7b"' : '';
        supplies.push(`<span${empty}>Bridge kit ${u.kits ?? 0}/${def.bridgeKits}</span>`);
      }
      if (def.coverDamage !== undefined && def.coverTerrain?.includes(tile.terrain)) {
        supplies.push(`<span style="color:#7fd67f">In cover: takes ${Math.round(def.coverDamage * 100)}% damage</span>`);
      }
      if (supplies.length) html += `<br>${supplies.join(' · ')}`;
      if (def.transport) {
        // Under fog you can see an enemy transport is loaded, but not with what.
        const secret = !!this.s.fog && this.viewerTeam !== null && this.s.players[u.owner].team !== this.viewerTeam;
        const aboard = secret ? '' : (u.cargo ?? []).map(c => `${UNITS[c.type].name} (${displayHp(c.hp)} HP)`).join(', ');
        html += `<br>Carrying ${u.cargo?.length ?? 0}/${def.transport.capacity}${aboard ? `: ${escapeHtml(aboard)}` : ''}`;
      }
      if (this.mode === 'target' && this.sel && this.pending?.targets.some(t => t.id === u.id)) {
        const f = forecast(this.s, this.sel.unit, this.pending.to, u);
        html += `<br><span style="color:#ffdd55">Deal ${f.deal}% · Take ${f.take}%</span>`;
      }
    }
    this.hud.setInfo(html);
  }

  // ------------------------------------------------------------ effects & helpers

  private floatText(x: number, y: number, text: string, color: string) {
    const t = this.add.text(x * T + T / 2, y * T + 4, text, {
      fontFamily: 'Arial', fontSize: '14px', fontStyle: 'bold', color, stroke: '#000000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(10);
    this.tweens.add({ targets: t, y: t.y - 24, alpha: 0, duration: 1000, onComplete: () => t.destroy() });
  }

  private explode(x: number, y: number) {
    cue('explosion');
    const boom = this.add.circle(x * T + T / 2, y * T + T / 2, 6, 0xffa020).setDepth(9);
    this.tweens.add({ targets: boom, scale: 4, alpha: 0, duration: 450, onComplete: () => boom.destroy() });
    this.cameras.main.shake(150, 0.004);
  }

  private tileToScreen(x: number, y: number) {
    return this.camera.toScreen(x * T, y * T);
  }

  /** Scroll to where a player's army is (their units, or else their HQ). */
  private focusOn(playerId: number, animate = true) {
    const units = this.s.units.filter(u => u.owner === playerId);
    let x: number;
    let y: number;
    if (units.length) {
      x = units.reduce((sum, u) => sum + u.x, 0) / units.length;
      y = units.reduce((sum, u) => sum + u.y, 0) / units.length;
    } else {
      const i = this.s.tiles.findIndex(t => t.owner === playerId && t.terrain === 'hq');
      const j = i >= 0 ? i : this.s.tiles.findIndex(t => t.owner === playerId);
      if (j < 0) return;
      x = j % this.s.width;
      y = Math.floor(j / this.s.width);
    }
    this.camera.centerOn(x * T + T / 2, y * T + T / 2, animate);
  }
}
