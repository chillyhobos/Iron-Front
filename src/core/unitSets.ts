// Unit sets: named copies of every unit's stats and the damage table. "Standard"
// is the built-in data; custom sets come from the unit editor. A game stores its
// set in GameState.unitSet, and applyUnitSet() swaps the numbers in place before
// play starts, so the rules, the CPU and the screens all read the chosen values.

import { DAMAGE, UNIT_ORDER, UNITS, type MoveType, type UnitDef, type UnitType } from './data';

export type DamageTable = Record<UnitType, Record<UnitType, number>>;

/** A unit set as it's stored in saves and files. */
export interface UnitSetData {
  name: string;
  units: Record<UnitType, UnitDef>;
  damage: DamageTable;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The built-in numbers, captured before anything is applied. */
const STANDARD: UnitSetData = { name: 'Standard', units: clone(UNITS), damage: clone(DAMAGE) };

/** A fresh, editable copy of the Standard set. */
export function standardSet(name = 'Standard'): UnitSetData {
  return { ...clone(STANDARD), name };
}

/** The Standard values for one unit (for "reset" and change highlighting). */
export const standardUnit = (t: UnitType): UnitDef => STANDARD.units[t];
export const standardDamage = (a: UnitType, d: UnitType): number => STANDARD.damage[a][d];

/**
 * Bring a set made before newer units existed up to date: any unit (or damage
 * entry) it lacks is filled in from Standard. Returns the same object.
 */
export function upgradeUnitSet<T extends UnitSetData>(set: T): T {
  if (!set?.units || !set.damage) return set;
  for (const t of UNIT_ORDER) {
    if (!set.units[t]) set.units[t] = clone(STANDARD.units[t]);
    set.damage[t] ??= clone(STANDARD.damage[t]);
    for (const d of UNIT_ORDER) set.damage[t][d] ??= STANDARD.damage[t][d];
  }
  return set;
}

/** Make this set the live data (null/undefined = Standard). Replaces values in place. */
export function applyUnitSet(set: UnitSetData | null | undefined) {
  const src = set ?? STANDARD;
  for (const t of UNIT_ORDER) {
    const live = UNITS[t] as unknown as Record<string, unknown>;
    for (const k of Object.keys(live)) delete live[k];
    Object.assign(live, clone(src.units[t]));
    Object.assign(DAMAGE[t], clone(src.damage[t]));
  }
}

// ---------------------------------------------------------------- editable fields

export type FieldKind = 'int' | 'number' | 'bool' | 'text' | 'moveType';

/**
 * One editable number/flag on a unit. `path` reaches into the UnitDef ("cost",
 * "transport.capacity", "precision.open.rifle"). Optional fields can be left
 * blank to switch them off (e.g. no fuel).
 */
export interface FieldSpec {
  path: string;
  label: string;
  kind: FieldKind;
  section: 'Basics' | 'Combat' | 'Supplies' | 'Special';
  help: string;
  min?: number;
  max?: number;
  step?: number;
  optional?: boolean;
  /** Only shown for units this makes sense for. */
  showFor?: (def: UnitDef) => boolean;
}

/** Vehicles, aircraft and ships use fuel (infantry don't). */
const usesFuel = (d: UnitDef) => d.moveType !== 'foot' && d.moveType !== 'boot';

/** Move types a unit may switch between without changing which building builds it. */
export function moveTypeChoices(current: MoveType): MoveType[] {
  if (current === 'foot' || current === 'boot') return ['foot', 'boot'];
  if (current === 'treads' || current === 'tires') return ['treads', 'tires'];
  return [current];
}

export const FIELDS: FieldSpec[] = [
  { path: 'name', label: 'Name', kind: 'text', section: 'Basics', help: 'Shown in menus and the log.' },
  { path: 'label', label: 'Badge', kind: 'text', section: 'Basics', help: 'Up to 3 letters drawn on the unit.' },
  { path: 'cost', label: 'Cost', kind: 'int', section: 'Basics', min: 500, max: 99000, step: 500, help: 'Price to build.' },
  { path: 'move', label: 'Movement', kind: 'int', section: 'Basics', min: 1, max: 15, help: 'Move points per turn.' },
  { path: 'vision', label: 'Vision', kind: 'int', section: 'Basics', min: 1, max: 10, help: 'How far it sees in fog of war.' },
  {
    path: 'moveType', label: 'Move type', kind: 'moveType', section: 'Basics',
    help: 'Infantry: foot (mountains cost 2) or boot (mountains cost 1). Vehicles: treads or tires (slower off-road).',
    showFor: d => moveTypeChoices(d.moveType).length > 1,
  },
  { path: 'canCapture', label: 'Can capture', kind: 'bool', section: 'Basics', help: 'Can take cities, factories and HQs.' },

  { path: 'maxHp', label: 'Max health', kind: 'int', section: 'Combat', min: 10, max: 100, step: 10, optional: true, help: 'Full health (blank = 100). Damage dealt also scales with health, so lower health also means weaker hits.' },
  { path: 'minRange', label: 'Min range', kind: 'int', section: 'Combat', min: 1, max: 10, help: '1 = can attack next to it. 2+ = indirect fire (cannot move and shoot in one turn).' },
  { path: 'maxRange', label: 'Max range', kind: 'int', section: 'Combat', min: 1, max: 10, help: 'Farthest tile it can hit.' },
  { path: 'coverFactor', label: 'Terrain cover', kind: 'number', section: 'Combat', min: 0, max: 2, step: 0.1, optional: true, help: 'Share of terrain defense stars it benefits from (blank = 1 = full).' },
  { path: 'coverDamage', label: 'Damage taken in cover', kind: 'number', section: 'Combat', min: 0.05, max: 1, step: 0.05, optional: true, help: 'If set, in cover (forest, mountain, buildings) it takes this share of each hit instead of using stars (Engineer: 0.3).' },
  { path: 'fullDamageAtAnyHp', label: 'Full damage when hurt', kind: 'bool', section: 'Combat', help: 'Hits just as hard at low health.' },
  { path: 'camouflage', label: 'Camouflage', kind: 'bool', section: 'Combat', help: 'In fog of war, enemies only see it from right next to it.' },

  { path: 'fuel', label: 'Fuel', kind: 'int', section: 'Supplies', min: 10, max: 99, optional: true, showFor: usesFuel, help: 'Fuel tank (blank = never runs out). Moving burns its move-point cost. Out of fuel: aircraft crash, ships sink, vehicles are stuck.' },
  { path: 'fuelPerDay', label: 'Fuel per day', kind: 'int', section: 'Supplies', min: 0, max: 20, optional: true, showFor: usesFuel, help: 'Fuel burned at the start of each turn, even standing still (blank = 0, like ground vehicles).' },
  { path: 'ammo', label: 'Ammo', kind: 'int', section: 'Supplies', min: 1, max: 20, optional: true, help: 'Shots before it must rearm (blank = unlimited).' },
  { path: 'resupplies', label: 'Resupplies neighbours', kind: 'bool', section: 'Supplies', help: 'Refuels and rearms adjacent friendly units each turn (like the APC).' },
  { path: 'transport.capacity', label: 'Carries', kind: 'int', section: 'Supplies', min: 1, max: 4, showFor: d => !!d.transport, help: 'Passengers it can carry.' },

  { path: 'bridgeKits', label: 'Bridge kits', kind: 'int', section: 'Special', min: 1, max: 5, optional: true, help: 'Engineer kits: each builds, repairs or blows up one bridge (blank = not an engineer).' },
  { path: 'bridgeDamage', label: 'Bridge damage', kind: 'int', section: 'Special', min: 1, max: 4, optional: true, help: 'Damage per hit to bridges (bridges take 2). Blank = cannot hit bridges.' },
];

/** The fields to show for this unit, including its Sniper numbers if it has any. */
export function fieldsFor(def: UnitDef): FieldSpec[] {
  const out = FIELDS.filter(f => !f.showFor || f.showFor(def));
  const name = (t: string) => UNITS[t as UnitType]?.name ?? (t === 'infantry' ? 'any infantry' : t === 'vehicle' ? 'any vehicle' : t);
  for (const where of ['open', 'cover'] as const) {
    for (const t of Object.keys(def.precision?.[where] ?? {})) {
      out.push({ path: `precision.${where}.${t}`, label: `Hits ${name(t)} (${where})`, kind: 'int', section: 'Special', min: 0, max: 100, help: `Fixed damage to a ${name(t)} ${where === 'open' ? 'in the open' : 'in cover'} (100 = always destroys).` });
    }
    for (const t of Object.keys(def.incomingDamage?.[where] ?? {})) {
      out.push({ path: `incomingDamage.${where}.${t}`, label: `Takes from ${name(t)} (${where})`, kind: 'int', section: 'Special', min: 0, max: 100, help: `Fixed damage it takes from ${name(t)} ${where === 'open' ? 'in the open' : 'in cover'}.` });
    }
  }
  return out;
}

export function getField(def: UnitDef, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], def);
}

