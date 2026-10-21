// Attack effects: muzzle flashes, tracers, shells, rockets, missiles, bombs and impacts.
// Built to stay smooth: two tiny white textures made once, a pool of reused images
// (tinted and scaled, so the renderer draws them in a few batches), and a single
// counter tween per projectile. Timing comes from WEAPONS in core/timing.ts, which
// the server uses too, so every screen plays a battle at the same pace.

import Phaser from 'phaser';
import type { UnitType } from '../core/data';
import { attackMs, WEAPONS, weaponOf, type WeaponStyle } from '../core/timing';
import { cue } from './cues';

const DOT = 'fx-dot';
const STREAK = 'fx-streak';

interface Look {
  tex: typeof DOT | typeof STREAK;
  tint: number;
  /** Projectile size. */
  scaleX: number;
  scaleY: number;
  /** Muzzle flash and impact size (0 = none). */
  flash: number;
  impact: number;
  /** How far the shooter kicks back, in pixels. */
  recoil: number;
}

const LOOKS: Record<WeaponStyle, Look> = {
  rifle: { tex: STREAK, tint: 0xffe08a, scaleX: 0.8, scaleY: 0.8, flash: 0.8, impact: 0.7, recoil: 1 },
  sniper: { tex: STREAK, tint: 0xffffff, scaleX: 1.7, scaleY: 0.6, flash: 1.2, impact: 0.9, recoil: 2 },
  bazooka: { tex: STREAK, tint: 0xff9a3c, scaleX: 1.1, scaleY: 1.4, flash: 1.1, impact: 1.4, recoil: 2 },
  cannon: { tex: DOT, tint: 0xfff1c0, scaleX: 0.8, scaleY: 0.8, flash: 1.5, impact: 1.6, recoil: 3 },
  guns: { tex: STREAK, tint: 0xffd060, scaleX: 0.9, scaleY: 0.7, flash: 0.9, impact: 0.7, recoil: 1 },
  shell: { tex: DOT, tint: 0xfff1c0, scaleX: 0.9, scaleY: 0.9, flash: 1.6, impact: 2, recoil: 3 },
  rockets: { tex: STREAK, tint: 0xff8a3c, scaleX: 1, scaleY: 1.2, flash: 1.2, impact: 1.4, recoil: 1 },
  missiles: { tex: STREAK, tint: 0xe8f4ff, scaleX: 1.2, scaleY: 1.2, flash: 1.2, impact: 1.5, recoil: 1 },
  airMissiles: { tex: STREAK, tint: 0xe8f4ff, scaleX: 1, scaleY: 1.1, flash: 0.9, impact: 1.3, recoil: 0 },
  bombs: { tex: DOT, tint: 0x30343a, scaleX: 0.9, scaleY: 1.1, flash: 0, impact: 2.1, recoil: 0 },
};

const FLASH_MS = 90;
const IMPACT_MS = 180;
/** Shots spread a little across the target instead of landing on one pixel. */
const SPREAD = [0, -5, 5, -2];

export interface Point { x: number; y: number }

export class AttackFx {
  private free: Phaser.GameObjects.Image[] = [];

  constructor(private scene: Phaser.Scene, private layer: Phaser.GameObjects.Container, private tile: number) {
    // The two shapes everything is drawn with, generated once (white, so tints colour them).
    if (!scene.textures.exists(DOT)) {
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(0xffffff).fillCircle(4, 4, 4).generateTexture(DOT, 8, 8);
      g.clear().fillStyle(0xffffff).fillRoundedRect(0, 0, 12, 3, 1.5).generateTexture(STREAK, 12, 3);
      g.destroy();
    }
  }

  /**
   * One attack: shots fly from `from` to `to` (pixels) in the unit's weapon style; the
   * shooter kicks back a little. Calls onImpact once, when the last shot lands, exactly
   * attackMs(type) after it starts. If the browser stops drawing frames meanwhile, it
   * cleans up and calls onImpact anyway, so the game never waits on an animation.
   */
  fire(type: UnitType, from: Point, to: Point, shooter: Phaser.GameObjects.Container | undefined, onImpact: () => void) {
    const style = weaponOf(type);
    const w = WEAPONS[style];
    const look = LOOKS[style];
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const arc = w.arc * this.tile;
    const tweens: Phaser.Tweens.Tween[] = [];
    const live = new Set<Phaser.GameObjects.Image>();
    let landed = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(fallback);
      for (const tw of tweens) if (!tw.isDestroyed() && !tw.isFinished()) tw.stop();
      for (const img of live) this.put(img);
      live.clear();
      onImpact();
    };
    const fallback = window.setTimeout(finish, attackMs(type) + 400);

    if (shooter && look.recoil) {
      const home = { x: shooter.x, y: shooter.y };
      tweens.push(this.scene.tweens.add({
        targets: shooter, x: home.x - ux * look.recoil, y: home.y - uy * look.recoil,
        duration: 60, yoyo: true, ease: 'Quad.Out',
        onComplete: () => shooter.setPosition(home.x, home.y),
        onStop: () => shooter.setPosition(home.x, home.y),
      }));
    }

    for (let i = 0; i < w.shots; i++) {
      // Each shot lands slightly off-centre, sideways to its flight.
      const off = SPREAD[i % SPREAD.length];
      const end = { x: to.x - uy * off, y: to.y + ux * off };
      const start = { x: from.x + ux * 12, y: from.y + uy * 12 };
      const shot = this.take(look.tex, look.tint, look.scaleX, look.scaleY);
      shot.setVisible(false);
      live.add(shot);
      const progress = { t: 0 };
      tweens.push(this.scene.tweens.add({
        targets: progress, t: 1, duration: w.flight, delay: i * w.gap,
        onStart: () => {
          shot.setVisible(true);
          if (look.flash) this.burst(start, 0xfff2a0, look.flash * 0.9, 0, FLASH_MS);
          cue('fire', type);
        },
        onUpdate: () => {
          const t = progress.t;
          const lift = arc * 4 * t * (1 - t);
          shot.setPosition(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t - lift);
          if (look.tex === STREAK) {
            // Point along the flight: the arc's slope at t.
            shot.setRotation(Math.atan2(end.y - start.y - arc * 4 * (1 - 2 * t), end.x - start.x));
          }
        },
        onComplete: () => {
          live.delete(shot);
          this.put(shot);
          if (look.impact) this.burst(end, 0xffc060, look.impact * 0.4, look.impact * 1.6, IMPACT_MS);
          cue('impact', type);
          if (++landed === w.shots) finish();
        },
      }));
    }
  }

  /** A quick flash that grows (or shrinks) and fades: muzzle flashes and impacts. */
  private burst(at: Point, tint: number, fromScale: number, toScale: number, ms: number) {
    const img = this.take(DOT, tint, fromScale, fromScale).setPosition(at.x, at.y);
    this.scene.tweens.add({
      targets: img, scale: toScale, alpha: 0, duration: ms, ease: 'Quad.Out',
      onComplete: () => this.put(img),
      onStop: () => this.put(img),
    });
  }

  private take(tex: string, tint: number, scaleX: number, scaleY: number): Phaser.GameObjects.Image {
    let img = this.free.pop();
    if (!img) {
      img = this.scene.add.image(0, 0, tex);
      this.layer.add(img);
    }
    return img.setTexture(tex).setTint(tint).setScale(scaleX, scaleY).setAlpha(1).setRotation(0).setVisible(true).setActive(true);
  }

  private put(img: Phaser.GameObjects.Image) {
    if (!img.active) return;
    img.setActive(false).setVisible(false);
    this.free.push(img);
  }
}
