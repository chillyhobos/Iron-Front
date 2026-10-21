// How long animations take. Games on one computer, online players and the server all
// use these numbers: the server waits this long between CPU moves so every screen
// keeps up, and the game's effects are built from the same table so they can't drift.

import type { UnitType } from './data';
import type { GameEvent, GameState } from './state';
import type { MoveAnim } from './view';

/** Per tile walked. */
export const ANIM_STEP_MS = 90;
/** A capturing unit hops twice on its building. */
export const ANIM_CAPTURE_MS = 400;
/** After a hit lands, the defender waits this long before firing back. */
export const COUNTER_PAUSE_MS = 120;

/** How a unit's attack looks. Each style fires `shots` projectiles, `gap` ms apart, each flying `flight` ms. */
export type WeaponStyle =
  | 'rifle' | 'sniper' | 'bazooka' | 'cannon' | 'guns'
  | 'shell' | 'rockets' | 'missiles' | 'airMissiles' | 'bombs';

export interface WeaponTiming {
  shots: number;
  gap: number;
  flight: number;
  /** Arc height in tiles (0 = straight). */
  arc: number;
}

export const WEAPONS: Record<WeaponStyle, WeaponTiming> = {
  rifle: { shots: 3, gap: 70, flight: 110, arc: 0 },
  sniper: { shots: 1, gap: 0, flight: 150, arc: 0 },
  bazooka: { shots: 1, gap: 0, flight: 240, arc: 0 },
  cannon: { shots: 1, gap: 0, flight: 200, arc: 0 },
  guns: { shots: 4, gap: 50, flight: 140, arc: 0 },
  shell: { shots: 1, gap: 0, flight: 500, arc: 1 },
  rockets: { shots: 3, gap: 70, flight: 480, arc: 1.2 },
  missiles: { shots: 2, gap: 90, flight: 460, arc: 1.8 },
  airMissiles: { shots: 2, gap: 70, flight: 220, arc: 0 },
  bombs: { shots: 2, gap: 80, flight: 280, arc: 0.3 },
};

/** Which weapon each unit fires (units that can't attack aren't listed). */
export const WEAPON_OF: Partial<Record<UnitType, WeaponStyle>> = {
  rifle: 'rifle', engineer: 'rifle', sniper: 'sniper', bazooka: 'bazooka',
  scout: 'guns', flak: 'guns', fighter: 'guns', cruiser: 'guns',
  ltank: 'cannon', htank: 'cannon',
  artillery: 'shell', battleship: 'shell', rocket: 'rockets', missile: 'missiles',
  gunship: 'airMissiles', bomber: 'bombs',
};

export const weaponOf = (type: UnitType): WeaponStyle => WEAPON_OF[type] ?? 'rifle';

/** From the first shot until the last one lands. */
export function attackMs(type: UnitType): number {
  const w = WEAPONS[weaponOf(type)];
  return (w.shots - 1) * w.gap + w.flight;
}

/** How long a move's animation takes: the walk, then the attacker's shots or the capture hop. */
export function animMs(anim: MoveAnim | null): number {
  if (!anim) return 0;
  return Math.max(0, anim.path.length - 1) * ANIM_STEP_MS
    + (anim.targetId !== undefined ? attackMs(anim.unitType) : 0)
    + (anim.capture ? ANIM_CAPTURE_MS : 0);
}

/**
 * The defender firing back, if it did (it survived and could reach): a short pause, then
 * its own shots. Played after the attack, from the events the attack produced.
 */
export function counterMs(before: GameState, anim: MoveAnim | null, events: GameEvent[]): number {
  if (!anim || anim.targetId === undefined) return 0;
  if (!events.some(e => e.kind === 'damage' && e.unitId === anim.unitId)) return 0;
  const defender = before.units.find(u => u.id === anim.targetId);
  return defender ? COUNTER_PAUSE_MS + attackMs(defender.type) : 0;
}