/** Set (or, with undefined, remove) a value at a path. */
export function setField(def: UnitDef, path: string, value: unknown) {
  const keys = path.split('.');
  let o = def as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
}

// ---------------------------------------------------------------- validation

/** Problems that would stop this set from being played (empty = fine). */
export function validateUnitSet(set: UnitSetData): string[] {
  const errors: string[] = [];
  if (!set || typeof set.name !== 'string' || !set.name.trim()) errors.push('The unit set needs a name.');
  if (!set?.units || !set.damage) return ['Not a unit set.'];
  for (const t of UNIT_ORDER) {
    const def = set.units[t];
    if (!def) { errors.push(`Missing unit: ${t}.`); continue; }
    const who = typeof def.name === 'string' && def.name.trim() ? def.name : t;
    for (const f of fieldsFor(def)) {
      const v = getField(def, f.path);
      if (v === undefined) {
        if (!f.optional && f.kind !== 'bool') errors.push(`${who}: ${f.label} is missing.`);
        continue;
      }
      if (f.kind === 'text') {
        const max = f.path === 'label' ? 3 : 20;
        if (typeof v !== 'string' || !v.trim() || v.length > max) errors.push(`${who}: ${f.label} must be 1–${max} characters.`);
      } else if (f.kind === 'bool') {
        if (typeof v !== 'boolean') errors.push(`${who}: ${f.label} must be yes or no.`);
      } else if (f.kind === 'moveType') {
        if (!moveTypeChoices(standardUnit(t).moveType).includes(v as MoveType)) errors.push(`${who}: that move type isn't allowed.`);
      } else {
        const n = v as number;
        const whole = f.kind === 'int';
        if (typeof n !== 'number' || !Number.isFinite(n) || (whole && !Number.isInteger(n))
          || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          errors.push(`${who}: ${f.label} must be ${whole ? 'a whole number ' : ''}from ${f.min} to ${f.max}.`);
        }
      }
    }
    // (Checked for every unit, not just the ones whose form offers a choice.)
    if (!moveTypeChoices(standardUnit(t).moveType).includes(def.moveType) && !errors.some(e => e.startsWith(`${who}: that move type`))) {
      errors.push(`${who}: that move type isn't allowed.`);
    }
    if (typeof def.minRange === 'number' && typeof def.maxRange === 'number' && def.minRange > def.maxRange) {
      errors.push(`${who}: Min range can't be more than Max range.`);
    }
    if (def.fuelPerDay !== undefined && def.fuel === undefined) errors.push(`${who}: Fuel per day needs a Fuel tank.`);
    for (const d of UNIT_ORDER) {
      const v = set.damage[t]?.[d];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 200) {
        errors.push(`${who} → ${set.units[d]?.name ?? d}: damage must be a whole number from 0 to 200.`);
      }
    }
  }
  return errors;
}
