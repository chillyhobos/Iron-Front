// Unit editor screen: edit a named copy of every unit's stats and the damage table.
// The form is built from FIELDS (core/unitSets.ts), so a new unit ability only
// needs a new entry there.

import { UNIT_ORDER, type MoveType, type UnitType } from '../core/data';
import {
  fieldsFor, getField, moveTypeChoices, setField, standardDamage, standardSet, standardUnit, validateUnitSet,
  type FieldSpec, type UnitSetData,
} from '../core/unitSets';
import { escapeHtml } from './hud';
import {
  deleteUnitSet, exportUnitSetFile, listUnitSets, newUnitSetId, pickUnitSetFile, saveUnitSet,
} from './unitSetStore';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MOVE_NAMES: Record<MoveType, string> = { foot: 'Foot', boot: 'Boot', treads: 'Treads', tires: 'Tires', air: 'Air', ship: 'Ship' };
const SECTIONS: FieldSpec['section'][] = ['Basics', 'Combat', 'Supplies', 'Special'];

export class UnitEditor {
  private set: UnitSetData = standardSet('My units');
  private id: string | null = null;
  private unit: UnitType = UNIT_ORDER[0];
  private dirty = false;

  constructor(private onExit: () => void) {
    $<HTMLInputElement>('ue-name').oninput = e => { this.set.name = (e.target as HTMLInputElement).value; this.touch(); };
    $('ue-new').onclick = () => { if (this.confirmDiscard()) this.load(standardSet('My units'), null, 'Started a new set from the Standard units.'); };
    $<HTMLSelectElement>('ue-open').onchange = e => this.openStored(e.target as HTMLSelectElement);
    $('ue-import').onclick = () => this.importFile();
    $('ue-export').onclick = () => this.exportFile();
    $('ue-delete').onclick = () => this.deleteSet();
    $('ue-save').onclick = () => this.save();
    $('ue-reset-unit').onclick = () => this.resetUnit();
    $('ue-back').onclick = () => { if (this.confirmDiscard()) this.close(); };
    $('ue-list').onclick = e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]');
      if (b) { this.unit = b.dataset.unit as UnitType; this.render(); }
    };
    $('ue-fields').oninput = e => this.onFieldInput(e.target as HTMLInputElement);
    $('ue-fields').onchange = e => this.onFieldInput(e.target as HTMLInputElement);
    for (const id of ['ue-attack', 'ue-defend']) $(id).oninput = e => this.onDamageInput(e.target as HTMLInputElement);
  }

  open() {
    $('setup').classList.add('hidden');
    $('unit-editor').classList.remove('hidden');
    const sets = listUnitSets();
    if (this.id === null && !this.dirty && sets.length) this.load(structuredClone(sets[sets.length - 1]), sets[sets.length - 1].id, '');
    else this.render();
  }

  private close() {
    $('unit-editor').classList.add('hidden');
    $('setup').classList.remove('hidden');
    this.onExit();
  }

  // ------------------------------------------------------------ set handling

  private load(set: UnitSetData, id: string | null, status: string) {
    const { name, units, damage } = set;
    this.set = { name, units, damage };
    this.id = id;
    this.dirty = false;
    this.render();
    this.status(status);
  }

  private confirmDiscard() {
    return !this.dirty || confirm('You have unsaved changes to this unit set. Discard them?');
  }

  private touch() {
    this.dirty = true;
    this.renderList();
    this.renderErrors();
    this.status('Unsaved changes.');
  }

  private openStored(sel: HTMLSelectElement) {
    const stored = listUnitSets().find(s => s.id === sel.value);
    sel.value = '';
    if (stored && this.confirmDiscard()) this.load(structuredClone(stored), stored.id, `Opened “${stored.name}”.`);
  }

  private save(): boolean {
    const problems = validateUnitSet(this.set);
    if (problems.length) {
      this.renderErrors();
      this.status(`Can't save yet: ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix (shown in red).`);
      return false;
    }
    const id = this.id ?? newUnitSetId();
    const err = saveUnitSet({ id, ...this.set });
    if (err) { this.status(err); return false; }
    this.id = id;
    this.dirty = false;
    this.render();
    this.status(`Saved “${this.set.name}”. Pick it under Units on the setup screen.`);
    return true;
  }

  private deleteSet() {
    if (!this.id) { this.status("This set isn't saved yet."); return; }
    if (!confirm(`Delete the unit set “${this.set.name}”? This can't be undone.`)) return;
    deleteUnitSet(this.id);
    this.load(standardSet('My units'), null, 'Deleted. Started a new set from the Standard units.');
  }

  private importFile() {
    if (!this.confirmDiscard()) return;
    pickUnitSetFile()
      .then(set => { this.load(set, null, `Imported “${set.name}”. Save it to keep it in this browser.`); this.dirty = true; })
      .catch((e: Error) => this.status(e.message));
  }

  private exportFile() {
    const problems = validateUnitSet(this.set);
    if (problems.length) { this.renderErrors(); this.status('Fix the problems shown in red before exporting.'); return; }
    exportUnitSetFile(this.set);
  }

  private resetUnit() {
    this.set.units[this.unit] = structuredClone(standardUnit(this.unit));
    for (const d of UNIT_ORDER) {
      this.set.damage[this.unit][d] = standardDamage(this.unit, d);
      this.set.damage[d][this.unit] = standardDamage(d, this.unit);
    }
    this.touch();
    this.render();
  }

  // ------------------------------------------------------------ editing

  private onFieldInput(el: HTMLInputElement) {
    const path = el.dataset.path;
    if (!path) return;
    const spec = fieldsFor(this.set.units[this.unit]).find(f => f.path === path);
    if (!spec) return;
    const def = this.set.units[this.unit];
    let value: unknown;
    // Flags are left out when off, except canCapture, which every unit spells out.
    if (spec.kind === 'bool') value = el.checked ? true : path === 'canCapture' ? false : undefined;
    else if (spec.kind === 'text' || spec.kind === 'moveType') value = el.value;
    else value = el.value.trim() === '' ? (spec.optional ? undefined : NaN) : Number(el.value);
    setField(def, path, value);
    this.markField(el.closest('.ue-field'), spec);
    if (path === 'name' || path === 'label') this.renderTitle();
    this.touch();
  }

  private onDamageInput(el: HTMLInputElement) {
    const a = el.dataset.a as UnitType | undefined;
    const d = el.dataset.d as UnitType | undefined;
    if (!a || !d) return;
    this.set.damage[a][d] = el.value.trim() === '' ? NaN : Number(el.value);
    const field = el.closest('.ue-field');
    field?.classList.toggle('changed', this.set.damage[a][d] !== standardDamage(a, d));
    field?.classList.toggle('bad', !Number.isInteger(this.set.damage[a][d]) || this.set.damage[a][d] < 0 || this.set.damage[a][d] > 200);
    this.touch();
  }

  private markField(el: Element | null, spec: FieldSpec) {
    if (!el) return;
    const norm = (v: unknown) => JSON.stringify(spec.kind === 'bool' ? !!v : v ?? null);
    el.classList.toggle('changed', norm(getField(this.set.units[this.unit], spec.path)) !== norm(getField(standardUnit(this.unit), spec.path)));
    const who = this.set.units[this.unit].name?.trim() || this.unit;
    el.classList.toggle('bad', validateUnitSet(this.set).some(p => p.startsWith(`${who}: ${spec.label}`)));
  }

  // ------------------------------------------------------------ drawing

  private render() {
    $<HTMLInputElement>('ue-name').value = this.set.name;
    $<HTMLSelectElement>('ue-open').innerHTML = '<option value="">Open set…</option>'
      + listUnitSets().map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    $<HTMLButtonElement>('ue-delete').disabled = !this.id;
    this.renderList();
    this.renderTitle();
    this.renderFields();
    this.renderDamage();
    this.renderErrors();
  }

  private unitChanged(t: UnitType) {
    if (JSON.stringify(this.set.units[t]) !== JSON.stringify(standardUnit(t))) return true;
    return UNIT_ORDER.some(d => this.set.damage[t][d] !== standardDamage(t, d) || this.set.damage[d][t] !== standardDamage(d, t));
  }

  private renderList() {
    $('ue-list').innerHTML = UNIT_ORDER.map(t => {
      const def = this.set.units[t];
      return `<button type="button" data-unit="${t}" class="${t === this.unit ? 'active' : ''}">
        <span class="tag">${escapeHtml(def.label)}</span>
        <span>${escapeHtml(def.name)} ${this.unitChanged(t) ? '<span class="dot" title="Changed from Standard">●</span>' : ''}</span>
        <span class="cost">${Number.isFinite(def.cost) ? def.cost.toLocaleString() : '?'}</span>
      </button>`;
    }).join('');
  }

  private renderTitle() {
    const def = this.set.units[this.unit];
    const std = standardUnit(this.unit);
    $('ue-title').textContent = def.name === std.name ? def.name : `${def.name} (was ${std.name})`;
  }

  private renderFields() {
    const def = this.set.units[this.unit];
    const specs = fieldsFor(def);
    $('ue-fields').innerHTML = SECTIONS.map(section => {
      const inSection = specs.filter(f => f.section === section);
      if (!inSection.length) return '';
      return `<h3>${section}</h3><div class="ue-grid">${inSection.map(f => this.fieldHtml(f)).join('')}</div>`;
    }).join('');
    $('ue-fields').querySelectorAll<HTMLElement>('.ue-field').forEach(el => {
      const spec = specs.find(f => f.path === el.dataset.field);
      if (spec) this.markField(el, spec);
    });
  }

  private fieldHtml(f: FieldSpec): string {
    const v = getField(this.set.units[this.unit], f.path);
    const attrs = `data-path="${escapeHtml(f.path)}"`;
    let input: string;
    if (f.kind === 'bool') {
      input = `<input type="checkbox" ${attrs} ${v ? 'checked' : ''} />`;
    } else if (f.kind === 'text') {
      input = `<input type="text" ${attrs} maxlength="${f.path === 'label' ? 3 : 20}" value="${escapeHtml(String(v ?? ''))}" />`;
    } else if (f.kind === 'moveType') {
      const choices = moveTypeChoices(standardUnit(this.unit).moveType);
      input = `<select ${attrs}>${choices.map(m => `<option value="${m}" ${m === v ? 'selected' : ''}>${MOVE_NAMES[m]}</option>`).join('')}</select>`;
    } else {
      const shown = typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
      input = `<input type="number" ${attrs} min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.step ?? (f.kind === 'int' ? 1 : 0.05)}" value="${shown}" ${f.optional ? 'placeholder="none"' : ''} />`;
    }
    return `<label class="ue-field" data-field="${escapeHtml(f.path)}"><span>${escapeHtml(f.label)}</span>${input}<p class="help meta">${escapeHtml(f.help)}</p></label>`;
  }

  private renderDamage() {
    const me = this.unit;
    const name = (t: UnitType) => escapeHtml(this.set.units[t].name);
    const cell = (a: UnitType, d: UnitType, label: string) => {
      const v = this.set.damage[a][d];
      const changed = v !== standardDamage(a, d) ? ' changed' : '';
      return `<label class="ue-field${changed}"><span>${label}</span><input type="number" min="0" max="200" step="5" data-a="${a}" data-d="${d}" value="${Number.isFinite(v) ? v : ''}" /></label>`;
    };
    $('ue-attack').innerHTML = UNIT_ORDER.map(d => cell(me, d, `vs ${name(d)}`)).join('');
    $('ue-defend').innerHTML = UNIT_ORDER.map(a => cell(a, me, `from ${name(a)}`)).join('');
  }

  private renderErrors() {
    const problems = validateUnitSet(this.set);
    const el = $('ue-errors');
    el.classList.toggle('hidden', !problems.length);
    el.innerHTML = problems.length
      ? `<b>${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before saving:</b><br>${problems.slice(0, 6).map(escapeHtml).join('<br>')}${problems.length > 6 ? '<br>…' : ''}`
      : '';
  }

  private status(text: string) {
    $('ue-status').textContent = text;
  }
}
